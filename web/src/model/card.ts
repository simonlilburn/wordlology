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

const Z95 = 1.959963984540054;
const EPS = 1e-12;

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
  private sumN2: Float64Array;
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
    this.sumN2 = new Float64Array(nTargets);
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
      this.sumN2[t] += n * n;
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
    let sqNum = 0;
    for (let t = 0; t < N; t++) {
      const R = this.rt[t];
      if (!R) continue;
      const w = this.w[t];
      W += w;
      meanNum += (w * this.sumN[t]) / R;
      sqNum += (w * this.sumN2[t]) / R;
      for (let k = 0; k < rows; k++) {
        const c = this.cnt[t * rows + k];
        if (!c) continue;
        est[k] += (w * c) / R;
        counts[k] += c * w * N;
      }
    }
    const hasGames = W > 0;
    // Renormalised estimate (sums to 1 over seen targets).
    const renorm = est.map((v) => (hasGames ? v / W : 0));
    const topDown = this.deterministic && !complete;
    const shares = topDown ? est.slice() : renorm;

    const mean = hasGames ? meanNum / W : NaN;
    const sd = hasGames ? Math.sqrt(Math.max(0, sqNum / W - mean * mean)) : NaN;

    // Quantiles over the renormalised distribution, X counted as max + 1.
    const quantile = (q: number): number => {
      if (!hasGames) return NaN;
      let cum = 0;
      for (let k = 0; k < rows; k++) {
        cum += renorm[k];
        if (cum >= q - EPS) return k + 1;
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
        let ss = 0;
        for (let t = 0; t < N; t++) {
          const R = this.rt[t];
          if (!R) continue;
          const y = this.cnt[t * rows + k] / R;
          const w = this.w[t];
          ss += w * w * (y - s) * (y - s);
        }
        const v = (1 - n / N) * (n / (n - 1)) * (ss / (W * W));
        half = Z95 * Math.sqrt(Math.max(0, v));
      } else {
        half = shareSeAll ? Z95 * shareSeAll[k] : 0;
      }
      bands.push([Math.max(0, s - half), Math.min(1, s + half)]);
    }

    const solveRate = shares.slice(0, rows - 1).reduce((a, b) => a + b, 0);
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
