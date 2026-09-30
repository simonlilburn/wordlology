//! Runs: every game a configuration plays over a scope, in bounded steps.
//!
//! Deterministic strategies build the decision tree breadth-first, emitting
//! games as their leaves resolve (rows settle top-down). Stochastic strategies
//! play replicates interleaved over a seeded target order, memoising
//! distributions in a bounded cache. See docs/architecture.md.

use std::collections::VecDeque;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use wl_core::{expected_info, AnswerIdx, Pattern};
use wl_strategy::{Choice, State};

use crate::cache::DistCache;
use crate::game::{Game, Turn, PHASE_OPENER};
use crate::{Engine, EngineError, Prepared};

/// Which targets a scope plays.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub enum Targets {
    /// Every answer, in the seeded order.
    #[default]
    All,
    /// These answer indices, in the given order (duplicates dropped).
    List(Vec<AnswerIdx>),
    /// The first n answers of the seeded order.
    Sample(usize),
}

#[derive(Deserialize)]
#[serde(untagged)]
enum TargetsRepr {
    Word(String),
    List(Vec<AnswerIdx>),
    Sample { sample: usize },
}

impl<'de> Deserialize<'de> for Targets {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        match TargetsRepr::deserialize(d)? {
            TargetsRepr::Word(w) if w == "all" => Ok(Targets::All),
            TargetsRepr::Word(w) => Err(serde::de::Error::custom(format!("unknown targets {w:?}"))),
            TargetsRepr::List(v) => Ok(Targets::List(v)),
            TargetsRepr::Sample { sample } => Ok(Targets::Sample(sample)),
        }
    }
}

impl Serialize for Targets {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Targets::All => s.serialize_str("all"),
            Targets::List(v) => v.serialize(s),
            Targets::Sample(n) => {
                use serde::ser::SerializeMap;
                let mut m = s.serialize_map(Some(1))?;
                m.serialize_entry("sample", n)?;
                m.end()
            }
        }
    }
}

/// Which games of a configuration to play.
#[derive(Clone, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    #[serde(default)]
    pub targets: Targets,
    /// Half-open replicate range; defaults to `[0, R)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replicates: Option<[u32; 2]>,
}

impl Scope {
    pub fn all() -> Scope {
        Scope::default()
    }

    pub fn targets(list: Vec<AnswerIdx>) -> Scope {
        Scope { targets: Targets::List(list), replicates: None }
    }

    pub fn from_json(json: &str) -> Result<Scope, EngineError> {
        serde_json::from_str(json).map_err(|e| EngineError::Scope(format!("bad scope: {e}")))
    }
}

/// Progress of a run (the `ProgressEvent` fields).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// Games finished so far.
    pub done: u64,
    /// Games the run plays in total.
    pub total: u64,
    /// Targets whose games in the replicate range are all finished.
    pub targets_done: usize,
    pub targets_total: usize,
    /// Deterministic runs: every game ending at or before this guess is final.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settled_depth: Option<u8>,
    /// Deterministic runs: games still unresolved.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unresolved: Option<u64>,
}

/// Summary of a run (the `SummaryEvent` fields).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub config_id: String,
    pub n_games: u64,
    /// Time spent inside `step` calls.
    pub elapsed_ms: f64,
    pub phases: Vec<String>,
    pub deterministic: bool,
}

/// Milliseconds on a monotonic clock (native builds).
#[cfg(not(target_arch = "wasm32"))]
pub fn default_clock() -> f64 {
    use std::sync::OnceLock;
    use std::time::Instant;
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

/// WASM builds have no `Instant`; wl-wasm installs a JavaScript clock.
#[cfg(target_arch = "wasm32")]
pub fn default_clock() -> f64 {
    0.0
}

/// A node of a deterministic decision tree still to be expanded.
struct Node {
    state: State,
    turns: Vec<Turn>,
    /// Scope targets consistent with this node, in answer order.
    targets: Vec<AnswerIdx>,
}

enum Work {
    Tree(VecDeque<Node>),
    Sampled { order: Vec<AnswerIdx>, reps: [u32; 2], rep: u32, pos: usize, cache: DistCache },
    Finished,
}

/// A (configuration, scope) job.
pub struct Run {
    engine: Arc<Engine>,
    prep: Prepared,
    work: Work,
    targets_total: usize,
    total: u64,
    done: u64,
    elapsed_ms: f64,
    cancelled: bool,
    clock: fn() -> f64,
    scratch: Vec<u32>,
}

impl Run {
    /// A run of `prep` over `scope`. Deterministic strategies ignore any
    /// replicate range beyond `[0, 1)`.
    pub fn new(engine: Arc<Engine>, prep: Prepared, scope: &Scope) -> Result<Run, EngineError> {
        let n = engine.list.n_answers();
        let targets: Vec<AnswerIdx> = match &scope.targets {
            Targets::All => prep.target_order(n),
            Targets::Sample(k) => {
                let mut order = prep.target_order(n);
                order.truncate((*k).min(n));
                order
            }
            Targets::List(list) => {
                let mut seen = vec![false; n];
                let mut out = Vec::with_capacity(list.len());
                for &t in list {
                    if t as usize >= n {
                        return Err(EngineError::Scope(format!("target {t} is not an answer index (0 to {})", n - 1)));
                    }
                    if !std::mem::replace(&mut seen[t as usize], true) {
                        out.push(t);
                    }
                }
                out
            }
        };
        let r = prep.config.replicates;
        let reps = if prep.deterministic {
            let [a, b] = scope.replicates.unwrap_or([0, 1]);
            if a < b.min(1) { [0, 1] } else { [0, 0] }
        } else {
            let reps = scope.replicates.unwrap_or([0, r]);
            if reps[0] > reps[1] || reps[1] > r {
                return Err(EngineError::Scope(format!(
                    "replicate range [{}, {}) must lie within [0, {r})",
                    reps[0], reps[1]
                )));
            }
            reps
        };
        let n_reps = (reps[1] - reps[0]) as u64;
        let targets_total = targets.len();
        let total = targets_total as u64 * n_reps;
        let work = if total == 0 {
            Work::Finished
        } else if prep.deterministic {
            let mut sorted = targets;
            sorted.sort_unstable();
            let root = Node { state: State::initial(&engine.list), turns: Vec::new(), targets: sorted };
            Work::Tree(VecDeque::from([root]))
        } else {
            Work::Sampled { order: targets, reps, rep: reps[0], pos: 0, cache: DistCache::default() }
        };
        let scratch = vec![0; engine.matrix.n_patterns()];
        Ok(Run {
            engine,
            prep,
            work,
            targets_total,
            total,
            done: 0,
            elapsed_ms: 0.0,
            cancelled: false,
            clock: default_clock,
            scratch,
        })
    }

    /// Use another clock (milliseconds) for budgets and elapsed time.
    pub fn with_clock(mut self, clock: fn() -> f64) -> Run {
        self.clock = clock;
        self
    }

    pub fn prepared(&self) -> &Prepared {
        &self.prep
    }

    pub fn engine(&self) -> &Arc<Engine> {
        &self.engine
    }

    /// Play for about `budget_ms` milliseconds (at least one unit of work:
    /// one game, or one node of a deterministic tree) and return the games
    /// finished in that time.
    pub fn step(&mut self, budget_ms: f64) -> Vec<Game> {
        let clock = self.clock;
        let start = clock();
        self.step_with(|_| clock() - start >= budget_ms)
    }

    /// Do at most `units` units of work (at least one).
    pub fn step_units(&mut self, units: usize) -> Vec<Game> {
        self.step_with(|n| n >= units)
    }

    /// Play everything that is left.
    pub fn run_to_end(&mut self) -> Vec<Game> {
        self.step_with(|_| false)
    }

    /// Do units of work until `stop(units_done)` says so or the run ends.
    pub fn step_with(&mut self, mut stop: impl FnMut(usize) -> bool) -> Vec<Game> {
        let t0 = (self.clock)();
        let mut out = Vec::new();
        let mut units = 0;
        while !self.is_done() {
            self.unit(&mut out);
            units += 1;
            if stop(units) {
                break;
            }
        }
        self.done += out.len() as u64;
        if self.done >= self.total {
            self.work = Work::Finished;
        }
        self.elapsed_ms += (self.clock)() - t0;
        out
    }

    /// One unit of work.
    fn unit(&mut self, out: &mut Vec<Game>) {
        match &mut self.work {
            Work::Finished => {}
            Work::Tree(queue) => {
                if let Some(node) = queue.pop_front() {
                    let children = expand(&self.engine, &self.prep, node, &mut self.scratch, out);
                    queue.extend(children);
                }
                if queue.is_empty() {
                    self.work = Work::Finished;
                }
            }
            Work::Sampled { order, reps, rep, pos, cache } => {
                out.push(self.prep.play(&self.engine, order[*pos], *rep, Some(cache)));
                *pos += 1;
                if *pos == order.len() {
                    *pos = 0;
                    *rep += 1;
                    if *rep >= reps[1] {
                        self.work = Work::Finished;
                    }
                }
            }
        }
    }

    pub fn is_done(&self) -> bool {
        matches!(self.work, Work::Finished)
    }

    /// Distribution cache (hits, misses, entries held) of a stochastic run
    /// that is still going; `None` otherwise.
    pub fn cache_stats(&self) -> Option<(u64, u64, usize)> {
        match &self.work {
            Work::Sampled { cache, .. } => {
                let (h, m) = cache.stats();
                Some((h, m, cache.len()))
            }
            _ => None,
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled
    }

    /// Stop the run; it reports done and frees its working memory.
    pub fn cancel(&mut self) {
        self.cancelled = true;
        self.work = Work::Finished;
    }

    pub fn progress(&self) -> Progress {
        let targets_done = match &self.work {
            Work::Finished if !self.cancelled => self.targets_total,
            Work::Sampled { reps, rep, pos, .. } if *rep + 1 == reps[1] => *pos,
            Work::Sampled { .. } => 0,
            // Deterministic: one game per target.
            _ => self.done as usize,
        };
        let (settled_depth, unresolved) = if self.prep.deterministic {
            let max = self.prep.config.rules.max_guesses;
            let settled = match &self.work {
                Work::Tree(q) => q.front().map_or(max, |n| n.state.turn),
                _ if self.cancelled => 0,
                _ => max,
            };
            (Some(settled), Some(self.total - self.done))
        } else {
            (None, None)
        };
        Progress {
            done: self.done,
            total: self.total,
            targets_done,
            targets_total: self.targets_total,
            settled_depth,
            unresolved,
        }
    }

    pub fn summary(&self) -> Summary {
        Summary {
            config_id: self.prep.config_id.clone(),
            n_games: self.done,
            elapsed_ms: self.elapsed_ms,
            phases: self.prep.phases.clone(),
            deterministic: self.prep.deterministic,
        }
    }
}

/// Expand one decision-tree node: choose its guess, emit the games that end
/// here (solved, or failed at max guesses) and return the children that
/// still hold scope targets, in pattern order.
fn expand(engine: &Engine, prep: &Prepared, node: Node, scratch: &mut [u32], out: &mut Vec<Game>) -> Vec<Node> {
    let ctx = prep.ctx(engine);
    let state = &node.state;
    let choice = match prep.opener {
        Some(o) if state.turn == 0 => Choice { word: o, p: 1.0, phase: PHASE_OPENER },
        _ => {
            let d = prep.strategy.distribution(&ctx, state);
            debug_assert_eq!(d.entries.len(), 1, "deterministic strategies return one entry");
            match d.entries.as_slice() {
                [e] => Choice { word: e.word, p: d.prob_of(e.word), phase: e.phase },
                _ => d.mode(),
            }
        }
    };
    let guess = choice.word;
    let bits = expected_info(&engine.matrix, guess, &state.candidates, scratch);
    let template = Turn {
        guess,
        pattern: 0,
        cands_before: state.candidates.len() as u16,
        cands_after: 0,
        p_chosen: choice.p as f32,
        bits_expected: bits as f32,
        phase: choice.phase,
        is_candidate: ctx.is_candidate(state, guess),
    };
    let depth = state.turn + 1;
    let at_max = depth >= prep.config.rules.max_guesses;
    let solved_code = Pattern::all_correct(engine.list.word_len()).0;
    let row = engine.matrix.row(guess);
    let mut by_pattern: Vec<(u16, AnswerIdx)> = node.targets.iter().map(|&t| (row.get(t).0, t)).collect();
    by_pattern.sort_unstable();
    let mut children = Vec::new();
    let mut i = 0;
    while i < by_pattern.len() {
        let code = by_pattern[i].0;
        let j = i + by_pattern[i..].iter().take_while(|(c, _)| *c == code).count();
        let turn = Turn { pattern: code, cands_after: scratch[code as usize] as u16, ..template };
        let group = by_pattern[i..j].iter().map(|&(_, t)| t);
        if code == solved_code || at_max {
            for t in group {
                let mut turns = node.turns.clone();
                turns.push(turn);
                out.push(Game { target: t, replicate: 0, turns, solved: code == solved_code, is_player: false });
            }
        } else {
            let mut turns = node.turns.clone();
            turns.push(turn);
            children.push(Node { state: state.apply(&ctx, guess, Pattern(code)), turns, targets: group.collect() });
        }
        i = j;
    }
    children
}
