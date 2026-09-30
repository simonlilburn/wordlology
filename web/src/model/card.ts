// Card statistics from games. Owned by the platform agent. Formulas: docs/architecture.md.
//
// Rows are outcomes 1..maxGuesses and X. With target weights w_t (1/|A|, or
// each target's share of total frequency):
//
//   share_k   = Σ_t w_t (1/R_t) Σ_r 1[K_tr = k] over targets seen, renormalised by Σ_seen w_t
//               (deterministic runs fill top-down and are not renormalised while partial:
//               the unresolved games sit below the settled rows)
//   mean      = weighted mean of n_guesses (a failure counts max guesses)
//   sd        = weighted standard deviation of n_guesses over games
//   median, p95 = weighted quantiles of K with X = max + 1 (smallest k with cumulative share ≥ q)
//   share_se_k = sd_r(p_k^(r)) / √R, se_mean = sd_r(mean^(r)) / √R  (stochastic only)
//   band      = share ± 1.96 √((1 − n/N) s² / n) while the first replicate pass is incomplete
//               (s² the sample variance of the per-target indicator), then share ± 1.96 share_se;
//               collapsed to the share once complete.

import type { Game, ProgressEvent } from '../backend/types';
import type { CardSnapshot } from './types';

/** z for a two-sided 95% interval (as wl_engine::card::Z95). */
export const Z95 = 1.96;
/** Tolerance for cumulative shares in quantiles (as wl_engine::card::QUANTILE_EPS). */
export const QUANTILE_EPS = 1e-9;

export class CardAccumulator {
  version = 0;
  readonly rows: number;
  /** Normalised weights (sum 1 over all targets). */
  private w: Float64Array;
  /** Per target × row game counts. */
  private cnt: Float64Array;
  /** Per target game count (R_t). */
  private rt: Uint32Array;
  private sumN: Float64Array;
  private seenTargets = 0;
  private nGames = 0;
  private maxDepthSeen = 0;
  /** Per replicate: weighted row counts, weight sum, weighted n_guesses sum, targets seen. */
  private repRows: Float64Array[] = [];
  private repW: number[] = [];
  private repSumN: number[] = [];
  private repTargets: number[] = [];
  private complete = false;
  private settledDepthP: number | undefined;
  private unresolvedP: number | undefined;
  private totalP = 0;

  /**
   * @param nTargets number of targets in scope
   * @param weights per-answer-index weights (null = equal)
   */
  constructor(
    public maxGuesses: number,
    public nTargets: number,
    public deterministic: boolean,
    public replicates: number,
    public weights: Float64Array | null = null,
  ) {
    this.rows = maxGuesses + 1;
    this.w = new Float64Array(nTargets);
    if (weights && weights.length >= nTargets) {
      let total = 0;
      for (let t = 0; t < nTargets; t++) total += weights[t];
      for (let t = 0; t < nTargets; t++) this.w[t] = total > 0 ? weights[t] / total : 1 / nTargets;
    } else this.w.fill(1 / Math.max(1, nTargets));
    this.cnt = new Float64Array(nTargets * this.rows);
    this.rt = new Uint32Array(nTargets);
    this.sumN = new Float64Array(nTargets);
  }

  /** Outcome row of a game: k − 1 for solved in k, maxGuesses for X. */
  rowOf(g: Game): number {
    if (!g.solved) return this.maxGuesses;
    return Math.min(Math.max(g.turns.length, 1), this.maxGuesses) - 1;
  }

  ingest(games: Game[]): void {
    let changed = false;
    for (const g of games) {
      if (g.isPlayer) continue;
      const t = g.target;
      if (t < 0 || t >= this.nTargets) continue;
      const row = this.rowOf(g);
      const n = g.turns.length;
      if (this.rt[t] === 0) this.seenTargets++;
      this.rt[t]++;
      this.cnt[t * this.rows + row]++;
      this.sumN[t] += n;
      this.nGames++;
      if (n > this.maxDepthSeen) this.maxDepthSeen = n;
      const r = g.replicate;
      while (this.repRows.length <= r) {
        this.repRows.push(new Float64Array(this.rows));
        this.repW.push(0);
        this.repSumN.push(0);
        this.repTargets.push(0);
      }
      const w = this.w[t];
      this.repRows[r][row] += w;
      this.repW[r] += w;
      this.repSumN[r] += w * n;
      this.repTargets[r]++;
      changed = true;
    }
    if (changed) this.version++;
  }

  progress(p: ProgressEvent): void {
    if (p.settledDepth !== undefined) this.settledDepthP = p.settledDepth;
    if (p.unresolved !== undefined) this.unresolvedP = p.unresolved;
    if (p.total > 0) this.totalP = p.total;
    this.version++;
  }

  markComplete(): void {
    if (this.complete) return;
    this.complete = true;
    this.version++;
  }

  get isComplete(): boolean {
    return this.complete || (this.nTargets > 0 && this.nGames >= this.nTargets * this.expectedReplicates());
  }

  private expectedReplicates(): number {
    return this.deterministic ? 1 : Math.max(1, this.replicates);
  }

  /** Replicates with at least one game. */
  private liveReplicates(): number[] {
    const out: number[] = [];
    for (let r = 0; r < this.repW.length; r++) if (this.repW[r] > 0) out.push(r);
    return out;
  }

  snapshot(): CardSnapshot {
    const rows = this.rows;
    const N = this.nTargets;
    const complete = this.isComplete;
    const counts = new Array<number>(rows).fill(0);
    const est = new Array<number>(rows).fill(0); // Σ_seen w_t y_tk
    let W = 0;
    let meanNum = 0;
    const g = (k: number) => Math.min(k + 1, this.maxGuesses);
    for (let t = 0; t < N; t++) {
      const R = this.rt[t];
      if (!R) continue;
      const w = this.w[t];
      W += w;
      let guesses = 0;
      for (let k = 0; k < rows; k++) {
        const c = this.cnt[t * rows + k];
        if (!c) continue;
        est[k] += (w * c) / R;
        counts[k] += c * w * N;
        guesses += c * g(k);
      }
      meanNum += (w * guesses) / R;
    }
    const hasGames = W > 0;
    // Renormalised estimate (sums to 1 over seen targets).
    const renorm = est.map((v) => (hasGames ? v / W : 0));
    const topDown = this.deterministic && !complete;
    const shares = topDown ? est.slice() : renorm;

    const mean = hasGames ? meanNum / W : NaN;
    // Weighted population standard deviation over games (two passes, as the Rust card).
    let sd = NaN;
    if (hasGames) {
      let v = 0;
      for (let t = 0; t < N; t++) {
        const R = this.rt[t];
        if (!R) continue;
        const wr = this.w[t] / R;
        for (let k = 0; k < rows; k++) {
          const c = this.cnt[t * rows + k];
          if (!c) continue;
          const d = g(k) - mean;
          v += wr * c * d * d;
        }
      }
      sd = Math.sqrt(v / W);
    }

    // Quantiles over the renormalised distribution, X counted as max + 1.
    const quantile = (q: number): number => {
      if (!hasGames) return NaN;
      let cum = 0;
      for (let k = 0; k < rows; k++) {
        cum += renorm[k];
        if (cum >= q - QUANTILE_EPS) return k + 1;
      }
      return rows;
    };

    // Replicate standard errors (stochastic).
    let shareSeAll: number[] | null = null;
    let meanSe: number | null = null;
    if (!this.deterministic) {
      const reps = this.liveReplicates();
      const R = reps.length;
      if (R >= 2) {
        shareSeAll = [];
        for (let k = 0; k < rows; k++) {
          const xs = reps.map((r) => this.repRows[r][k] / this.repW[r]);
          shareSeAll.push(sampleSd(xs) / Math.sqrt(R));
        }
        const ms = reps.map((r) => this.repSumN[r] / this.repW[r]);
        meanSe = sampleSd(ms) / Math.sqrt(R);
      }
    }

    // Bands.
    const bands: [number, number][] = [];
    const firstPassDone = this.seenTargets >= N;
    for (let k = 0; k < rows; k++) {
      const s = shares[k];
      if (this.deterministic || complete || !hasGames) {
        bands.push([s, s]);
        continue;
      }
      let half: number;
      if (!firstPassDone) {
        const n = this.seenTargets;
        if (n < 2) {
          bands.push([0, 1]);
          continue;
        }
        // s² is the (weighted) sample variance of the per-target indicator, as the Rust card.
        const sk = renorm[k];
        let ss = 0;
        for (let t = 0; t < N; t++) {
          const R = this.rt[t];
          if (!R) continue;
          const y = this.cnt[t * rows + k] / R;
          ss += this.w[t] * (y - sk) * (y - sk);
        }
        const s2 = ((ss / W) * n) / (n - 1);
        const fpc = 1 - n / N;
        half = Z95 * Math.sqrt(Math.max(0, (fpc * s2) / n));
      } else {
        half = shareSeAll ? Z95 * shareSeAll[k] : 0;
      }
      bands.push([Math.max(0, s - half), Math.min(1, s + half)]);
    }

    const solveRate = !hasGames ? NaN : topDown ? shares.slice(0, rows - 1).reduce((a, b) => a + b, 0) : 1 - renorm[rows - 1];
    let settledDepth: number | undefined;
    let unresolved: number | undefined;
    if (this.deterministic) {
      settledDepth = complete ? this.maxGuesses : Math.max(this.settledDepthP ?? 0, this.maxDepthSeen - 1, 0);
      unresolved = complete ? 0 : (this.unresolvedP ?? Math.max(0, N - this.seenTargets));
    }
    return {
      maxGuesses: this.maxGuesses,
      counts,
      shares,
      bands,
      shareSe: !this.deterministic && complete ? shareSeAll : null,
      mean,
      meanSe: this.deterministic ? null : meanSe,
      sd,
      median: quantile(0.5),
      p95: quantile(0.95),
      solveRate,
      nGames: this.nGames,
      nTargetsDone: this.seenTargets,
      nTargets: N,
      nGamesTotal: this.totalP || N * this.expectedReplicates(),
      complete,
      deterministic: this.deterministic,
      settledDepth,
      unresolved,
    };
  }

  /** Number of targets with at least one game. */
  get targetsSeen(): number {
    return this.seenTargets;
  }

  /** Games ingested. */
  get gameCount(): number {
    return this.nGames;
  }

  /** Games seen for a target (R_t). */
  targetReplicates(t: number): number {
    return this.rt[t] ?? 0;
  }

  /** Row counts of one target (length maxGuesses + 1). */
  targetCounts(t: number): number[] {
    return Array.from(this.cnt.subarray(t * this.rows, (t + 1) * this.rows));
  }

  /** Normalised weight of a target. */
  weight(t: number): number {
    return this.w[t];
  }

  /** Per-target mean guesses (NaN for unseen targets), for sorting and paired comparisons. */
  targetMeans(): Float64Array {
    const out = new Float64Array(this.nTargets);
    for (let t = 0; t < this.nTargets; t++) out[t] = this.rt[t] ? this.sumN[t] / this.rt[t] : NaN;
    return out;
  }

  /** Per-target failure rate (NaN for unseen). */
  targetFailRates(): Float64Array {
    const out = new Float64Array(this.nTargets);
    const x = this.rows - 1;
    for (let t = 0; t < this.nTargets; t++) out[t] = this.rt[t] ? this.cnt[t * this.rows + x] / this.rt[t] : NaN;
    return out;
  }

  /** Per-target share solved in three or fewer (NaN for unseen). */
  targetLe3(): Float64Array {
    const out = new Float64Array(this.nTargets);
    const upto = Math.min(3, this.maxGuesses);
    for (let t = 0; t < this.nTargets; t++) {
      if (!this.rt[t]) {
        out[t] = NaN;
        continue;
      }
      let c = 0;
      for (let k = 0; k < upto; k++) c += this.cnt[t * this.rows + k];
      out[t] = c / this.rt[t];
    }
    return out;
  }

  /** Per-target mean with a failure counted as max guesses + 1 (NaN for unseen). */
  targetMeansFailPlus(): Float64Array {
    const out = this.targetMeans();
    const fails = this.targetFailRates();
    for (let t = 0; t < this.nTargets; t++) if (!Number.isNaN(out[t])) out[t] += fails[t];
    return out;
  }

  /** Per-replicate mean guesses (NaN for replicates without games). */
  replicateMeans(): number[] {
    return this.repW.map((w, r) => (w > 0 ? this.repSumN[r] / w : NaN));
  }

  /** Per-replicate row shares. */
  replicateShares(): number[][] {
    return this.repRows.map((row, r) => Array.from(row, (v) => (this.repW[r] > 0 ? v / this.repW[r] : NaN)));
  }
}

/** Sample standard deviation (n − 1 denominator); 0 for fewer than two values. */
export function sampleSd(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  let m = 0;
  for (const x of xs) m += x;
  m /= n;
  let ss = 0;
  for (const x of xs) ss += (x - m) * (x - m);
  return Math.sqrt(ss / (n - 1));
}

// ---------------------------------------------------------------------------
// Exact card statistics, a line-by-line port of wl_engine::card (snapshot,
// RankMetric). Exports and rankings use these so the browser writes the same
// numbers as the CLI; the incremental CardAccumulator above drives the views.

/** A card as the Rust engine computes it (see crates/wl-engine/src/card.rs). */
export interface CardStats {
  maxGuesses: number;
  /** Raw game counts per row. */
  counts: number[];
  /** Weighted share per row, renormalised over the targets seen. */
  shares: number[];
  bands: [number, number][];
  /** Standard error per row across replicates (stochastic, at least 2 replicates). */
  shareSe: number[] | null;
  mean: number;
  meanSe: number | null;
  sd: number;
  median: number;
  p95: number;
  solveRate: number;
  nGames: number;
  nTargetsSeen: number;
  nTargets: number;
  deterministic: boolean;
  /** Per-replicate cards: replicate, shares, mean. */
  replicateCards: { replicate: number; shares: number[]; mean: number }[];
}

/**
 * Raw card weights per answer index as the Rust engine uses them: 1 for equal
 * weighting, `10^zipf` for frequency weighting (cards normalise over the
 * targets seen, so the weights need not sum to 1).
 */
export function rawTargetWeights(zipfOfAnswer: ArrayLike<number> | null, nAnswers: number, weighting: 'equal' | 'frequency'): Float64Array {
  const w = new Float64Array(nAnswers).fill(1);
  if (weighting === 'frequency' && zipfOfAnswer) for (let a = 0; a < nAnswers; a++) w[a] = Math.pow(10, zipfOfAnswer[a] ?? 0);
  return w;
}

function outcomeRow(g: Game, maxGuesses: number): number {
  if (!g.solved) return maxGuesses;
  return Math.min(Math.max(g.turns.length, 1) - 1, maxGuesses - 1);
}

function exactQuantile(shares: number[], q: number): number {
  let cum = 0;
  for (let k = 0; k < shares.length; k++) {
    cum += shares[k];
    if (cum >= q - QUANTILE_EPS) return k + 1;
  }
  return shares.length;
}

/** Sample sd as the Rust helper (n − 1 denominator; NaN below two values). */
function rustSampleSd(xs: number[]): number {
  const n = xs.length;
  let sum = 0;
  for (const x of xs) sum += x;
  const mean = sum / n;
  let ss = 0;
  for (const x of xs) ss += (x - mean) * (x - mean);
  return Math.sqrt(ss / (n - 1));
}

/**
 * The card of a set of games (player games skipped), computed exactly as
 * `wl_engine::card::CardAccumulator::snapshot`: from outcomes sorted by
 * (target, replicate), so it does not depend on arrival order.
 * `weights` holds one weight per answer index (missing = 1).
 */
export function cardStats(
  games: readonly Game[],
  maxGuesses: number,
  nTargets: number,
  deterministic: boolean,
  weights: ArrayLike<number> | null = null,
): CardStats {
  const recs: [number, number, number][] = [];
  for (const g of games) if (!g.isPlayer) recs.push([g.target, g.replicate, outcomeRow(g, maxGuesses)]);
  return cardFromRecords(recs, maxGuesses, nTargets, deterministic, weights);
}

/** A game's outcome record for cardFromRecords: [answer index, replicate, outcome row]. */
export function outcomeRecord(g: Game, maxGuesses: number): [number, number, number] {
  return [g.target, g.replicate, outcomeRow(g, maxGuesses)];
}

/** cardStats from outcome records [target, replicate, row] (any order; sorted here). */
export function cardFromRecords(
  records: [number, number, number][],
  maxGuesses: number,
  nTargets: number,
  deterministic: boolean,
  weights: ArrayLike<number> | null = null,
): CardStats {
  const m = maxGuesses;
  const rows = m + 1;
  const recs = records.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const weight = (t: number) => (weights && t < weights.length && weights[t] !== undefined ? weights[t] : 1);
  const rowGuesses = (k: number) => Math.min(k + 1, m);

  const targets: { t: number; c: number[] }[] = [];
  for (const [t, , k] of recs) {
    if (!targets.length || targets[targets.length - 1].t !== t) targets.push({ t, c: new Array(rows).fill(0) });
    targets[targets.length - 1].c[k]++;
  }
  const counts = new Array<number>(rows).fill(0);
  const shares = new Array<number>(rows).fill(0);
  let wTotal = 0;
  let mean = 0;
  for (const { t, c } of targets) {
    const w = weight(t);
    let rt = 0;
    for (const x of c) rt += x;
    wTotal += w;
    let guesses = 0;
    for (let k = 0; k < rows; k++) {
      counts[k] += c[k];
      shares[k] += (w * c[k]) / rt;
      guesses += c[k] * rowGuesses(k);
    }
    mean += (w * guesses) / rt;
  }
  const nSeen = targets.length;
  let sd = NaN;
  if (nSeen === 0) mean = NaN;
  else {
    for (let k = 0; k < rows; k++) shares[k] /= wTotal;
    mean /= wTotal;
    let v = 0;
    for (const { t, c } of targets) {
      let rt = 0;
      for (const x of c) rt += x;
      const w = weight(t) / rt;
      for (let k = 0; k < rows; k++) {
        const d = rowGuesses(k) - mean;
        v += w * c[k] * d * d;
      }
    }
    sd = Math.sqrt(v / wTotal);
  }
  const median = nSeen === 0 ? NaN : exactQuantile(shares, 0.5);
  const p95 = nSeen === 0 ? NaN : exactQuantile(shares, 0.95);
  const solveRate = nSeen === 0 ? NaN : 1 - shares[m];

  // Per replicate: the card of replicate r alone (replicates in ascending order).
  const perRep = new Map<number, { wk: number[]; w: number; wn: number }>();
  for (const [t, r, k] of recs) {
    const w = weight(t);
    let e = perRep.get(r);
    if (!e) perRep.set(r, (e = { wk: new Array(rows).fill(0), w: 0, wn: 0 }));
    e.wk[k] += w;
    e.w += w;
    e.wn += w * rowGuesses(k);
  }
  const replicateCards = [...perRep.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([replicate, e]) => ({ replicate, shares: e.wk.map((x) => x / e.w), mean: e.wn / e.w }));
  const nReps = replicateCards.length;
  let shareSe: number[] | null = null;
  let meanSe: number | null = null;
  if (!deterministic && nReps >= 2) {
    const se = (xs: number[]) => rustSampleSd(xs) / Math.sqrt(nReps);
    shareSe = [];
    for (let k = 0; k < rows; k++) shareSe.push(se(replicateCards.map((c) => c.shares[k])));
    meanSe = se(replicateCards.map((c) => c.mean));
  }

  const bands: [number, number][] = [];
  for (let k = 0; k < rows; k++) {
    const s = shares[k];
    let half: number;
    if (deterministic || nSeen === 0) half = 0;
    else if (nSeen < nTargets) {
      if (nSeen < 2) half = Infinity;
      else {
        const n = nSeen;
        let ss = 0;
        for (const { t, c } of targets) {
          let rt = 0;
          for (const x of c) rt += x;
          const x = c[k] / rt;
          ss += weight(t) * (x - s) * (x - s);
        }
        const s2 = ((ss / wTotal) * n) / (n - 1);
        const fpc = 1 - n / nTargets;
        half = Z95 * Math.sqrt((fpc * s2) / n);
      }
    } else half = shareSe ? Z95 * shareSe[k] : 0;
    bands.push([Math.max(s - half, 0), Math.min(s + half, 1)]);
  }

  return {
    maxGuesses: m,
    counts,
    shares,
    bands,
    shareSe,
    mean,
    meanSe,
    sd,
    median,
    p95,
    solveRate,
    nGames: recs.length,
    nTargetsSeen: nSeen,
    nTargets,
    deterministic,
    replicateCards,
  };
}

export type RankMetricKind = 'mean' | 'fail_rate' | 'le3' | 'mean_fail_plus';

/** A ranking metric from a card's shares and mean (as RankMetric::of). */
export function metricOf(metric: RankMetricKind, shares: number[], mean: number): number {
  const m = shares.length - 1;
  switch (metric) {
    case 'mean':
      return mean;
    case 'fail_rate':
      return shares[m];
    case 'le3': {
      let s = 0;
      for (let k = 0; k < Math.min(m, 3); k++) s += shares[k];
      return s;
    }
    case 'mean_fail_plus': {
      let s = 0;
      for (let k = 0; k < shares.length; k++) s += (k + 1) * shares[k];
      return s;
    }
  }
}

/**
 * A metric's value with a 95% interval: ± 1.96 times the standard error
 * across replicate cards (the value itself when exact), as RankMetric::value.
 */
export function metricValue(metric: RankMetricKind, card: CardStats): [number, number, number] {
  const v = metricOf(metric, card.shares, card.mean);
  const n = card.replicateCards.length;
  if (card.deterministic || n < 2) return [v, v, v];
  const per = card.replicateCards.map((c) => metricOf(metric, c.shares, c.mean));
  const half = (Z95 * rustSampleSd(per)) / Math.sqrt(n);
  return [v, v - half, v + half];
}

/** Mean guesses per target over its strategy games (player games skipped), as target_means. */
export function targetMeans(games: readonly Game[]): Map<number, number> {
  const acc = new Map<number, [number, number]>();
  for (const g of games) {
    if (g.isPlayer) continue;
    const e = acc.get(g.target);
    if (e) {
      e[0] += g.turns.length;
      e[1]++;
    } else acc.set(g.target, [g.turns.length, 1]);
  }
  const out = new Map<number, number>();
  for (const t of [...acc.keys()].sort((a, b) => a - b)) {
    const [s, n] = acc.get(t)!;
    out.set(t, s / n);
  }
  return out;
}

/** One row of paired.csv. */
export interface PairRow {
  target: number;
  meanA: number;
  meanB: number;
  diff: number;
}

/** Target-by-target comparison over the targets both have played, in answer order (as pair_rows). */
export function pairRows(a: readonly Game[], b: readonly Game[]): PairRow[] {
  const ma = targetMeans(a);
  const mb = targetMeans(b);
  const out: PairRow[] = [];
  for (const [t, x] of ma) {
    const y = mb.get(t);
    if (y !== undefined) out.push({ target: t, meanA: x, meanB: y, diff: x - y });
  }
  return out;
}
