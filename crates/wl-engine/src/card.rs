//! Card statistics, paired comparisons and ranking metrics.
//!
//! Formulas are in docs/architecture.md, "Card statistics". Rows are the
//! outcomes `1..=max_guesses` and `X` (index `max_guesses`). Statistics are
//! computed from per-game outcomes sorted by (target, replicate), so a card
//! does not depend on the order games arrived in.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use wl_core::{math, AnswerIdx};

use crate::config::Weighting;
use crate::game::Game;

/// z for a two-sided 95% interval.
pub const Z95: f64 = 1.96;
/// Tolerance for cumulative shares in quantiles (guards float summation).
pub const QUANTILE_EPS: f64 = 1e-9;

/// A card: the outcome distribution of a set of games.
#[derive(Clone, Debug, PartialEq)]
pub struct Card {
    pub max_guesses: u8,
    /// Raw game counts per row.
    pub counts: Vec<u64>,
    /// Weighted share per row, renormalised over the targets seen.
    pub shares: Vec<f64>,
    /// 95% band per row: progressive (finite-population corrected) while the
    /// first replicate pass is incomplete, then ± 1.96 SE; exact for
    /// deterministic cards.
    pub bands: Vec<(f64, f64)>,
    /// Standard error per row across replicates (stochastic, at least 2 replicates).
    pub share_se: Option<Vec<f64>>,
    /// Weighted mean guesses; a failure counts max guesses.
    pub mean: f64,
    pub mean_se: Option<f64>,
    /// Weighted (population) standard deviation of guesses over games.
    pub sd: f64,
    /// Weighted median and 95th percentile of guesses, X counting max + 1 (NaN when empty).
    pub median: f64,
    pub p95: f64,
    pub solve_rate: f64,
    pub n_games: u64,
    /// Targets with at least one game.
    pub n_targets_seen: usize,
    /// Targets in scope.
    pub n_targets: usize,
    pub deterministic: bool,
    /// Per-replicate cards: (replicate, shares, mean), for metric SEs.
    pub replicate_cards: Vec<(u32, Vec<f64>, f64)>,
}

/// Weight of every answer for cards: 1 (equal), or `10^zipf` (frequency).
/// Cards normalise by the total weight of the targets seen, so the weights
/// need not sum to 1.
pub fn target_weights(list: &wl_core::WordList, weighting: Weighting) -> Vec<f64> {
    match weighting {
        Weighting::Equal => vec![1.0; list.n_answers()],
        Weighting::Frequency => {
            list.answers().iter().map(|&id| math::pow(10.0, list.zipf_of(id) as f64)).collect()
        }
    }
}

/// Collects games and computes [`Card`] snapshots.
#[derive(Clone, Debug)]
pub struct CardAccumulator {
    max_guesses: u8,
    n_targets: usize,
    deterministic: bool,
    /// Weight per answer index (normalisation is over the targets seen).
    weights: Vec<f64>,
    /// (target, replicate, outcome row) per strategy game.
    records: Vec<(AnswerIdx, u32, u8)>,
}

impl CardAccumulator {
    /// `n_targets` is the scope size; `weights` holds one weight per answer
    /// index (see [`crate::Engine::target_weights`]).
    pub fn new(max_guesses: u8, n_targets: usize, deterministic: bool, weights: Vec<f64>) -> CardAccumulator {
        CardAccumulator { max_guesses, n_targets, deterministic, weights, records: Vec::new() }
    }

    /// Add games; player games carry no mass and are skipped.
    pub fn ingest<'a>(&mut self, games: impl IntoIterator<Item = &'a Game>) {
        for g in games {
            if !g.is_player {
                self.records.push((g.target, g.replicate, g.outcome_index(self.max_guesses) as u8));
            }
        }
    }

    pub fn n_games(&self) -> usize {
        self.records.len()
    }

    /// Guesses counted for a row: k for "solved in k", max guesses for X.
    fn row_guesses(&self, row: usize) -> f64 {
        (row + 1).min(self.max_guesses as usize) as f64
    }

    pub fn snapshot(&self) -> Card {
        let m = self.max_guesses as usize;
        let rows = m + 1;
        let mut recs = self.records.clone();
        recs.sort_unstable();

        // Per target: outcome counts.
        let mut targets: Vec<(AnswerIdx, Vec<u32>)> = Vec::new();
        for &(t, _, k) in &recs {
            if targets.last().is_none_or(|(lt, _)| *lt != t) {
                targets.push((t, vec![0; rows]));
            }
            targets.last_mut().unwrap().1[k as usize] += 1;
        }
        let weight = |t: AnswerIdx| self.weights.get(t as usize).copied().unwrap_or(1.0);

        let mut counts = vec![0u64; rows];
        let mut shares = vec![0.0; rows];
        let mut w_total = 0.0;
        let mut mean = 0.0;
        for (t, c) in &targets {
            let w = weight(*t);
            let r_t: u32 = c.iter().sum();
            w_total += w;
            let mut guesses = 0.0;
            for k in 0..rows {
                counts[k] += c[k] as u64;
                shares[k] += w * c[k] as f64 / r_t as f64;
                guesses += c[k] as f64 * self.row_guesses(k);
            }
            mean += w * guesses / r_t as f64;
        }
        let n_seen = targets.len();
        let (mean, sd) = if n_seen == 0 {
            (f64::NAN, f64::NAN)
        } else {
            shares.iter_mut().for_each(|s| *s /= w_total);
            let mean = mean / w_total;
            let mut var = 0.0;
            for (t, c) in &targets {
                let r_t: u32 = c.iter().sum();
                let w = weight(*t) / r_t as f64;
                for (k, &ck) in c.iter().enumerate() {
                    let d = self.row_guesses(k) - mean;
                    var += w * ck as f64 * d * d;
                }
            }
            (mean, math::sqrt(var / w_total))
        };
        let (median, p95) = if n_seen == 0 { (f64::NAN, f64::NAN) } else { (quantile(&shares, 0.5), quantile(&shares, 0.95)) };
        let solve_rate = if n_seen == 0 { f64::NAN } else { 1.0 - shares[m] };

        // Per replicate: the card of replicate r alone.
        let mut per_rep: BTreeMap<u32, (Vec<f64>, f64, f64)> = BTreeMap::new();
        for &(t, r, k) in &recs {
            let w = weight(t);
            let e = per_rep.entry(r).or_insert_with(|| (vec![0.0; rows], 0.0, 0.0));
            e.0[k as usize] += w;
            e.1 += w;
            e.2 += w * self.row_guesses(k as usize);
        }
        let replicate_cards: Vec<(u32, Vec<f64>, f64)> = per_rep
            .into_iter()
            .map(|(r, (wk, w, wn))| (r, wk.iter().map(|x| x / w).collect(), wn / w))
            .collect();
        let n_reps = replicate_cards.len();
        let (share_se, mean_se) = if self.deterministic || n_reps < 2 {
            (None, None)
        } else {
            let se = |xs: Vec<f64>| sample_sd(&xs) / math::sqrt(n_reps as f64);
            let share_se: Vec<f64> = (0..rows).map(|k| se(replicate_cards.iter().map(|c| c.1[k]).collect())).collect();
            (Some(share_se), Some(se(replicate_cards.iter().map(|c| c.2).collect())))
        };

        let bands = (0..rows)
            .map(|k| {
                let s = shares[k];
                let half = if self.deterministic || n_seen == 0 {
                    0.0
                } else if n_seen < self.n_targets {
                    // Progressive band over the targets seen so far.
                    if n_seen < 2 {
                        f64::INFINITY
                    } else {
                        let n = n_seen as f64;
                        let mut ss = 0.0;
                        for (t, c) in &targets {
                            let r_t: u32 = c.iter().sum();
                            let x = c[k] as f64 / r_t as f64;
                            ss += weight(*t) * (x - s) * (x - s);
                        }
                        let s2 = ss / w_total * n / (n - 1.0);
                        let fpc = 1.0 - n / self.n_targets as f64;
                        Z95 * math::sqrt(fpc * s2 / n)
                    }
                } else {
                    share_se.as_ref().map_or(0.0, |se| Z95 * se[k])
                };
                ((s - half).max(0.0), (s + half).min(1.0))
            })
            .collect();

        Card {
            max_guesses: self.max_guesses,
            counts,
            shares,
            bands,
            share_se,
            mean,
            mean_se,
            sd,
            median,
            p95,
            solve_rate,
            n_games: recs.len() as u64,
            n_targets_seen: n_seen,
            n_targets: self.n_targets,
            deterministic: self.deterministic,
            replicate_cards,
        }
    }
}

/// Smallest outcome value `v` (row k counts k + 1, X counts max + 1) whose
/// cumulative share reaches `q` (within [`QUANTILE_EPS`]).
fn quantile(shares: &[f64], q: f64) -> f64 {
    let mut cum = 0.0;
    for (k, s) in shares.iter().enumerate() {
        cum += s;
        if cum >= q - QUANTILE_EPS {
            return (k + 1) as f64;
        }
    }
    shares.len() as f64
}

/// Sample standard deviation (n − 1 denominator).
fn sample_sd(xs: &[f64]) -> f64 {
    let n = xs.len() as f64;
    let mean = xs.iter().sum::<f64>() / n;
    let ss: f64 = xs.iter().map(|x| (x - mean) * (x - mean)).sum();
    math::sqrt(ss / (n - 1.0))
}

/// Mean guesses per target over its strategy games (player games skipped).
pub fn target_means<'a>(games: impl IntoIterator<Item = &'a Game>) -> BTreeMap<AnswerIdx, f64> {
    let mut acc: BTreeMap<AnswerIdx, (f64, u32)> = BTreeMap::new();
    for g in games {
        if !g.is_player {
            let e = acc.entry(g.target).or_default();
            e.0 += g.n_guesses() as f64;
            e.1 += 1;
        }
    }
    acc.into_iter().map(|(t, (s, n))| (t, s / n as f64)).collect()
}

/// One row of `paired.csv`.
#[derive(Clone, Debug, PartialEq)]
pub struct PairRow {
    pub target: AnswerIdx,
    pub mean_a: f64,
    pub mean_b: f64,
    pub diff: f64,
}

/// Target-by-target comparison of two configurations' games, over the targets
/// both have played, in answer order.
pub fn pair_rows(a: &[Game], b: &[Game]) -> Vec<PairRow> {
    let ma = target_means(a);
    let mb = target_means(b);
    ma.iter()
        .filter_map(|(t, &x)| mb.get(t).map(|&y| PairRow { target: *t, mean_a: x, mean_b: y, diff: x - y }))
        .collect()
}

/// Ranking metrics.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RankMetric {
    /// Mean guesses (a failure counts max guesses).
    Mean,
    /// Share of failures.
    FailRate,
    /// Share solved in three or fewer.
    Le3,
    /// Mean guesses with a failure counted as max guesses + 1.
    MeanFailPlus,
}

impl RankMetric {
    pub fn as_str(self) -> &'static str {
        match self {
            RankMetric::Mean => "mean",
            RankMetric::FailRate => "fail_rate",
            RankMetric::Le3 => "le3",
            RankMetric::MeanFailPlus => "mean_fail_plus",
        }
    }

    fn of(self, shares: &[f64], mean: f64) -> f64 {
        let m = shares.len() - 1;
        match self {
            RankMetric::Mean => mean,
            RankMetric::FailRate => shares[m],
            RankMetric::Le3 => shares[..m.min(3)].iter().sum(),
            RankMetric::MeanFailPlus => shares.iter().enumerate().map(|(k, s)| (k + 1) as f64 * s).sum(),
        }
    }

    /// The metric's value on a card with a 95% interval: ± 1.96 times the
    /// standard error across replicate cards (the value itself when exact).
    pub fn value(self, card: &Card) -> (f64, f64, f64) {
        let v = self.of(&card.shares, card.mean);
        let n = card.replicate_cards.len();
        if card.deterministic || n < 2 {
            return (v, v, v);
        }
        let per: Vec<f64> = card.replicate_cards.iter().map(|(_, s, mean)| self.of(s, *mean)).collect();
        let half = Z95 * sample_sd(&per) / math::sqrt(n as f64);
        (v, v - half, v + half)
    }
}

/// One entry of a ranking panel: a strategy or an opener with its metric.
#[derive(Clone, Debug, PartialEq)]
pub struct RankEntry {
    pub name: String,
    pub value: f64,
    pub ci_low: f64,
    pub ci_high: f64,
    pub fail_rate: f64,
    /// Fully evaluated (a card), or screened out with its screening score.
    pub full: bool,
}

impl RankEntry {
    /// A fully evaluated entry from its card.
    pub fn from_card(name: &str, card: &Card, metric: RankMetric) -> RankEntry {
        let (value, ci_low, ci_high) = metric.value(card);
        let fail_rate = card.shares.last().copied().unwrap_or(f64::NAN);
        RankEntry { name: name.to_string(), value, ci_low, ci_high, fail_rate, full: true }
    }
}

impl RankMetric {
    /// Whether lower values rank higher (all but the share solved in three or fewer).
    pub fn lower_is_better(self) -> bool {
        !matches!(self, RankMetric::Le3)
    }
}

/// Rank entries (docs/specification.md, "Rankings"): full evaluations
/// before screened ones; within each, best metric value first, ties broken
/// on fail rate (lower first), then name. Missing values (NaN) go last.
/// Returns the entries in rank order with ranks 1, 2, ….
pub fn rank_entries(mut entries: Vec<RankEntry>, metric: RankMetric) -> Vec<(u32, RankEntry)> {
    let key = |x: f64| {
        if x.is_nan() {
            f64::INFINITY
        } else if metric.lower_is_better() {
            x
        } else {
            -x
        }
    };
    let fail = |x: f64| if x.is_nan() { f64::INFINITY } else { x };
    entries.sort_by(|a, b| {
        b.full
            .cmp(&a.full)
            .then_with(|| key(a.value).total_cmp(&key(b.value)))
            .then_with(|| fail(a.fail_rate).total_cmp(&fail(b.fail_rate)))
            .then_with(|| a.name.cmp(&b.name))
    });
    entries.into_iter().enumerate().map(|(i, e)| (i as u32 + 1, e)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::Turn;

    fn game(target: AnswerIdx, replicate: u32, n: usize, solved: bool) -> Game {
        let t = Turn {
            guess: 0,
            pattern: 0,
            cands_before: 1,
            cands_after: 1,
            p_chosen: 1.0,
            bits_expected: 0.0,
            phase: 0,
            is_candidate: true,
        };
        Game { target, replicate, turns: vec![t; n], solved, is_player: false }
    }

    #[test]
    fn deterministic_card() {
        // Four targets: solved in 2, 3, 3, and a failure (6 guesses).
        let games = [game(0, 0, 2, true), game(1, 0, 3, true), game(2, 0, 3, true), game(3, 0, 6, false)];
        let mut acc = CardAccumulator::new(6, 4, true, vec![1.0; 4]);
        acc.ingest(&games);
        let c = acc.snapshot();
        assert_eq!(c.counts, vec![0, 1, 2, 0, 0, 0, 1]);
        assert_eq!(c.shares, vec![0.0, 0.25, 0.5, 0.0, 0.0, 0.0, 0.25]);
        assert_eq!(c.mean, (2.0 + 3.0 + 3.0 + 6.0) / 4.0);
        let var = ((2.0f64 - 3.5).powi(2) + 2.0 * (3.0f64 - 3.5).powi(2) + (6.0f64 - 3.5).powi(2)) / 4.0;
        assert!((c.sd - var.sqrt()).abs() < 1e-12);
        assert_eq!(c.median, 3.0);
        assert_eq!(c.p95, 7.0);
        assert_eq!(c.solve_rate, 0.75);
        assert!(c.share_se.is_none() && c.mean_se.is_none());
        assert_eq!(c.bands[2], (0.5, 0.5));
    }

    #[test]
    fn stochastic_card_with_replicates_and_weights() {
        // Two targets, two replicates. Target 0: 2 then 4; target 1: 3 then X.
        let games = [game(0, 0, 2, true), game(1, 0, 3, true), game(0, 1, 4, true), game(1, 1, 6, false)];
        let mut acc = CardAccumulator::new(6, 2, false, vec![3.0, 1.0]);
        // Arrival order does not matter.
        acc.ingest(games.iter().rev());
        let c = acc.snapshot();
        // Weighted: target 0 has weight 3/4, target 1 weight 1/4.
        let share = |k: usize| c.shares[k];
        assert!((share(1) - 0.75 * 0.5).abs() < 1e-12);
        assert!((share(3) - 0.75 * 0.5).abs() < 1e-12);
        assert!((share(2) - 0.25 * 0.5).abs() < 1e-12);
        assert!((share(6) - 0.25 * 0.5).abs() < 1e-12);
        assert!((c.mean - (0.75 * 3.0 + 0.25 * 4.5)).abs() < 1e-12);
        // Replicate cards: r0 = {2: .75, 3: .25}, mean 2.25; r1 = {4: .75, X: .25}, mean 4.5.
        let se = c.share_se.as_ref().unwrap();
        let sd = |a: f64, b: f64| ((a - (a + b) / 2.0).powi(2) + (b - (a + b) / 2.0).powi(2)).sqrt();
        assert!((se[1] - sd(0.75, 0.0) / 2f64.sqrt()).abs() < 1e-12);
        assert!((c.mean_se.unwrap() - sd(2.25, 4.5) / 2f64.sqrt()).abs() < 1e-12);
        // Complete first pass: band is ± 1.96 SE, clamped.
        assert!((c.bands[1].1 - (share(1) + Z95 * se[1]).min(1.0)).abs() < 1e-12);
        let (v, lo, hi) = RankMetric::Mean.value(&c);
        assert_eq!(v, c.mean);
        assert!((hi - v - Z95 * c.mean_se.unwrap()).abs() < 1e-12 && lo < v);
        assert!((RankMetric::FailRate.value(&c).0 - share(6)).abs() < 1e-15);
    }

    #[test]
    fn progressive_band_uses_finite_population_correction() {
        // 3 of 10 targets seen: solved in 3, 3, 4.
        let games = [game(0, 0, 3, true), game(1, 0, 3, true), game(2, 0, 4, true)];
        let mut acc = CardAccumulator::new(6, 10, false, vec![1.0; 10]);
        acc.ingest(&games);
        let c = acc.snapshot();
        let s: f64 = 2.0 / 3.0;
        let s2 = (2.0 * (1.0 - s) * (1.0 - s) + s * s) / 2.0;
        let half = Z95 * ((1.0 - 0.3) * s2 / 3.0).sqrt();
        assert!((c.bands[2].0 - (s - half)).abs() < 1e-12);
        assert!((c.bands[2].1 - (s + half).min(1.0)).abs() < 1e-12);
    }

    #[test]
    fn ranking_order() {
        let e = |name: &str, value: f64, fail_rate: f64, full: bool| RankEntry {
            name: name.into(),
            value,
            ci_low: value,
            ci_high: value,
            fail_rate,
            full,
        };
        let ranked = rank_entries(
            vec![
                e("slate", 3.6, 0.01, true),
                e("crane", 3.5, 0.02, true),
                e("trace", 3.5, 0.01, true),
                e("adieu", 3.1, 0.0, false),
                e("zzzzz", f64::NAN, f64::NAN, true),
                e("audio", 3.5, 0.01, true),
            ],
            RankMetric::Mean,
        );
        let names: Vec<(u32, &str)> = ranked.iter().map(|(r, e)| (*r, e.name.as_str())).collect();
        assert_eq!(names, vec![(1, "audio"), (2, "trace"), (3, "crane"), (4, "slate"), (5, "zzzzz"), (6, "adieu")]);
        // Higher is better for the share solved in three or fewer.
        let ranked = rank_entries(vec![e("a", 0.4, 0.0, true), e("b", 0.5, 0.0, true)], RankMetric::Le3);
        assert_eq!(ranked[0].1.name, "b");
    }

    #[test]
    fn pairs() {
        let a = [game(0, 0, 3, true), game(0, 1, 5, true), game(1, 0, 2, true)];
        let b = [game(0, 0, 4, true), game(2, 0, 4, true)];
        let rows = pair_rows(&a, &b);
        assert_eq!(rows, vec![PairRow { target: 0, mean_a: 4.0, mean_b: 4.0, diff: 0.0 }]);
    }
}
