//! The shared export test vectors in data/testvectors/export/ (see its
//! README.md): games.json holds the input games and configurations, and each
//! export directory the CSV files both exporters must write for them.
//!
//! This test rebuilds every export from games.json and compares the files
//! byte for byte. `UPDATE_GOLDEN=1 cargo test -p wl-engine --test
//! export_vectors` regenerates games.json (by playing the games) and the CSVs.

mod common;

use std::path::PathBuf;

use common::*;
use serde_json::{json, Value};
use wl_core::{AnswerIdx, SOLVER_VERSION};
use wl_engine::export::{export_files, strategy_identity, ExportConfig, ExportOptions, Level};
use wl_engine::{Config, Game, Run, Scope, Targets, Turn};
use wl_strategy::{Pool, StrategySpec};

const EXPORTED_AT: &str = "2026-09-30T15:33:00Z";
const APP_VERSION: &str = "testvectors";

fn vector_dir() -> PathBuf {
    repo_root().join("data/testvectors/export")
}

fn turn_json(t: &Turn) -> Value {
    // Probabilities and bits are f32 in batches; write their exact f64
    // widening so a JSON reader gets the value a batch decoder would.
    json!({
        "guess": t.guess, "pattern": t.pattern, "candsBefore": t.cands_before, "candsAfter": t.cands_after,
        "pChosen": t.p_chosen as f64, "bitsExpected": t.bits_expected as f64, "phase": t.phase,
        "isCandidate": t.is_candidate,
    })
}

fn game_json(g: &Game) -> Value {
    json!({
        "target": g.target, "replicate": g.replicate, "solved": g.solved, "isPlayer": g.is_player,
        "turns": g.turns.iter().map(turn_json).collect::<Vec<_>>(),
    })
}

fn game_from_json(v: &Value) -> Game {
    let n = |v: &Value, k: &str| v[k].as_u64().unwrap_or_else(|| panic!("{k}"));
    let turns = v["turns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| Turn {
            guess: n(t, "guess") as u16,
            pattern: n(t, "pattern") as u16,
            cands_before: n(t, "candsBefore") as u16,
            cands_after: n(t, "candsAfter") as u16,
            p_chosen: t["pChosen"].as_f64().unwrap() as f32,
            bits_expected: t["bitsExpected"].as_f64().unwrap() as f32,
            phase: n(t, "phase") as u8,
            is_candidate: t["isCandidate"].as_bool().unwrap(),
        })
        .collect();
    Game {
        target: n(v, "target") as AnswerIdx,
        replicate: n(v, "replicate") as u32,
        turns,
        solved: v["solved"].as_bool().unwrap(),
        is_player: v["isPlayer"].as_bool().unwrap_or(false),
    }
}

/// Play the vector's games: a deterministic card, and a partial stochastic
/// run with one player game.
fn generate() -> Value {
    let e = reference();
    let mut configs = Vec::new();

    // 1. max_info (candidates) with opener slate over every answer.
    let c = config(&e, StrategySpec::MaxInfo { pool: Pool::Candidates }, Some("slate"), 1);
    let prep = prepare(&e, &c);
    let games = run_all(&e, &c, &Scope::all());
    configs.push(config_json(&prep, &games, true, e.list.n_answers(), e.list.n_answers()));

    // 2. info_proportional with opener slate, R = 2 over a sample of 6
    // targets, stopped after 9 games: every target at r = 0, three at r = 1.
    let c: Config = config(&e, StrategySpec::InfoProportional { beta: 1.0, pool: Pool::Candidates }, Some("slate"), 2);
    let prep = prepare(&e, &c);
    let mut run = Run::new(e.clone(), prepare(&e, &c), &Scope { targets: Targets::Sample(6), replicates: None }).unwrap();
    let mut games = run.step_units(9);
    let p = run.progress();
    assert_eq!((p.done, p.targets_done), (9, 3));
    // A player game against the first target: the opener, two guesses of
    // the player's own, then the strategy's continuation (numbered p1).
    let target = games[0].target;
    let own: Vec<u16> = ["crane", "doubt", "about"]
        .iter()
        .filter_map(|w| e.list.id(w))
        .filter(|&id| id != e.list.answer_word(target))
        .take(2)
        .collect();
    let prefix = [e.list.id("slate").unwrap(), own[0], own[1]];
    let mut player = prep.continue_game(&e, &prefix, target, 0, false).unwrap();
    player.is_player = true;
    player.replicate = 1;
    games.push(player);
    configs.push(config_json(&prep, &games, false, p.targets_done, p.targets_total));
    let tree_target = e.list.word(e.list.answer_word(target)).to_string();

    json!({
        "description": "Input of the shared export test vectors: configurations and their games (in arrival order). See README.md.",
        "solver_version": SOLVER_VERSION,
        "word_list": { "id": e.list.manifest.id, "version": e.list.manifest.version, "dir": "data/wordlists/ref-en-5" },
        "exported_at": EXPORTED_AT,
        "app_version": APP_VERSION,
        "configs": configs,
        "exports": [
            { "dir": "card", "level": "card", "configs": [0] },
            { "dir": "atlas", "level": "atlas", "configs": [0, 1], "pairs": [[0, 1]] },
            { "dir": "tree", "level": "tree", "configs": [1], "target": tree_target },
        ],
    })
}

fn config_json(prep: &wl_engine::Prepared, games: &[Game], complete: bool, finished: usize, n_targets: usize) -> Value {
    let (strategy_id, strategy_label) = strategy_identity(&prep.config.strategy);
    json!({
        "config_id": prep.config_id,
        "config": serde_json::from_str::<Value>(&prep.canonical_json).unwrap(),
        "strategy_id": strategy_id,
        "strategy_label": strategy_label,
        "phases": prep.phases,
        "deterministic": prep.deterministic,
        "complete": complete,
        "targets_finished": finished,
        "n_targets": n_targets,
        "games": games.iter().map(game_json).collect::<Vec<_>>(),
    })
}

/// games.json text: indented, with one compact game per line.
fn write_vectors(v: &Value) -> String {
    let mut v = v.clone();
    let mut games = Vec::new();
    for (i, c) in v["configs"].as_array_mut().unwrap().iter_mut().enumerate() {
        let lines: Vec<String> = c["games"].as_array().unwrap().iter().map(|g| serde_json::to_string(g).unwrap()).collect();
        games.push(format!("[\n        {}\n      ]", lines.join(",\n        ")));
        c["games"] = json!(format!("@games{i}@"));
    }
    let mut text = serde_json::to_string_pretty(&v).unwrap() + "\n";
    for (i, g) in games.iter().enumerate() {
        text = text.replace(&format!("\"@games{i}@\""), g);
    }
    text
}

/// Every export of the vector, as (directory, file name, contents).
fn exports(vectors: &Value) -> Vec<(String, String, String)> {
    let e = reference();
    let list = &e.list;
    assert_eq!(vectors["word_list"]["id"], json!(list.manifest.id));
    let configs: Vec<(Config, Value, Vec<Game>)> = vectors["configs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            let config: Config = serde_json::from_value(c["config"].clone()).unwrap();
            let games = c["games"].as_array().unwrap().iter().map(game_from_json).collect();
            (config, c.clone(), games)
        })
        .collect();
    let opts = ExportOptions {
        exported_at: vectors["exported_at"].as_str().unwrap().into(),
        app_version: vectors["app_version"].as_str().unwrap().into(),
        filter: None,
        only_matching: false,
    };
    let mut out = Vec::new();
    for x in vectors["exports"].as_array().unwrap() {
        let chosen: Vec<ExportConfig> = x["configs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| {
                let (config, meta, games) = &configs[i.as_u64().unwrap() as usize];
                let s = |k: &str| meta[k].as_str().unwrap().to_string();
                let u = |k: &str| meta[k].as_u64().unwrap() as usize;
                ExportConfig {
                    config: config.clone(),
                    config_id: s("config_id"),
                    strategy_id: s("strategy_id"),
                    strategy_label: s("strategy_label"),
                    phases: serde_json::from_value(meta["phases"].clone()).unwrap(),
                    deterministic: meta["deterministic"].as_bool().unwrap(),
                    games,
                    complete: meta["complete"].as_bool().unwrap(),
                    targets_finished: u("targets_finished"),
                    n_targets: u("n_targets"),
                }
            })
            .collect();
        let level = match x["level"].as_str().unwrap() {
            "card" => Level::Card,
            "tree" => Level::Tree { target: list.answer_of_word(x["target"].as_str().unwrap()).unwrap() },
            "atlas" => Level::Atlas { pairs: serde_json::from_value(x["pairs"].clone()).unwrap() },
            other => panic!("level {other}"),
        };
        let dir = x["dir"].as_str().unwrap().to_string();
        for (name, text) in export_files(list, &level, &chosen, &opts) {
            out.push((dir.clone(), name, text));
        }
    }
    out
}

#[test]
fn export_vectors() {
    let dir = vector_dir();
    let path = dir.join("games.json");
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        let v = generate();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, write_vectors(&v)).unwrap();
    }
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("games.json exists")).unwrap();
    // The stored games are still what the engine plays (else bump SOLVER_VERSION and regenerate).
    // (Compared as games: serde_json's default float parser may be off by an
    // ulp in f64, which never changes the f32 values games hold.)
    let fresh = generate();
    let games_of = |v: &Value| -> Vec<Vec<Game>> {
        v["configs"].as_array().unwrap().iter().map(|c| c["games"].as_array().unwrap().iter().map(game_from_json).collect()).collect()
    };
    assert_eq!(games_of(&vectors), games_of(&fresh), "the vector's games changed; regenerate with UPDATE_GOLDEN=1");
    let meta = |v: &Value| -> Vec<Value> {
        v["configs"].as_array().unwrap().iter().map(|c| { let mut c = c.clone(); c["games"] = Value::Null; c }).collect()
    };
    assert_eq!(meta(&vectors), meta(&fresh), "the vector's configurations changed; regenerate with UPDATE_GOLDEN=1");
    let mut failures = Vec::new();
    for (sub, name, text) in exports(&vectors) {
        let file = dir.join(&sub).join(&name);
        if std::env::var_os("UPDATE_GOLDEN").is_some() {
            std::fs::create_dir_all(dir.join(&sub)).unwrap();
            std::fs::write(&file, &text).unwrap();
            continue;
        }
        match std::fs::read_to_string(&file) {
            Ok(want) if want == text => {}
            Ok(want) => {
                let line = want.lines().zip(text.lines()).position(|(a, b)| a != b).unwrap_or(0);
                failures.push(format!(
                    "{sub}/{name} differs at line {}:\n  want {}\n  got  {}",
                    line + 1,
                    want.lines().nth(line).unwrap_or(""),
                    text.lines().nth(line).unwrap_or("")
                ));
            }
            Err(_) => failures.push(format!("{sub}/{name} is missing")),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
