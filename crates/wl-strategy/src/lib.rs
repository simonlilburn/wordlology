//! wl-strategy: the `Strategy` trait, the catalogue, combinators, the
//! `StrategySpec` enum and parameter schemas.
//!
//! A strategy maps a game state to a probability distribution over guesses; a
//! deterministic strategy puts all its mass on one word.

use rand::RngCore;
use serde::{Deserialize, Serialize};
use wl_core::{hard_mode_ok, CandidateSet, Pattern, PatternMatrix, WordId, WordList};

pub mod catalogue;
pub mod schema;
pub mod spec;
pub mod strategies;

pub use schema::{ParamField, ParamSchema, ParamType};
pub use spec::{Pool, StrategySpec, SwitchRule};

/// Game rules. Word length comes from the word list.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rules {
    pub max_guesses: u8,
    pub hard_mode: bool,
}

impl Default for Rules {
    fn default() -> Self {
        Rules { max_guesses: 6, hard_mode: false }
    }
}

/// Everything a strategy may read that does not change during a game.
pub struct Ctx<'a> {
    pub list: &'a WordList,
    pub matrix: &'a PatternMatrix,
    pub rules: Rules,
}

impl<'a> Ctx<'a> {
    pub fn new(list: &'a WordList, matrix: &'a PatternMatrix, rules: Rules) -> Ctx<'a> {
        Ctx { list, matrix, rules }
    }

    /// Scratch buffer sized for partition counts.
    pub fn scratch(&self) -> Vec<u32> {
        vec![0; self.matrix.n_patterns()]
    }

    /// Guess ids of the candidates, in increasing order.
    pub fn candidate_words(&self, state: &State) -> Vec<WordId> {
        state.candidates.iter().map(|a| self.list.answer_word(a)).collect()
    }

    /// The allowed guess pool for this state: every guess, narrowed to
    /// hard-mode-compliant guesses when the rules ask for hard mode.
    pub fn allowed_words(&self, state: &State) -> Vec<WordId> {
        let n = self.list.n_guesses() as WordId;
        if self.rules.hard_mode && !state.history.is_empty() {
            (0..n).filter(|&g| hard_mode_ok(self.list, g, &state.history)).collect()
        } else {
            (0..n).collect()
        }
    }

    /// Guesses in a pool. Candidates always satisfy hard mode, so no filter is needed there.
    pub fn pool_words(&self, state: &State, pool: Pool) -> Vec<WordId> {
        match pool {
            Pool::Candidates => self.candidate_words(state),
            Pool::Allowed => self.allowed_words(state),
        }
    }

    /// Whether a guess id is among the current candidates.
    #[inline]
    pub fn is_candidate(&self, state: &State, g: WordId) -> bool {
        self.list.answer_idx(g).is_some_and(|a| state.candidates.contains(a))
    }
}

/// A game state: the candidate set, the number of guesses made so far, and
/// the history of guesses with their feedback.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct State {
    pub candidates: CandidateSet,
    /// Guesses made so far; the next guess is number `turn + 1`.
    pub turn: u8,
    pub history: Vec<(WordId, Pattern)>,
}

impl State {
    pub fn initial(list: &WordList) -> State {
        State { candidates: CandidateSet::full(list.n_answers()), turn: 0, history: Vec::new() }
    }

    /// The state after playing `guess` and seeing `pattern`.
    pub fn apply(&self, ctx: &Ctx, guess: WordId, pattern: Pattern) -> State {
        let mut history = self.history.clone();
        history.push((guess, pattern));
        State { candidates: ctx.matrix.refine(&self.candidates, guess, pattern), turn: self.turn + 1, history }
    }
}

/// Memoisation key: states with equal keys must receive equal distributions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct StateKey(pub u64, pub u64);

impl StateKey {
    /// Key on the candidate set alone.
    pub fn candidates(state: &State) -> StateKey {
        StateKey(state.candidates.hash64(), state.candidates.len() as u64)
    }

    /// Key on the candidate set and the turn number.
    pub fn candidates_turn(state: &State) -> StateKey {
        StateKey(state.candidates.hash64(), ((state.turn as u64) << 32) | state.candidates.len() as u64)
    }

    /// Key on the full history (for strategies whose choice depends on it,
    /// such as hard mode over the allowed pool).
    pub fn history(state: &State) -> StateKey {
        let mut h: u64 = 0x9e37_79b9_7f4a_7c15;
        for &(g, p) in &state.history {
            h ^= ((g as u64) << 16) | p.0 as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3).rotate_left(23);
        }
        StateKey(state.candidates.hash64() ^ h, ((state.turn as u64) << 32) | state.candidates.len() as u64)
    }

    /// Mix another value into the key (for combinators).
    pub fn mix(self, tag: u64) -> StateKey {
        StateKey(self.0.rotate_left(17) ^ tag.wrapping_mul(0x9e37_79b9_7f4a_7c15), self.1 ^ tag)
    }
}

/// One entry of a guess distribution: a word, its probability, and which
/// phase of a hybrid (an index into [`Strategy::phases`]) would choose it.
/// A word may appear more than once with different phases (mixtures).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DistEntry {
    pub word: WordId,
    pub p: f64,
    pub phase: u8,
}

/// A distribution over guess ids. Probabilities sum to 1.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Dist {
    pub entries: Vec<DistEntry>,
}

/// A sampled guess.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Choice {
    pub word: WordId,
    /// Total probability the strategy gave this word.
    pub p: f64,
    pub phase: u8,
}

impl Dist {
    /// A point mass.
    pub fn single(word: WordId, phase: u8) -> Dist {
        Dist { entries: vec![DistEntry { word, p: 1.0, phase }] }
    }

    /// Normalise non-negative weights into a distribution. Zero total weight
    /// falls back to uniform. Entries keep their order.
    pub fn from_weights(words: &[WordId], weights: &[f64], phase: u8) -> Dist {
        debug_assert_eq!(words.len(), weights.len());
        let total: f64 = weights.iter().sum();
        let entries = if total > 0.0 && total.is_finite() {
            words.iter().zip(weights).map(|(&w, &x)| DistEntry { word: w, p: x / total, phase }).collect()
        } else {
            let p = 1.0 / words.len() as f64;
            words.iter().map(|&w| DistEntry { word: w, p, phase }).collect()
        };
        Dist { entries }
    }

    pub fn is_deterministic(&self) -> bool {
        self.entries.len() == 1
    }

    /// Total probability of a word.
    pub fn prob_of(&self, word: WordId) -> f64 {
        self.entries.iter().filter(|e| e.word == word).map(|e| e.p).sum()
    }

    /// Draw one entry. Uses one `next_u64` draw so streams stay aligned
    /// across builds; a single-entry distribution draws nothing.
    pub fn sample(&self, rng: &mut dyn RngCore) -> Choice {
        let e = if self.entries.len() == 1 {
            self.entries[0]
        } else {
            // 53 random bits -> uniform in [0, 1).
            let u = (rng.next_u64() >> 11) as f64 * (1.0 / (1u64 << 53) as f64);
            let mut acc = 0.0;
            let mut chosen = *self.entries.last().expect("empty distribution");
            for e in &self.entries {
                acc += e.p;
                if u < acc {
                    chosen = *e;
                    break;
                }
            }
            chosen
        };
        Choice { word: e.word, p: self.prob_of(e.word), phase: e.phase }
    }

    /// The most probable word (ties toward the earlier entry).
    pub fn mode(&self) -> Choice {
        let mut best: Option<(WordId, f64)> = None;
        for e in &self.entries {
            let p = self.prob_of(e.word);
            if best.is_none_or(|(_, bp)| p > bp) {
                best = Some((e.word, p));
            }
        }
        let (word, p) = best.expect("empty distribution");
        let phase = self.entries.iter().find(|e| e.word == word).map_or(0, |e| e.phase);
        Choice { word, p, phase }
    }

    /// Scale every probability by `w` and shift phases by `offset` (for combinators).
    pub fn scaled(mut self, w: f64, offset: u8) -> Dist {
        for e in &mut self.entries {
            e.p *= w;
            e.phase += offset;
        }
        self
    }
}

/// Word-list resources a strategy needs.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Resources {
    pub frequencies: bool,
}

/// A strategy. See docs/architecture.md for the contract.
pub trait Strategy: Send + Sync {
    /// Short identifier, e.g. `max_info`.
    fn id(&self) -> &str;
    fn is_deterministic(&self) -> bool;
    /// Distribution over guess ids for this state; deterministic strategies return one entry.
    fn distribution(&self, ctx: &Ctx, state: &State) -> Dist;
    /// Memoisation key: states with equal keys must receive equal distributions.
    fn state_key(&self, state: &State) -> StateKey;
    /// Ranked alternatives with scores, for annotations and hint chips.
    fn scores(&self, ctx: &Ctx, state: &State, top_k: usize) -> Vec<(WordId, f64)>;
    /// Parameter schema that drives the Strategy Lab form.
    fn schema() -> ParamSchema
    where
        Self: Sized;
    /// Labels of the phases a hybrid can report; plain strategies have one.
    fn phases(&self) -> Vec<String> {
        vec![self.id().to_string()]
    }
    /// Resources the strategy needs from the word list.
    fn resources(&self) -> Resources {
        Resources::default()
    }
}

/// Deterministic argmax over scored words: highest score, then words in C,
/// then the lower word id. Scores are compared exactly.
pub fn argmax_tiebreak(ctx: &Ctx, state: &State, scored: impl Iterator<Item = (WordId, f64)>) -> Option<WordId> {
    let mut best: Option<(WordId, f64, bool)> = None;
    for (w, s) in scored {
        let in_c = ctx.is_candidate(state, w);
        let better = match best {
            None => true,
            Some((bw, bs, bin)) => s > bs || (s == bs && ((in_c && !bin) || (in_c == bin && w < bw))),
        };
        if better {
            best = Some((w, s, in_c));
        }
    }
    best.map(|b| b.0)
}

/// Sort scored words for display: highest score first, then candidates, then word id.
pub fn rank_scores(ctx: &Ctx, state: &State, mut scored: Vec<(WordId, f64)>, top_k: usize) -> Vec<(WordId, f64)> {
    scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| ctx.is_candidate(state, b.0).cmp(&ctx.is_candidate(state, a.0)))
            .then_with(|| a.0.cmp(&b.0))
    });
    scored.truncate(top_k);
    scored
}
