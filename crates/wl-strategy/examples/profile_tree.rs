// Temporary profiling helper (not shipped).
use std::time::Instant;
use wl_core::{PatternMatrix, WordId};
use wl_strategy::spec::Pool;
use wl_strategy::{Ctx, Rules, State, Strategy, StrategySpec};

fn tree(ctx: &Ctx, s: &dyn Strategy, state: &State, guess: Option<WordId>, stats: &mut Vec<(usize, f64)>) {
    let t0 = Instant::now();
    let guess = guess.unwrap_or_else(|| s.distribution(ctx, state).entries[0].word);
    stats.push((state.candidates.len(), t0.elapsed().as_secs_f64()));
    let turn = state.turn + 1;
    for (p, cands) in ctx.matrix.partition(&state.candidates, guess) {
        if !p.is_all_correct(5) && turn < 6 {
            let mut history = state.history.clone();
            history.push((guess, p));
            tree(ctx, s, &State { candidates: cands, turn, history }, None, stats);
        }
    }
}

fn main() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/wordlists/open-en-5");
    let list = wl_core::load_dir(&dir).unwrap();
    let m = PatternMatrix::build(&list);
    let ctx = Ctx::new(&list, &m, Rules::default());
    let s = StrategySpec::MaxInfo { pool: Pool::Allowed }.build(&list).unwrap();
    let mut stats = vec![];
    let t = Instant::now();
    tree(&ctx, &*s, &State::initial(&list), list.id("slate"), &mut stats);
    println!("total {:?}, nodes {}", t.elapsed(), stats.len());
    let buckets = [(1, 1), (2, 2), (3, 5), (6, 10), (11, 20), (21, 48), (49, 100), (101, 3000)];
    for (lo, hi) in buckets {
        let sel: Vec<_> = stats.iter().filter(|(n, _)| *n >= lo && *n <= hi).collect();
        let tt: f64 = sel.iter().map(|x| x.1).sum();
        println!("|C| {lo}-{hi}: {} nodes, {:.1} ms", sel.len(), tt * 1e3);
    }
}

#[allow(dead_code)]
fn unused() {}
