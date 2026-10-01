//! Golden cards: every catalogue preset that builds, on the frozen reference
//! list (data/wordlists/ref-en-5), opener "slate", R = 5 for stochastic
//! strategies. Each snapshot (tests/golden/<preset>.json) holds the
//! distribution, the mean, the first games' paths and a digest of every
//! game's bytes. Golden cards change only together with a SOLVER_VERSION bump.
//!
//! `UPDATE_GOLDEN=1 cargo test -p wl-engine --test golden` rewrites them.

mod common;

use std::path::PathBuf;

use common::*;
use serde_json::{json, Value};
use wl_core::SOLVER_VERSION;
use wl_engine::batch::encode_batches;
use wl_engine::export::fmt_num;
use wl_engine::{CardAccumulator, Scope};

const OPENER: &str = "slate";
const STOCHASTIC_R: u32 = 5;
const FIRST_GAMES: usize = 8;

fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden")
}

/// The snapshot of one preset's card.
fn snapshot(preset: &wl_strategy::catalogue::Preset) -> Option<Value> {
    let e = reference();
    if !builds(&e, &preset.spec) {
        return None;
    }
    assert!(e.list.id(OPENER).is_some(), "{OPENER} is in ref-en-5");
    let c = config(&e, preset.spec.clone(), Some(OPENER), STOCHASTIC_R);
    let prep = prepare(&e, &c);
    let games = run_all(&e, &c, &Scope::all());
    let weights = e.target_weights(prep.config.weighting);
    let mut acc = CardAccumulator::new(c.rules.max_guesses, e.list.n_answers(), prep.deterministic, weights);
    acc.ingest(&games);
    let card = acc.snapshot();
    let first: Vec<Value> = games
        .iter()
        .take(FIRST_GAMES)
        .map(|g| {
            json!({
                "target": e.list.word(e.list.answer_word(g.target)),
                "replicate": g.replicate,
                "path": g.path(&e.list),
                "solved": g.solved,
            })
        })
        .collect();
    Some(json!({
        "preset": preset.id,
        "solver_version": SOLVER_VERSION,
        "config_id": prep.config_id,
        "config": serde_json::from_str::<Value>(&prep.canonical_json).unwrap(),
        "n_games": games.len(),
        "counts": card.counts,
        "shares": card.shares.iter().map(|&s| fmt_num(s)).collect::<Vec<_>>(),
        "mean_guesses": fmt_num(card.mean),
        "se_mean": card.mean_se.map(fmt_num),
        "first_games": first,
        "games_blake3": blake3::hash(&encode_batches(&games)).to_hex().to_string(),
    }))
}

#[test]
fn golden_cards() {
    let update = std::env::var_os("UPDATE_GOLDEN").is_some();
    let dir = golden_dir();
    let mut failures = Vec::new();
    let mut checked = 0;
    for preset in wl_strategy::catalogue::presets() {
        let Some(snap) = snapshot(&preset) else { continue };
        let path = dir.join(format!("{}.json", preset.id));
        let text = serde_json::to_string_pretty(&snap).unwrap() + "\n";
        if update {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(&path, text).unwrap();
            eprintln!("wrote {}", path.display());
            continue;
        }
        checked += 1;
        match std::fs::read_to_string(&path) {
            Err(_) => failures.push(format!(
                "{}: no golden card; run UPDATE_GOLDEN=1 cargo test -p wl-engine --test golden",
                preset.id
            )),
            Ok(want) => {
                let want: Value = serde_json::from_str(&want).unwrap();
                if want != snap {
                    let bumped = want["solver_version"] != json!(SOLVER_VERSION);
                    failures.push(format!(
                        "{}: the card changed{}\n  want {}\n  got  {}",
                        preset.id,
                        if bumped {
                            " (solver version bumped: regenerate with UPDATE_GOLDEN=1)"
                        } else {
                            "; games may only change with a SOLVER_VERSION bump"
                        },
                        serde_json::to_string(&want).unwrap(),
                        serde_json::to_string(&snap).unwrap()
                    ));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    if !update {
        assert!(checked > 0, "no preset builds on ref-en-5");
    }
}
