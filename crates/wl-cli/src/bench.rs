//! `wordlology bench`: the specification's performance targets, measured natively.
//!
//! Every measurement starts from a fresh run (an empty distribution cache),
//! as the browser does. Targets are the desktop targets for the browser, so
//! native times should sit comfortably below them.

use std::sync::Arc;
use std::time::Instant;

use wl_core::PatternMatrix;
use wl_engine::{Config, Engine, Run, Scope};
use wl_strategy::{Pool, StrategySpec};

use crate::args::Args;
use crate::setup::{self, ListDir, Result};

struct Row {
    measure: String,
    target_ms: f64,
    ms: f64,
    note: String,
}

fn time<T>(f: impl FnOnce() -> T) -> (T, f64) {
    let t = Instant::now();
    let x = f();
    (x, t.elapsed().as_secs_f64() * 1000.0)
}

/// Run a configuration over a scope; returns (games, milliseconds).
fn run(engine: &Arc<Engine>, config: &Config, scope: &Scope) -> Result<(usize, f64)> {
    let prep = setup::prepare(engine, config)?;
    let mut run = Run::new(engine.clone(), prep, scope).map_err(|e| e.to_string())?;
    let (games, ms) = time(|| run.run_to_end());
    Ok((games.len(), ms))
}

pub fn bench(args: &Args) -> Result<()> {
    let dir = args.get("list").map_or_else(|| setup::repo_root().join("data/wordlists/open-en-5"), Into::into);
    let list = ListDir::load(&dir)?.base;
    let (ng, na) = (list.n_guesses(), list.n_answers());
    let mut rows = Vec::new();

    let (matrix, ms) = time(|| PatternMatrix::build(&list));
    rows.push(Row {
        measure: format!("pattern matrix build ({ng} x {na})"),
        target_ms: 500.0,
        ms,
        note: String::new(),
    });
    let engine = Arc::new(Engine::with_matrix(list, matrix));
    let opener = args.get("opener").unwrap_or("crane").to_string();
    let config = |spec: StrategySpec, opener: Option<&str>, r: u32| {
        let mut c = Config::new(&engine.list, spec);
        c.opener = opener.map(str::to_string);
        c.replicates = r;
        c
    };

    for (pool, name) in [(Pool::Candidates, "candidates"), (Pool::Allowed, "allowed")] {
        for op in [None, Some(opener.as_str())] {
            let c = config(StrategySpec::MaxInfo { pool }, op, 1);
            let (n, ms) = run(&engine, &c, &Scope::all())?;
            rows.push(Row {
                measure: format!("deterministic max_info card, pool {name}, opener {}", op.unwrap_or("none")),
                target_ms: 2000.0,
                ms,
                note: format!("{n} games"),
            });
        }
    }

    // Stochastic trees: the default arrival strategy with the player's opener,
    // over several targets of the seeded order (median and worst).
    let arrival = || StrategySpec::InfoProportional { beta: 1.0, pool: Pool::Candidates };
    let tree_cfg = config(arrival(), Some(&opener), 200);
    let order = setup::prepare(&engine, &tree_cfg)?.target_order(na);
    let mut times = Vec::new();
    for &t in order.iter().take(9) {
        times.push(run(&engine, &tree_cfg, &Scope::targets(vec![t]))?.1);
    }
    times.sort_by(f64::total_cmp);
    rows.push(Row {
        measure: format!("stochastic tree, one target, R = 200, opener {opener}"),
        target_ms: 1000.0,
        ms: times[times.len() / 2],
        note: format!("median of {}; worst {:.0} ms", times.len(), times[times.len() - 1]),
    });

    if !args.flag("quick") {
        for op in [Some(opener.as_str()), None] {
            let c = config(arrival(), op, 20);
            let (n, ms) = run(&engine, &c, &Scope::all())?;
            rows.push(Row {
                measure: format!("stochastic card, R = 20, opener {}", op.unwrap_or("none")),
                target_ms: 10_000.0,
                ms,
                note: format!("{n} games"),
            });
        }
    }

    println!("{:<62} {:>10} {:>10}  status", "measure", "target", "native");
    for r in &rows {
        let status = if r.ms <= r.target_ms { "ok" } else { "SLOW" };
        println!("{:<62} {:>7.0} ms {:>7.0} ms  {status}  {}", r.measure, r.target_ms, r.ms, r.note);
    }
    Ok(())
}
