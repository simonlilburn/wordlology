//! max_info, the hot path: one decision at the root, one after an opener, and
//! a whole deterministic card (the decision tree over every answer), for both
//! pools on open-en-5.
//!
//! Run with `cargo bench -p wl-strategy`. The spec's target is a deterministic
//! max_info card over all 2,500 answers in at most 2 s in a desktop browser.

use criterion::{criterion_group, criterion_main, Criterion};
use wl_core::{PatternMatrix, WordId, WordList};
use wl_strategy::spec::Pool;
use wl_strategy::{Ctx, Rules, State, Strategy, StrategySpec};

fn load() -> WordList {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/wordlists/open-en-5");
    wl_core::load_dir(&dir).expect("word list")
}

/// The state after `opener`, with the feedback that leaves the most candidates.
fn after_opener(ctx: &Ctx, opener: &str) -> State {
    let root = State::initial(ctx.list);
    let g = ctx.list.id(opener).expect("opener");
    let (pattern, _) = ctx
        .matrix
        .partition(&root.candidates, g)
        .into_iter()
        .max_by_key(|(p, s)| (s.len(), std::cmp::Reverse(p.0)))
        .expect("non-empty");
    root.apply(ctx, g, pattern)
}

/// Build the decision tree below `state` as the engine does for a
/// deterministic strategy (`guess` forced at this node if given); returns
/// the total number of guesses over its targets, failures counting
/// `max_guesses + 1`.
fn tree(ctx: &Ctx, s: &dyn Strategy, state: &State, guess: Option<WordId>) -> u64 {
    let guess = guess.unwrap_or_else(|| s.distribution(ctx, state).entries[0].word);
    let turn = state.turn + 1;
    let mut total = 0;
    for (p, cands) in ctx.matrix.partition(&state.candidates, guess) {
        if p.is_all_correct(ctx.list.word_len()) {
            total += turn as u64;
        } else if turn >= ctx.rules.max_guesses {
            total += cands.len() as u64 * (turn as u64 + 1);
        } else {
            let mut history = state.history.clone();
            history.push((guess, p));
            total += tree(ctx, s, &State { candidates: cands, turn, history }, None);
        }
    }
    total
}

fn benches(c: &mut Criterion) {
    let list = load();
    let matrix = PatternMatrix::build(&list);
    let ctx = Ctx::new(&list, &matrix, Rules::default());
    let root = State::initial(&list);
    let slate = after_opener(&ctx, "slate");
    let opener = list.id("slate");

    let mut g = c.benchmark_group("max_info");
    g.sample_size(10);
    for (name, pool) in [("candidates", Pool::Candidates), ("allowed", Pool::Allowed)] {
        let s = StrategySpec::MaxInfo { pool }.build(&list).unwrap();
        g.bench_function(format!("root/{name}"), |b| b.iter(|| s.distribution(&ctx, &root)));
        g.bench_function(format!("after slate/{name}"), |b| b.iter(|| s.distribution(&ctx, &slate)));
        g.bench_function(format!("card with slate/{name}"), |b| b.iter(|| tree(&ctx, &*s, &root, opener)));
        g.bench_function(format!("card/{name}"), |b| b.iter(|| tree(&ctx, &*s, &root, None)));
    }
    g.finish();
}

criterion_group!(max_info, benches);
criterion_main!(max_info);
