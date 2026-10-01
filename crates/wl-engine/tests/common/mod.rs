#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use wl_engine::{Config, Engine, Game, Prepared, Run, Scope};
use wl_strategy::StrategySpec;

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

pub fn list_dir(id: &str) -> PathBuf {
    repo_root().join("data/wordlists").join(id)
}

/// The frozen reference list with its matrix, shared across tests.
pub fn reference() -> Arc<Engine> {
    static ENGINE: OnceLock<Arc<Engine>> = OnceLock::new();
    ENGINE
        .get_or_init(|| Arc::new(Engine::new(wl_core::load_dir(&list_dir("ref-en-5")).expect("ref-en-5 loads"))))
        .clone()
}

pub fn config(engine: &Engine, strategy: StrategySpec, opener: Option<&str>, replicates: u32) -> Config {
    let mut c = Config::new(&engine.list, strategy);
    c.opener = opener.map(str::to_string);
    c.replicates = replicates;
    c
}

pub fn prepare(engine: &Engine, c: &Config) -> Prepared {
    engine.prepare(c).expect("config prepares")
}

/// Every game of a run.
pub fn run_all(engine: &Arc<Engine>, c: &Config, scope: &Scope) -> Vec<Game> {
    let mut run = Run::new(engine.clone(), prepare(engine, c), scope).expect("run starts");
    let games = run.run_to_end();
    assert!(run.is_done());
    games
}

/// Whether a spec builds on the reference list (other strategies may not be implemented yet).
pub fn builds(engine: &Engine, spec: &StrategySpec) -> bool {
    match spec.build(&engine.list) {
        Ok(_) => true,
        Err(e) => {
            eprintln!("skipping {}: {e}", spec.kind());
            false
        }
    }
}
