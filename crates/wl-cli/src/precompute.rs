//! `wordlology precompute`: results shipped with the web app (StaticBackend).
//!
//! Writes `index.json` and one file of concatenated binary batches per
//! entry. Only deterministic cards are shipped (one game per target, so the
//! files stay small). The output is reproducible: no timings or dates.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};
use wl_core::SOLVER_VERSION;
use wl_engine::batch::encode_batches;
use wl_engine::{Config, Engine, Run, Scope};
use wl_strategy::{Pool, StrategySpec};

use crate::args::Args;
use crate::setup::{self, ListDir, Result};

/// Openers shipped for every strategy (those in the guess list).
pub const OPENERS: &[Option<&str>] = &[None, Some("crane"), Some("slate"), Some("trace"), Some("raise"), Some("adieu")];

/// Strategies shipped (those that build on the list).
fn strategies() -> Vec<StrategySpec> {
    vec![
        StrategySpec::MaxInfo { pool: Pool::Candidates },
        StrategySpec::MaxInfo { pool: Pool::Allowed },
        StrategySpec::MostFrequent {},
    ]
}

pub fn precompute(args: &Args) -> Result<()> {
    let out = PathBuf::from(args.get("out").unwrap_or("precomputed"));
    let dir = args.get("list").map_or_else(|| setup::repo_root().join("data/wordlists/open-en-5"), Into::into);
    let engine = Arc::new(Engine::new(ListDir::load(&dir)?.base));
    std::fs::create_dir_all(&out).map_err(|e| format!("cannot create {}: {e}", out.display()))?;
    let mut entries = Vec::new();
    let mut total_bytes = 0;
    for spec in strategies() {
        if let Err(e) = spec.build(&engine.list) {
            eprintln!("skipping {}: {e}", spec.kind());
            continue;
        }
        for opener in OPENERS {
            if opener.is_some_and(|o| engine.list.id(o).is_none()) {
                eprintln!("skipping opener {}: not an allowed guess", opener.unwrap());
                continue;
            }
            let mut config = Config::new(&engine.list, spec.clone());
            config.opener = opener.map(str::to_string);
            let prep = setup::prepare(&engine, &config)?;
            if !prep.deterministic {
                continue;
            }
            let (id, canonical, phases) = (prep.config_id.clone(), prep.canonical_json.clone(), prep.phases.clone());
            let mut run = Run::new(engine.clone(), prep, &Scope::all()).map_err(|e| e.to_string())?;
            let games = run.run_to_end();
            let bytes = encode_batches(&games);
            let file = format!("{id}-all.wlgb");
            std::fs::write(out.join(&file), &bytes).map_err(|e| format!("cannot write {file}: {e}"))?;
            total_bytes += bytes.len();
            eprintln!(
                "{id}  {:<40} opener {:<6} {} games, {} bytes, {:.0} ms",
                wl_engine::config::strategy_canonical_json(&spec),
                opener.unwrap_or("none"),
                games.len(),
                bytes.len(),
                run.summary().elapsed_ms
            );
            let config: Value = serde_json::from_str(&canonical).expect("canonical JSON parses");
            entries.push(json!({
                "config_id": id,
                "config": config,
                "scope": { "targets": "all" },
                "replicates": 1,
                "file": file,
                "n_games": games.len(),
                "deterministic": true,
                "phases": phases,
                "summary": { "phases": phases, "deterministic": true },
            }));
        }
    }
    // Drop batch files no entry refers to (from earlier solver versions).
    let keep: Vec<String> = entries.iter().map(|e| e["file"].as_str().unwrap().to_string()).collect();
    if let Ok(dir) = std::fs::read_dir(&out) {
        for f in dir.flatten() {
            let name = f.file_name().to_string_lossy().to_string();
            if name.ends_with(".wlgb") && !keep.contains(&name) {
                let _ = std::fs::remove_file(f.path());
            }
        }
    }
    let index = json!({ "solver_version": SOLVER_VERSION, "entries": entries });
    let text = serde_json::to_string_pretty(&index).expect("index serialises") + "\n";
    std::fs::write(out.join("index.json"), text).map_err(|e| format!("cannot write index.json: {e}"))?;
    eprintln!("{} entries, {} bytes of games in {}", keep.len(), total_bytes, out.display());
    Ok(())
}
