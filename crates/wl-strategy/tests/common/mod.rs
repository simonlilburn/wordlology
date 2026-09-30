//! Shared helpers for the wl-strategy integration tests.
#![allow(dead_code)]

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use wl_core::{hard_mode_ok, AnswerIdx, Manifest, PatternMatrix, WordId, WordList};
use wl_strategy::{Choice, Ctx, Dist, Rules, State, Strategy, StrategySpec};

/// The frozen reference list (1,500 guesses, 300 answers, with frequencies).
pub fn reference() -> WordList {
    load("ref-en-5")
}

pub fn load(id: &str) -> WordList {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/wordlists").join(id);
    wl_core::load_dir(&dir).expect("word list")
}

/// A hand-built list; `guesses` must include `answers`.
pub fn adhoc(guesses: &[&str], answers: &[&str]) -> WordList {
    let mut g: Vec<&str> = guesses.to_vec();
    g.sort_unstable();
    let mut a: Vec<&str> = answers.to_vec();
    a.sort_unstable();
    WordList::from_words(Manifest::adhoc("adhoc", 5), &g, &a).expect("valid list")
}

pub fn spec(json: &str) -> StrategySpec {
    StrategySpec::from_json(json).unwrap_or_else(|e| panic!("{json}: {e}"))
}

pub fn build(json: &str, list: &WordList) -> Box<dyn Strategy> {
    spec(json).build(list).unwrap_or_else(|e| panic!("{json}: {e}"))
}

pub fn rules(hard_mode: bool) -> Rules {
    Rules { max_guesses: 6, hard_mode }
}

/// The state after playing `words` against `target`.
pub fn state_after(ctx: &Ctx, target: &str, words: &[&str]) -> State {
    let t = ctx.list.answer_of_word(target).expect("target is an answer");
    let mut s = State::initial(ctx.list);
    for w in words {
        let g = ctx.list.id(w).unwrap_or_else(|| panic!("{w} is not a guess"));
        s = s.apply(ctx, g, ctx.matrix.get(g, t));
    }
    s
}

/// Check the contract of one distribution: non-empty, probabilities in
/// [0, 1] summing to 1, phases indexing `phases()`, valid words, hard mode
/// respected, and a single entry for deterministic strategies.
pub fn check_dist(ctx: &Ctx, s: &dyn Strategy, state: &State, d: &Dist) {
    assert!(!d.entries.is_empty(), "empty distribution");
    let sum: f64 = d.entries.iter().map(|e| e.p).sum();
    assert!((sum - 1.0).abs() < 1e-9, "{} sums to {sum}", s.id());
    let n_phases = s.phases().len();
    for e in &d.entries {
        assert!(e.p >= 0.0 && e.p <= 1.0 + 1e-12, "p = {}", e.p);
        assert!((e.phase as usize) < n_phases, "phase {} of {:?}", e.phase, s.phases());
        assert!((e.word as usize) < ctx.list.n_guesses());
        if ctx.rules.hard_mode {
            assert!(
                hard_mode_ok(ctx.list, e.word, &state.history),
                "{} offers {} against hard mode",
                s.id(),
                ctx.list.word(e.word)
            );
        }
    }
    if s.is_deterministic() {
        assert_eq!(d.entries.len(), 1, "{} is deterministic", s.id());
        assert_eq!(d.entries[0].p, 1.0);
    }
}

/// One played turn.
pub struct Turn {
    pub state: State,
    pub choice: Choice,
    pub dist: Dist,
}

/// Play one game, checking every distribution. Returns the turns and whether it was solved.
pub fn play(ctx: &Ctx, s: &dyn Strategy, target: AnswerIdx, rng: &mut ChaCha8Rng) -> (Vec<Turn>, bool) {
    let mut state = State::initial(ctx.list);
    let mut turns = Vec::new();
    let len = ctx.list.word_len();
    while (state.turn) < ctx.rules.max_guesses {
        let d = s.distribution(ctx, &state);
        check_dist(ctx, s, &state, &d);
        let choice = d.sample(rng);
        assert!((choice.p - d.prob_of(choice.word)).abs() < 1e-15);
        assert!(choice.p > 0.0, "sampled a zero-probability word");
        let pattern = ctx.matrix.get(choice.word, target);
        let next = state.apply(ctx, choice.word, pattern);
        assert!(next.candidates.contains(target));
        turns.push(Turn { state, choice, dist: d });
        state = next;
        if pattern.is_all_correct(len) {
            return (turns, true);
        }
    }
    (turns, false)
}

pub fn rng(seed: u64) -> ChaCha8Rng {
    ChaCha8Rng::seed_from_u64(seed)
}

/// `n` distinct answer indices drawn from the list.
pub fn sample_targets(list: &WordList, n: usize, rng: &mut ChaCha8Rng) -> Vec<AnswerIdx> {
    let mut all: Vec<AnswerIdx> = (0..list.n_answers() as AnswerIdx).collect();
    for i in 0..n.min(all.len()) {
        let j = rng.gen_range(i..all.len());
        all.swap(i, j);
    }
    all.truncate(n);
    all
}

pub fn matrix(list: &WordList) -> PatternMatrix {
    PatternMatrix::build(list)
}

pub fn ids(list: &WordList, words: &[&str]) -> Vec<WordId> {
    words.iter().map(|w| list.id(w).unwrap()).collect()
}
