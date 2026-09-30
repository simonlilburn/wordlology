// Temporary profiling helper (not committed).
use std::sync::Arc;
use std::time::Instant;
use wl_engine::{Config, Engine, Run, Scope};
use wl_strategy::{Pool, StrategySpec};

fn main() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/wordlists/open-en-5");
    let e = Arc::new(Engine::new(wl_core::load_dir(&dir).unwrap()));
    let opener = std::env::args().nth(1).filter(|o| o != "none");
    let mut c = Config::new(&e.list, StrategySpec::InfoProportional { beta: 1.0, pool: Pool::Candidates });
    c.opener = opener;
    c.replicates = 20;
    let prep = e.prepare(&c).unwrap();
    let mut run = Run::new(e.clone(), prep, &Scope::all()).unwrap();
    let t = Instant::now();
    let mut n = 0;
    let mut turns = 0;
    let mut last = 0.0;
    while !run.is_done() {
        let stats = run.cache_stats();
        let g = run.step_units(2500);
        n += g.len();
        turns += g.iter().map(|g| g.turns.len()).sum::<usize>();
        let el = t.elapsed().as_secs_f64();
        println!("{n} games {turns} turns {:.2}s (+{:.2}) cache {:?}", el, el - last, stats);
        last = el;
    }
}
