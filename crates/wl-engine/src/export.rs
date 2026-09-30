//! Tidy CSV export (docs/specification.md, "Data export").
//!
//! Conventions: UTF-8, comma separated, `\n` line ends, a header row,
//! snake_case names, lowercase words, `TRUE`/`FALSE`, `NA` for missing,
//! ISO 8601 times (passed in), no comments. Fields are quoted only when they
//! contain a comma, a double quote or a line break (quotes doubled). Numbers
//! are written by [`fmt_num`]. The same output is produced by
//! web/src/export; data/testvectors/export/ pins it down.

use wl_core::{observed_info, AnswerIdx, Pattern, WordList, SOLVER_VERSION};
use wl_strategy::StrategySpec;

use crate::card::{pair_rows, CardAccumulator, RankEntry, RankMetric};
use crate::config::{strategy_canonical_json, AnswerSelection, Config, Weighting};
use crate::game::Game;
use crate::trie::TargetTrie;
use crate::{phase_label, Prepared};

/// Format a number: rounded to 6 significant digits, half away from zero on
/// the exact binary value (as JavaScript's `toExponential(5)`), written in
/// plain decimal notation (never an exponent) without trailing zeros or a
/// trailing point. Zero is `0`; NaN and infinities are `NA`.
pub fn fmt_num(x: f64) -> String {
    if !x.is_finite() {
        return "NA".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    // 41 correctly rounded significant digits: enough to round the exact
    // value at the 6th digit for any value this crate writes.
    let s = format!("{:.40e}", x.abs());
    let (mant, exp) = s.split_once('e').expect("exponent form");
    let mut exp: i32 = exp.parse().expect("exponent");
    let all: Vec<u8> = mant.bytes().filter(u8::is_ascii_digit).map(|b| b - b'0').collect();
    let mut d = all[..6].to_vec();
    if all[6] >= 5 {
        let mut i = 6;
        loop {
            if i == 0 {
                d.insert(0, 1);
                d.pop();
                exp += 1;
                break;
            }
            i -= 1;
            if d[i] == 9 {
                d[i] = 0;
            } else {
                d[i] += 1;
                break;
            }
        }
    }
    while d.len() > 1 && d.last() == Some(&0) {
        d.pop();
    }
    let digits: String = d.iter().map(|&x| (b'0' + x) as char).collect();
    let point = exp + 1;
    let body = if point <= 0 {
        format!("0.{}{}", "0".repeat((-point) as usize), digits)
    } else if point as usize >= digits.len() {
        format!("{}{}", digits, "0".repeat(point as usize - digits.len()))
    } else {
        format!("{}.{}", &digits[..point as usize], &digits[point as usize..])
    };
    if x < 0.0 {
        format!("-{body}")
    } else {
        body
    }
}

/// `TRUE` / `FALSE`.
pub fn fmt_bool(b: bool) -> &'static str {
    if b {
        "TRUE"
    } else {
        "FALSE"
    }
}

fn opt_bool(b: Option<bool>) -> String {
    b.map_or_else(|| "NA".into(), |b| fmt_bool(b).into())
}

/// Quote a field if it contains a comma, a double quote or a line break.
pub fn escape_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// A CSV table being written.
pub struct Table {
    out: String,
}

impl Table {
    pub fn new(header: &[&str]) -> Table {
        let mut t = Table { out: String::new() };
        t.row(header.iter().map(|s| s.to_string()));
        t
    }

    pub fn row(&mut self, fields: impl IntoIterator<Item = String>) {
        for (i, f) in fields.into_iter().enumerate() {
            if i > 0 {
                self.out.push(',');
            }
            self.out.push_str(&escape_field(&f));
        }
        self.out.push('\n');
    }

    pub fn finish(self) -> String {
        self.out
    }
}

/// Matches guesses against the active letter filter (its scope, final-guess
/// rule and letter rules). With no filter, `matches_filter` is `NA`.
pub trait RowFilter {
    /// The filter as recorded in configs.csv.
    fn text(&self) -> String;
    /// Whether a guess matches. `turn` is 1-based; `solving` is true for the
    /// guess that found the target.
    fn matches(&self, word: &str, turn: usize, solving: bool) -> bool;
}

/// Export-wide settings.
pub struct ExportOptions<'a> {
    /// ISO 8601 time of the export.
    pub exported_at: String,
    pub app_version: String,
    pub filter: Option<&'a dyn RowFilter>,
    /// Keep only games that touch a filter match in games, plays and nodes
    /// (distribution, summary and paired rows always use every game).
    pub only_matching: bool,
}

/// One configuration and its games, as exported.
pub struct ExportConfig<'a> {
    /// The canonical configuration.
    pub config: Config,
    pub config_id: String,
    /// Preset or saved-strategy id, and its display label.
    pub strategy_id: String,
    pub strategy_label: String,
    /// Phase labels, indexed by `Turn::phase`.
    pub phases: Vec<String>,
    pub deterministic: bool,
    /// Strategy games (and player games, flagged `is_player`).
    pub games: &'a [Game],
    /// Whether the run finished.
    pub complete: bool,
    pub targets_finished: usize,
    /// Targets in the run's scope.
    pub n_targets: usize,
}

impl<'a> ExportConfig<'a> {
    /// From a prepared configuration, naming the strategy after a matching preset.
    pub fn new(prep: &Prepared, games: &'a [Game], complete: bool, targets_finished: usize, n_targets: usize) -> Self {
        let (strategy_id, strategy_label) = strategy_identity(&prep.config.strategy);
        ExportConfig {
            config: prep.config.clone(),
            config_id: prep.config_id.clone(),
            strategy_id,
            strategy_label,
            phases: prep.phases.clone(),
            deterministic: prep.deterministic,
            games,
            complete,
            targets_finished,
            n_targets,
        }
    }
}

/// Preset id and label for a spec, or its kind twice when no preset matches.
pub fn strategy_identity(spec: &StrategySpec) -> (String, String) {
    let json = strategy_canonical_json(spec);
    wl_strategy::catalogue::presets()
        .into_iter()
        .find(|p| strategy_canonical_json(&p.spec) == json)
        .map_or_else(|| (spec.kind().to_string(), spec.kind().to_string()), |p| (p.id.to_string(), p.label.to_string()))
}

/// `{config_id}-{target}-{replicate}`, or `{config_id}-{target}-p{n}` for player games.
pub fn game_id(config_id: &str, list: &WordList, g: &Game) -> String {
    let word = list.word(list.answer_word(g.target));
    if g.is_player {
        format!("{config_id}-{word}-p{}", g.replicate)
    } else {
        format!("{config_id}-{word}-{}", g.replicate)
    }
}

/// Games in export order: by target (answer order), strategy games by
/// replicate, then player games by number.
pub fn export_order(games: &[Game]) -> Vec<&Game> {
    let mut v: Vec<&Game> = games.iter().collect();
    v.sort_by_key(|g| (g.target, g.is_player, g.replicate));
    v
}

fn feedback_letters(list: &WordList, pattern: u16) -> String {
    Pattern(pattern).to_letters(list.word_len())
}

/// Whether a game touches a filter match.
fn touches_match(list: &WordList, g: &Game, filter: &dyn RowFilter) -> bool {
    let n = g.turns.len();
    g.turns.iter().enumerate().any(|(i, t)| filter.matches(list.word(t.guess), i + 1, g.solved && i + 1 == n))
}

/// The answer selection as recorded in configs.csv: `default`, `top:N` or `pasted:{sha256}`.
pub fn answers_label(sel: &AnswerSelection) -> String {
    match sel {
        AnswerSelection::Default => "default".into(),
        AnswerSelection::Top { n } => format!("top:{n}"),
        AnswerSelection::Pasted { sha256, .. } => format!("pasted:{sha256}"),
    }
}

fn weighting_label(w: Weighting) -> &'static str {
    match w {
        Weighting::Equal => "equal",
        Weighting::Frequency => "frequency",
    }
}

/// configs.csv: the spec's columns, then `complete` and `targets_finished`
/// (partial exports), then the other result settings, `answers` and `weighting`.
pub fn configs_csv(configs: &[ExportConfig], opts: &ExportOptions) -> String {
    let mut t = Table::new(&[
        "config_id",
        "strategy_id",
        "strategy_label",
        "strategy_json",
        "opener",
        "word_list_id",
        "word_list_version",
        "hard_mode",
        "max_guesses",
        "replicates",
        "base_seed",
        "filter",
        "solver_version",
        "app_version",
        "exported_at",
        "complete",
        "targets_finished",
        "answers",
        "weighting",
    ]);
    for c in configs {
        let cfg = &c.config;
        t.row([
            c.config_id.clone(),
            c.strategy_id.clone(),
            c.strategy_label.clone(),
            strategy_canonical_json(&cfg.strategy),
            cfg.opener.clone().unwrap_or_else(|| "NA".into()),
            cfg.word_list.id.clone(),
            cfg.word_list.version.clone(),
            fmt_bool(cfg.rules.hard_mode).into(),
            cfg.rules.max_guesses.to_string(),
            cfg.replicates.to_string(),
            cfg.base_seed.to_string(),
            opts.filter.map_or_else(|| "NA".into(), |f| f.text()),
            SOLVER_VERSION.into(),
            opts.app_version.clone(),
            opts.exported_at.clone(),
            fmt_bool(c.complete).into(),
            c.targets_finished.to_string(),
            answers_label(&cfg.word_list.answers),
            weighting_label(cfg.weighting).into(),
        ]);
    }
    t.finish()
}

pub fn games_csv(list: &WordList, rows: &[(&ExportConfig, Vec<&Game>)]) -> String {
    let mut t =
        Table::new(&["game_id", "config_id", "target", "replicate", "n_guesses", "solved", "outcome", "path", "is_player"]);
    for (c, games) in rows {
        for g in games {
            t.row([
                game_id(&c.config_id, list, g),
                c.config_id.clone(),
                list.word(list.answer_word(g.target)).into(),
                if g.is_player { "NA".into() } else { g.replicate.to_string() },
                g.n_guesses().to_string(),
                fmt_bool(g.solved).into(),
                g.outcome_label(),
                g.path(list),
                fmt_bool(g.is_player).into(),
            ]);
        }
    }
    t.finish()
}

pub fn plays_csv(list: &WordList, rows: &[(&ExportConfig, Vec<&Game>)], filter: Option<&dyn RowFilter>) -> String {
    let mut t = Table::new(&[
        "game_id",
        "config_id",
        "turn",
        "guess",
        "feedback",
        "feedback_code",
        "candidates_before",
        "candidates_after",
        "bits_expected",
        "bits_observed",
        "p_chosen",
        "is_candidate",
        "phase",
        "matches_filter",
    ]);
    for (c, games) in rows {
        for g in games {
            let id = game_id(&c.config_id, list, g);
            let n = g.turns.len();
            for (i, turn) in g.turns.iter().enumerate() {
                let word = list.word(turn.guess);
                let solving = g.solved && i + 1 == n;
                t.row([
                    id.clone(),
                    c.config_id.clone(),
                    (i + 1).to_string(),
                    word.into(),
                    feedback_letters(list, turn.pattern),
                    turn.pattern.to_string(),
                    turn.cands_before.to_string(),
                    turn.cands_after.to_string(),
                    fmt_num(turn.bits_expected as f64),
                    fmt_num(observed_info(turn.cands_before as usize, turn.cands_after as usize)),
                    fmt_num(turn.p_chosen as f64),
                    fmt_bool(turn.is_candidate).into(),
                    phase_label(&c.phases, turn.phase),
                    opt_bool(filter.map(|f| f.matches(word, i + 1, solving))),
                ]);
            }
        }
    }
    t.finish()
}

/// Nodes of one target tree per configuration, built from the games in
/// export order (so node ids follow that order).
pub fn nodes_csv(
    list: &WordList,
    target: AnswerIdx,
    rows: &[(&ExportConfig, Vec<&Game>)],
    filter: Option<&dyn RowFilter>,
) -> String {
    let mut t = Table::new(&[
        "node_id",
        "parent_id",
        "config_id",
        "target",
        "depth",
        "guess",
        "feedback",
        "n_games",
        "share",
        "is_terminal",
        "outcome",
        "matches_filter",
    ]);
    let target_word = list.word(list.answer_word(target));
    let target_id = list.answer_word(target);
    for (c, games) in rows {
        let trie = TargetTrie::from_games(target, games.iter().copied());
        let total = trie.total_mass() as f64;
        let node_id = |id: u32| format!("{}-{target_word}-n{id}", c.config_id);
        for n in &trie.nodes {
            let solving = n.guess == Some(target_id);
            let outcome = if solving {
                n.depth.to_string()
            } else if n.terminal {
                "X".into()
            } else {
                "NA".into()
            };
            t.row([
                node_id(n.id),
                n.parent.map_or_else(|| "NA".into(), node_id),
                c.config_id.clone(),
                target_word.into(),
                n.depth.to_string(),
                n.guess.map_or_else(|| "NA".into(), |g| list.word(g).into()),
                n.guess.map_or_else(|| "NA".into(), |_| feedback_letters(list, n.pattern)),
                n.mass.to_string(),
                fmt_num(if total > 0.0 { n.mass as f64 / total } else { f64::NAN }),
                fmt_bool(n.terminal).into(),
                outcome,
                match (n.guess, filter) {
                    (Some(g), Some(f)) => fmt_bool(f.matches(list.word(g), n.depth as usize, solving)).into(),
                    _ => "NA".into(),
                },
            ]);
        }
    }
    t.finish()
}

/// Card of a configuration's games (player games skipped).
pub fn card_of(list: &WordList, c: &ExportConfig, games: &[&Game], n_targets: usize) -> crate::Card {
    let weights = crate::card::target_weights(list, c.config.weighting);
    let mut acc = CardAccumulator::new(c.config.rules.max_guesses, n_targets, c.deterministic, weights);
    acc.ingest(games.iter().copied());
    acc.snapshot()
}

fn outcome_name(k: usize, max: u8) -> String {
    if k < max as usize {
        (k + 1).to_string()
    } else {
        "X".into()
    }
}

pub fn distribution_csv(cards: &[(&ExportConfig, crate::Card)]) -> String {
    let mut t = Table::new(&["config_id", "outcome", "n_games", "share", "share_se"]);
    for (c, card) in cards {
        for k in 0..card.shares.len() {
            t.row([
                c.config_id.clone(),
                outcome_name(k, card.max_guesses),
                card.counts[k].to_string(),
                fmt_num(card.shares[k]),
                card.share_se.as_ref().map_or_else(|| "NA".into(), |se| fmt_num(se[k])),
            ]);
        }
    }
    t.finish()
}

pub fn summary_csv(cards: &[(&ExportConfig, crate::Card)]) -> String {
    let mut t = Table::new(&[
        "config_id",
        "n_targets",
        "n_games",
        "mean_guesses",
        "sd_guesses",
        "se_mean",
        "median",
        "solve_rate",
        "p95",
    ]);
    for (c, card) in cards {
        t.row([
            c.config_id.clone(),
            card.n_targets_seen.to_string(),
            card.n_games.to_string(),
            fmt_num(card.mean),
            fmt_num(card.sd),
            card.mean_se.map_or_else(|| "NA".into(), fmt_num),
            fmt_num(card.median),
            fmt_num(card.solve_rate),
            fmt_num(card.p95),
        ]);
    }
    t.finish()
}

pub fn paired_csv(list: &WordList, configs: &[ExportConfig], pairs: &[(usize, usize)]) -> String {
    let mut t = Table::new(&["target", "config_a", "config_b", "mean_a", "mean_b", "diff"]);
    for &(a, b) in pairs {
        let (ca, cb) = (&configs[a], &configs[b]);
        for r in pair_rows(ca.games, cb.games) {
            t.row([
                list.word(list.answer_word(r.target)).into(),
                ca.config_id.clone(),
                cb.config_id.clone(),
                fmt_num(r.mean_a),
                fmt_num(r.mean_b),
                fmt_num(r.diff),
            ]);
        }
    }
    t.finish()
}

/// One ranked entry of a ranking panel.
#[derive(Clone, Debug, PartialEq)]
pub struct RankingRow {
    pub ranking_id: String,
    /// `"opener"` (a row ranking strategies) or `"strategy"` (a column ranking openers).
    pub fixed_kind: String,
    pub fixed_value: String,
    pub entry: String,
    pub rank: u32,
    pub metric: RankMetric,
    pub value: f64,
    pub ci_low: f64,
    pub ci_high: f64,
    pub fail_rate: f64,
    /// `"full"` or `"screened"`.
    pub stage: String,
}

/// Ranking rows for ranked entries (see [`crate::card::rank_entries`]).
pub fn ranking_rows(
    ranking_id: &str,
    fixed_kind: &str,
    fixed_value: &str,
    metric: RankMetric,
    ranked: &[(u32, RankEntry)],
) -> Vec<RankingRow> {
    ranked
        .iter()
        .map(|(rank, e)| RankingRow {
            ranking_id: ranking_id.into(),
            fixed_kind: fixed_kind.into(),
            fixed_value: fixed_value.into(),
            entry: e.name.clone(),
            rank: *rank,
            metric,
            value: e.value,
            ci_low: e.ci_low,
            ci_high: e.ci_high,
            fail_rate: e.fail_rate,
            stage: if e.full { "full" } else { "screened" }.into(),
        })
        .collect()
}

pub fn ranking_csv(rows: &[RankingRow]) -> String {
    let mut t = Table::new(&[
        "ranking_id",
        "fixed_kind",
        "fixed_value",
        "entry",
        "rank",
        "metric",
        "value",
        "ci_low",
        "ci_high",
        "fail_rate",
        "stage",
    ]);
    for r in rows {
        t.row([
            r.ranking_id.clone(),
            r.fixed_kind.clone(),
            r.fixed_value.clone(),
            r.entry.clone(),
            r.rank.to_string(),
            r.metric.as_str().into(),
            fmt_num(r.value),
            fmt_num(r.ci_low),
            fmt_num(r.ci_high),
            fmt_num(r.fail_rate),
            r.stage.clone(),
        ]);
    }
    t.finish()
}

/// What a level exports.
#[derive(Clone, Debug, PartialEq)]
pub enum Level {
    /// One target's tree: configs, that target's games, plays and nodes, and
    /// that target's distribution.
    Tree { target: AnswerIdx },
    /// Configs, games, plays, distribution and summary.
    Card,
    /// As Card for every configuration, plus paired rows for each compared pair.
    Atlas { pairs: Vec<(usize, usize)> },
}

impl Level {
    pub fn name(&self) -> &'static str {
        match self {
            Level::Tree { .. } => "tree",
            Level::Card => "card",
            Level::Atlas { .. } => "atlas",
        }
    }
}

/// Every file of a level's export, as (file name, contents), in a fixed order.
pub fn export_files(list: &WordList, level: &Level, configs: &[ExportConfig], opts: &ExportOptions) -> Vec<(String, String)> {
    let tree_target = match level {
        Level::Tree { target } => Some(*target),
        _ => None,
    };
    // All games of each configuration in export order (for the level's target).
    let all: Vec<(&ExportConfig, Vec<&Game>)> = configs
        .iter()
        .map(|c| (c, export_order(c.games).into_iter().filter(|g| tree_target.is_none_or(|t| g.target == t)).collect()))
        .collect();
    // Row-level tables may be limited to games touching a match.
    let rows: Vec<(&ExportConfig, Vec<&Game>)> = match (opts.filter, opts.only_matching) {
        (Some(f), true) => all
            .iter()
            .map(|(c, games)| (*c, games.iter().copied().filter(|g| touches_match(list, g, f)).collect()))
            .collect(),
        _ => all.clone(),
    };
    let cards: Vec<(&ExportConfig, crate::Card)> = all
        .iter()
        .map(|(c, games)| (*c, card_of(list, c, games, if tree_target.is_some() { 1 } else { c.n_targets })))
        .collect();
    let mut files = vec![
        ("configs.csv".to_string(), configs_csv(configs, opts)),
        ("games.csv".to_string(), games_csv(list, &rows)),
        ("plays.csv".to_string(), plays_csv(list, &rows, opts.filter)),
    ];
    match level {
        Level::Tree { target } => {
            files.push(("nodes.csv".into(), nodes_csv(list, *target, &rows, opts.filter)));
            files.push(("distribution.csv".into(), distribution_csv(&cards)));
        }
        Level::Card => {
            files.push(("distribution.csv".into(), distribution_csv(&cards)));
            files.push(("summary.csv".into(), summary_csv(&cards)));
        }
        Level::Atlas { pairs } => {
            files.push(("distribution.csv".into(), distribution_csv(&cards)));
            files.push(("summary.csv".into(), summary_csv(&cards)));
            files.push(("paired.csv".into(), paired_csv(list, configs, pairs)));
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers() {
        let cases: &[(f64, &str)] = &[
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (3.5, "3.5"),
            (1.0 / 3.0, "0.333333"),
            (2.0 / 3.0, "0.666667"),
            (123456.0, "123456"),
            (1234567.0, "1234570"),
            (123456.5, "123457"),
            (-1.23456789, "-1.23457"),
            (0.000123456789, "0.000123457"),
            (1.5e-7, "0.00000015"),
            (9.999996, "10"),
            (0.9999996, "1"),
            // Exact ties round away from zero (as toExponential does).
            (0.001953125, "0.00195313"),
            (3.515625, "3.51563"),
            (-3.515625, "-3.51563"),
            (f64::NAN, "NA"),
            (f64::INFINITY, "NA"),
            (5.870_000_362_396_24, "5.87"),
        ];
        for &(x, want) in cases {
            assert_eq!(fmt_num(x), want, "{x}");
        }
        // f32 values are written from their exact f64 widening.
        assert_eq!(fmt_num(0.1f32 as f64), "0.1");
        assert_eq!(fmt_num(1.0f32 as f64 / 3.0), "0.333333");
    }

    #[test]
    fn ranking_table() {
        let entries = vec![RankEntry { name: "crane".into(), value: 3.5, ci_low: 3.4, ci_high: 3.6, fail_rate: 0.004, full: true }];
        let rows = ranking_rows("r1", "strategy", "max_info", RankMetric::Mean, &crate::card::rank_entries(entries, RankMetric::Mean));
        assert_eq!(
            ranking_csv(&rows),
            "ranking_id,fixed_kind,fixed_value,entry,rank,metric,value,ci_low,ci_high,fail_rate,stage\n\
             r1,strategy,max_info,crane,1,mean,3.5,3.4,3.6,0.004,full\n"
        );
    }

    #[test]
    fn quoting() {
        assert_eq!(escape_field("plain"), "plain");
        assert_eq!(escape_field(r#"{"kind":"max_info","pool":"allowed"}"#), r#""{""kind"":""max_info"",""pool"":""allowed""}""#);
        assert_eq!(escape_field("a\nb"), "\"a\nb\"");
        let mut t = Table::new(&["a", "b"]);
        t.row(["1".to_string(), "x,y".to_string()]);
        assert_eq!(t.finish(), "a,b\n1,\"x,y\"\n");
    }
}
