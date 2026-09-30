//! The `play`, `card`, `export`, `batch` and `config-id` commands.

use std::path::PathBuf;
use std::sync::Arc;

use wl_core::filter::{Combine, CompiledFilter, Filter};
use wl_core::Pattern;
use wl_engine::batch::encode_batches;
use wl_engine::card::CardAccumulator;
use wl_engine::export::{export_files, fmt_num, ExportConfig, ExportOptions, Level, RowFilter};
use wl_engine::{Card, Engine, Game, Prepared, Run, Scope, Targets};

use crate::args::Args;
use crate::setup::{self, base_config, configs, list_dir, Engines, ListDir, Result, CONFIG_OPTIONS, SCOPE_OPTIONS};

/// Check for unknown options.
pub fn check_options(args: &Args, extra: &[&str]) -> Result<()> {
    let mut known: Vec<&str> = CONFIG_OPTIONS.to_vec();
    known.extend_from_slice(SCOPE_OPTIONS);
    known.extend_from_slice(extra);
    known.push("help");
    match args.unknown(&known).as_slice() {
        [] => Ok(()),
        bad => Err(format!("unknown option(s): {}", bad.iter().map(|b| format!("--{b}")).collect::<Vec<_>>().join(", "))),
    }
}

/// The word list and configurations of the options.
pub fn load(args: &Args) -> Result<(Engines, Vec<wl_engine::Config>)> {
    let base = base_config(args)?;
    let list = ListDir::load(&list_dir(args, base.as_ref()))?;
    let configs = configs(args, &list.base, base)?;
    Ok((Engines::new(list), configs))
}

/// The one configuration of the options, prepared, with its engine.
pub fn load_one(args: &Args) -> Result<(Arc<Engine>, Prepared)> {
    let (mut engines, configs) = load(args)?;
    if configs.len() != 1 {
        return Err("this command takes one strategy and one opener".into());
    }
    let engine = engines.for_config(&configs[0])?;
    let prep = setup::prepare(&engine, &configs[0])?;
    Ok((engine, prep))
}

/// Every game of a configuration over a scope.
pub fn run_games(engine: &Arc<Engine>, prep: Prepared, scope: &Scope) -> Result<(Vec<Game>, Run)> {
    let mut run = Run::new(engine.clone(), prep, scope).map_err(|e| e.to_string())?;
    let games = run.run_to_end();
    Ok((games, run))
}

pub fn config_id(args: &Args) -> Result<()> {
    check_options(args, &[])?;
    let (mut engines, configs) = load(args)?;
    for c in &configs {
        let engine = engines.for_config(c)?;
        let prep = setup::prepare(&engine, c)?;
        println!("{}\t{}", prep.config_id, prep.canonical_json);
    }
    Ok(())
}

pub fn play(args: &Args) -> Result<()> {
    check_options(args, &["target", "replicate", "prefix", "one-step", "json", "out"])?;
    let (engine, prep) = load_one(args)?;
    let list = &engine.list;
    let target = match args.get("target") {
        Some(t) => setup::target_arg(&engine, t)?,
        None => prep.target_order(list.n_answers())[0],
    };
    let replicate = args.parsed::<u32>("replicate")?.unwrap_or(0);
    let prefix: Vec<u16> = match args.get("prefix") {
        None => vec![],
        Some(p) => p
            .split(',')
            .map(|w| list.id(w.trim()).ok_or_else(|| format!("{w:?} is not an allowed guess")))
            .collect::<Result<_>>()?,
    };
    let game = prep
        .continue_game(&engine, &prefix, target, replicate, args.flag("one-step"))
        .map_err(|e| e.to_string())?;
    if let Some(path) = args.get("out") {
        let bytes = wl_engine::batch::encode_batch(std::slice::from_ref(&game));
        std::fs::write(path, bytes).map_err(|e| format!("cannot write {path}: {e}"))?;
        return Ok(());
    }
    if args.flag("json") {
        println!("{}", serde_json::to_string_pretty(&game).expect("game serialises"));
        return Ok(());
    }
    println!("config {}  target {}  replicate {replicate}", prep.config_id, list.word(list.answer_word(target)));
    println!("{:>4}  {:<7} {:<7} {:>6} {:>6} {:>7} {:>8}  phase", "turn", "guess", "fb", "before", "after", "bits", "p");
    for (i, t) in game.turns.iter().enumerate() {
        println!(
            "{:>4}  {:<7} {:<7} {:>6} {:>6} {:>7} {:>8}  {}",
            i + 1,
            list.word(t.guess),
            Pattern(t.pattern).to_letters(list.word_len()),
            t.cands_before,
            t.cands_after,
            fmt_num(t.bits_expected as f64),
            fmt_num(t.p_chosen as f64),
            prep.phase_label(t.phase)
        );
    }
    println!("{}", if game.solved { format!("solved in {}", game.n_guesses()) } else { "not solved".to_string() });
    Ok(())
}

/// The card of a prepared configuration's games.
pub fn card_of(engine: &Engine, prep: &Prepared, games: &[Game], n_targets: usize) -> Card {
    let weights = engine.target_weights(prep.config.weighting);
    let mut acc = CardAccumulator::new(prep.config.rules.max_guesses, n_targets, prep.deterministic, weights);
    acc.ingest(games);
    acc.snapshot()
}

pub fn card(args: &Args) -> Result<()> {
    check_options(args, &["json"])?;
    let (mut engines, configs) = load(args)?;
    for c in &configs {
        let engine = engines.for_config(c)?;
        let prep = setup::prepare(&engine, c)?;
        let scope = setup::scope(args, &engine)?;
        let id = prep.config_id.clone();
        let (games, run) = run_games(&engine, prep, &scope)?;
        let prep = run.prepared();
        let card = card_of(&engine, prep, &games, run.progress().targets_total);
        if args.flag("json") {
            let rows: Vec<serde_json::Value> = (0..card.shares.len())
                .map(|k| {
                    serde_json::json!({
                        "outcome": outcome(k, card.max_guesses), "n_games": card.counts[k], "share": card.shares[k],
                        "share_se": card.share_se.as_ref().map(|s| s[k]),
                    })
                })
                .collect();
            let out = serde_json::json!({
                "config_id": id, "config": serde_json::from_str::<serde_json::Value>(&prep.canonical_json).unwrap(),
                "n_targets": card.n_targets_seen, "n_games": card.n_games, "mean_guesses": card.mean,
                "sd_guesses": card.sd, "se_mean": card.mean_se, "median": card.median, "p95": card.p95,
                "solve_rate": card.solve_rate, "distribution": rows, "elapsed_ms": run.summary().elapsed_ms,
            });
            println!("{}", serde_json::to_string_pretty(&out).expect("card serialises"));
            continue;
        }
        let opener = prep.config.opener.as_deref().unwrap_or("strategy's choice");
        println!("config {id}  {}  opener {opener}", prep.strategy_json);
        println!(
            "{} {}, {} targets x {} replicates{}",
            prep.config.word_list.id,
            prep.config.word_list.version,
            card.n_targets_seen,
            prep.config.replicates,
            if prep.config.rules.hard_mode { ", hard mode" } else { "" }
        );
        println!("{:>7} {:>8} {:>9} {:>9}", "outcome", "games", "share", "se");
        for k in 0..card.shares.len() {
            let se = card.share_se.as_ref().map_or("NA".to_string(), |s| fmt_num(s[k]));
            println!("{:>7} {:>8} {:>9} {:>9}", outcome(k, card.max_guesses), card.counts[k], fmt_num(card.shares[k]), se);
        }
        println!(
            "mean {}{}  sd {}  median {}  p95 {}  solved {}  ({} games in {:.0} ms)",
            fmt_num(card.mean),
            card.mean_se.map_or(String::new(), |s| format!(" ± {}", fmt_num(s))),
            fmt_num(card.sd),
            fmt_num(card.median),
            fmt_num(card.p95),
            fmt_num(card.solve_rate),
            card.n_games,
            run.summary().elapsed_ms
        );
        println!();
    }
    Ok(())
}

fn outcome(k: usize, max: u8) -> String {
    if k < max as usize {
        (k + 1).to_string()
    } else {
        "X".into()
    }
}

pub fn batch(args: &Args) -> Result<()> {
    check_options(args, &["out"])?;
    let (engine, prep) = load_one(args)?;
    let scope = setup::scope(args, &engine)?;
    let (games, _) = run_games(&engine, prep, &scope)?;
    let bytes = encode_batches(&games);
    match args.get("out") {
        Some(path) if path != "-" => std::fs::write(path, &bytes).map_err(|e| format!("cannot write {path}: {e}"))?,
        _ => {
            use std::io::Write;
            std::io::stdout().write_all(&bytes).map_err(|e| e.to_string())?;
        }
    }
    eprintln!("{} games, {} bytes", games.len(), bytes.len());
    Ok(())
}

/// The letter filter of `--filter` (with `--any`, `--rows 1,2`, `--final no`, `--y-vowel`).
struct CliFilter {
    filter: Filter,
    compiled: CompiledFilter,
}

impl RowFilter for CliFilter {
    fn text(&self) -> String {
        let mut t = self.filter.text();
        if self.filter.combine == Combine::Any && self.filter.rules.len() > 1 {
            t = format!("any: {t}");
        }
        t
    }

    fn matches(&self, word: &str, turn: usize, solving: bool) -> bool {
        self.compiled.matches_node(word.as_bytes(), turn as u32, solving)
    }
}

pub fn export(args: &Args) -> Result<()> {
    check_options(
        args,
        &["level", "out", "target", "exported-at", "app-version", "filter", "any", "rows", "final", "y-vowel", "only-matching", "no-pairs"],
    )?;
    let level_name = args.get("level").unwrap_or("card");
    let out = PathBuf::from(args.get("out").ok_or("export needs --out DIR")?);
    let (mut engines, configs) = load(args)?;
    if configs.is_empty() {
        return Err("no configurations".into());
    }
    // Every configuration of an export shares one answer selection.
    let engine = engines.for_config(&configs[0])?;
    let preps: Vec<Prepared> = configs.iter().map(|c| setup::prepare(&engine, c)).collect::<Result<_>>()?;
    let (level, scope) = match level_name {
        "tree" => {
            let t = setup::target_arg(&engine, args.get("target").ok_or("a tree export needs --target WORD")?)?;
            (Level::Tree { target: t }, Scope { targets: Targets::List(vec![t]), replicates: None })
        }
        "card" if preps.len() == 1 => (Level::Card, setup::scope(args, &engine)?),
        "card" => return Err("a card export takes one configuration; use --level atlas for several".into()),
        "atlas" => {
            let n = preps.len();
            let pairs = if args.flag("no-pairs") {
                vec![]
            } else {
                (0..n).flat_map(|a| (a + 1..n).map(move |b| (a, b))).collect()
            };
            (Level::Atlas { pairs }, setup::scope(args, &engine)?)
        }
        other => return Err(format!("unknown level {other:?} (tree, card or atlas)")),
    };
    let mut runs = Vec::new();
    for prep in preps {
        let (games, run) = run_games(&engine, prep, &scope)?;
        runs.push((games, run));
    }
    let exports: Vec<ExportConfig> = runs
        .iter()
        .map(|(games, run)| {
            let p = run.progress();
            ExportConfig::new(run.prepared(), games, true, p.targets_done, p.targets_total)
        })
        .collect();
    let filter = match args.get("filter") {
        None => None,
        Some(text) => {
            let combine = if args.flag("any") { Combine::Any } else { Combine::All };
            let mut filter = Filter::parse(text, engine.list.word_len(), combine).map_err(|e| format!("--filter: {e}"))?;
            if let Some(rows) = args.get("rows") {
                filter.rows = rows.split(',').map(|r| r.trim().parse().map_err(|_| "--rows: bad row")).collect::<std::result::Result<_, _>>()?;
            }
            filter.include_final = args.get("final") != Some("no");
            let compiled = filter.compile(args.flag("y-vowel"));
            Some(CliFilter { filter, compiled })
        }
    };
    let opts = ExportOptions {
        exported_at: args.get("exported-at").map_or_else(setup::iso_now, str::to_string),
        app_version: args.get("app-version").map_or_else(|| format!("wordlology-cli {}", env!("CARGO_PKG_VERSION")), str::to_string),
        filter: filter.as_ref().map(|f| f as &dyn RowFilter),
        only_matching: args.flag("only-matching"),
    };
    std::fs::create_dir_all(&out).map_err(|e| format!("cannot create {}: {e}", out.display()))?;
    for (name, text) in export_files(&engine.list, &level, &exports, &opts) {
        let path = out.join(&name);
        std::fs::write(&path, text).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
        eprintln!("wrote {}", path.display());
    }
    Ok(())
}
