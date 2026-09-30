// Compare mode: target-by-target pairing of two cards. Owned by the platform agent.
//
// Games are indexed by (target, replicate), so two configurations compare
// target by target: per target, the mean guesses over its replicates (a
// failure counts max guesses), and diff = mean_a − mean_b (as paired.csv).
// A "wins" a target when its mean is lower.

import type { Game } from '../backend/types';
import { cardStats, pairRows } from './card';
import type { Run } from './types';

export interface Comparison {
  distA: number[];
  distB: number[];
  /** Per-target mean difference A − B (NaN where either is missing). */
  diffs: Float64Array;
  wins: number;
  ties: number;
  losses: number;
  /** Answer indices with the largest |diff|, largest first. */
  largest: number[];
  meanDiff: number;
  meanDiffSe: number;
}

/** Differences smaller than this count as ties. */
export const TIE_EPS = 1e-9;
/** How many targets `largest` lists by default. */
export const LARGEST_N = 20;

export interface CompareOptions {
  /** Per-answer-index weights for the distributions (null = equal). */
  weightsA?: ArrayLike<number> | null;
  weightsB?: ArrayLike<number> | null;
  deterministicA?: boolean;
  deterministicB?: boolean;
  largestN?: number;
}

/** Compare two sets of games target by target. */
export function compareGames(a: readonly Game[], b: readonly Game[], nTargets: number, maxGuesses: number, opts: CompareOptions = {}): Comparison {
  const distA = cardStats(a, maxGuesses, nTargets, opts.deterministicA ?? false, opts.weightsA ?? null).shares;
  const distB = cardStats(b, maxGuesses, nTargets, opts.deterministicB ?? false, opts.weightsB ?? null).shares;
  const diffs = new Float64Array(nTargets).fill(NaN);
  let wins = 0;
  let ties = 0;
  let losses = 0;
  const paired: number[] = [];
  for (const r of pairRows(a, b)) {
    if (r.target < 0 || r.target >= nTargets) continue;
    diffs[r.target] = r.diff;
    paired.push(r.target);
    if (Math.abs(r.diff) <= TIE_EPS) ties++;
    else if (r.diff < 0) wins++;
    else losses++;
  }
  const n = paired.length;
  let meanDiff = NaN;
  let meanDiffSe = NaN;
  if (n > 0) {
    let s = 0;
    for (const t of paired) s += diffs[t];
    meanDiff = s / n;
    if (n > 1) {
      let ss = 0;
      for (const t of paired) ss += (diffs[t] - meanDiff) ** 2;
      meanDiffSe = Math.sqrt(ss / (n - 1)) / Math.sqrt(n);
    }
  }
  const largest = paired
    .filter((t) => Math.abs(diffs[t]) > TIE_EPS)
    .sort((x, y) => Math.abs(diffs[y]) - Math.abs(diffs[x]) || x - y)
    .slice(0, opts.largestN ?? LARGEST_N);
  return { distA, distB, diffs, wins, ties, losses, largest, meanDiff, meanDiffSe };
}

/** Compare two runs (cards) target by target. */
export function compareRuns(a: Run, b: Run, nTargets: number, maxGuesses: number, opts: CompareOptions = {}): Comparison {
  return compareGames(a.games, b.games, nTargets, maxGuesses, {
    deterministicA: a.deterministic,
    deterministicB: b.deterministic,
    ...opts,
  });
}

/** Histogram of per-target differences: bin edges and counts over the finite diffs. */
export function diffHistogram(diffs: ArrayLike<number>, binWidth = 0.25): { edges: number[]; counts: number[] } {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < diffs.length; i++) {
    const d = diffs[i];
    if (!Number.isFinite(d)) continue;
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  if (!Number.isFinite(lo)) return { edges: [], counts: [] };
  const start = Math.floor(lo / binWidth - 0.5) * binWidth + binWidth / 2;
  const nb = Math.max(1, Math.ceil((hi - start) / binWidth + 1e-9));
  const counts = new Array<number>(nb).fill(0);
  for (let i = 0; i < diffs.length; i++) {
    const d = diffs[i];
    if (!Number.isFinite(d)) continue;
    counts[Math.min(nb - 1, Math.max(0, Math.floor((d - start) / binWidth)))]++;
  }
  const edges = Array.from({ length: nb + 1 }, (_, i) => start + i * binWidth);
  return { edges, counts };
}
