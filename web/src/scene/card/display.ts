// What a card face shows, derived from a CardSnapshot: displayed shares, 95%
// bands, counts, the deterministic hatched band, and the flags for provisional
// marks. Packed into a flat vector so springs can ease every number at once.

import type { CardSnapshot } from '../../model/types';

export interface CardDisplay {
  maxGuesses: number;
  /** Rows: guesses 1..maxGuesses and Out. */
  n: number;
  shares: number[];
  lo: number[];
  hi: number[];
  counts: number[];
  mean: number;
  meanSe: number | null;
  solveRate: number;
  p95: number;
  /** Deterministic partial runs: fraction of targets still unresolved (hatched band). */
  unresolvedFrac: number;
  unresolved: number;
  /** Row index where the hatched band starts (n when there is no band). */
  bandTop: number;
  complete: boolean;
  deterministic: boolean;
  /**
   * Mean, solve rate and p95 are lower bounds (a deterministic card filling
   * top-down: every unresolved game needs at least settledDepth + 1 guesses).
   */
  lowerBound: boolean;
  nTargetsDone: number;
  nTargets: number;
  nGames: number;
  expectedGames: number;
  settledDepth?: number;
}

export function emptyDisplay(maxGuesses: number, deterministic = false): CardDisplay {
  const n = maxGuesses + 1;
  return {
    maxGuesses,
    n,
    shares: new Array(n).fill(0),
    lo: new Array(n).fill(0),
    hi: new Array(n).fill(0),
    counts: new Array(n).fill(0),
    mean: NaN,
    meanSe: null,
    solveRate: NaN,
    p95: NaN,
    unresolvedFrac: deterministic ? 1 : 0,
    unresolved: 0,
    bandTop: deterministic ? 0 : n,
    complete: false,
    deterministic,
    lowerBound: false,
    nTargetsDone: 0,
    nTargets: 0,
    nGames: 0,
    expectedGames: 0,
  };
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const fin = (x: number, d = 0) => (Number.isFinite(x) ? x : d);

/** Display values for a snapshot; `replicates` is the configured R (for expected game counts). */
export function displayFromSnapshot(s: CardSnapshot, replicates: number): CardDisplay {
  const n = s.maxGuesses + 1;
  const R = s.deterministic ? 1 : Math.max(1, replicates);
  const expectedGames = s.nTargets * R;
  const d: CardDisplay = {
    ...emptyDisplay(s.maxGuesses, s.deterministic),
    mean: s.mean,
    meanSe: s.meanSe,
    solveRate: s.solveRate,
    p95: s.p95,
    complete: s.complete,
    nTargetsDone: s.nTargetsDone,
    nTargets: s.nTargets,
    nGames: s.nGames,
    expectedGames,
    settledDepth: s.settledDepth,
  };
  const shares = Array.from({ length: n }, (_, i) => clamp01(fin(s.shares[i])));
  if (s.deterministic && !s.complete) {
    // Rows fill top-down: the snapshot's shares are already fractions of
    // *all* targets (not renormalised), so settled rows have their final size
    // at once; the rest sits in the hatched band.
    const total = Math.max(1, s.nTargets);
    const unresolved = s.unresolved ?? Math.max(0, s.nTargets - s.nTargetsDone);
    const uf = clamp01(unresolved / total);
    d.unresolved = unresolved;
    d.unresolvedFrac = uf;
    d.shares = shares;
    d.lo = d.shares.slice();
    d.hi = d.shares.slice();
    d.counts = Array.from({ length: n }, (_, i) => fin(s.counts[i]));
    const settled = s.settledDepth ?? 0;
    d.bandTop = uf > 0 ? Math.max(0, Math.min(n, settled)) : n;
    const b = topDownBounds(shares, s.mean, settled, s.maxGuesses);
    d.mean = b.mean;
    d.solveRate = b.solveRate;
    d.p95 = b.p95;
    d.lowerBound = true;
    return d;
  }
  d.unresolvedFrac = 0;
  d.unresolved = 0;
  d.bandTop = n;
  d.shares = shares;
  d.lo = Array.from({ length: n }, (_, i) => clamp01(fin(s.bands?.[i]?.[0], shares[i])));
  d.hi = Array.from({ length: n }, (_, i) => clamp01(fin(s.bands?.[i]?.[1], shares[i])));
  d.counts = s.complete
    ? Array.from({ length: n }, (_, i) => fin(s.counts[i]))
    : shares.map((x) => x * expectedGames);
  return d;
}

/**
 * Lower bounds for a deterministic card filling top-down. `shares` are
 * fractions of all targets for the games settled so far (they sum to the
 * settled weight); the rest need at least settledDepth + 1 guesses.
 */
export function topDownBounds(
  shares: number[],
  meanSeen: number,
  settledDepth: number,
  maxGuesses: number,
): { mean: number; solveRate: number; p95: number } {
  let seen = 0;
  for (const x of shares) seen += x;
  seen = clamp01(seen);
  const rest = 1 - seen;
  const next = Math.min(maxGuesses, settledDepth + 1);
  const mean = seen > 0 && Number.isFinite(meanSeen) ? meanSeen * seen + rest * next : rest > 0 ? next : NaN;
  let solveRate = 0;
  for (let i = 0; i < Math.min(maxGuesses, shares.length); i++) solveRate += shares[i];
  // p95 with the unresolved mass at the earliest row it can still reach (X counts as max + 1).
  let cum = 0;
  let p95 = maxGuesses + 1;
  for (let k = 1; k <= maxGuesses + 1; k++) {
    cum += shares[k - 1] ?? 0;
    if (k === next + 0 && rest > 0) cum += rest;
    if (cum >= 0.95 - 1e-12) {
      p95 = k;
      break;
    }
  }
  return { mean, solveRate, p95 };
}

/** Layout of the spring vector. */
export function vectorLength(n: number): number {
  return 4 * n + 6;
}

export function packDisplay(d: CardDisplay): number[] {
  const v: number[] = [...d.shares, ...d.lo, ...d.hi, ...d.counts];
  v.push(fin(d.mean, 0), fin(d.solveRate, 0), fin(d.p95, 0), d.unresolvedFrac, d.bandTop, fin(d.meanSe ?? 0));
  return v;
}

/** Eased values back into a display (flags and totals from `latest`). */
export function unpackDisplay(v: ArrayLike<number>, latest: CardDisplay): CardDisplay {
  const n = latest.n;
  const slice = (k: number) => Array.from({ length: n }, (_, i) => v[k * n + i]);
  const o = 4 * n;
  return {
    ...latest,
    shares: slice(0),
    lo: slice(1),
    hi: slice(2),
    counts: slice(3),
    mean: Number.isFinite(latest.mean) ? v[o] : NaN,
    solveRate: Number.isFinite(latest.solveRate) ? v[o + 1] : NaN,
    p95: Number.isFinite(latest.p95) ? v[o + 2] : NaN,
    unresolvedFrac: v[o + 3],
    bandTop: v[o + 4],
    meanSe: latest.meanSe === null ? null : v[o + 5],
  };
}

/**
 * The median-difficulty target: the answer index whose mean guesses is the
 * median of the targets seen (ties go to the lower index). -1 when none seen.
 */
export function medianTarget(means: ArrayLike<number>): number {
  const idx: number[] = [];
  for (let i = 0; i < means.length; i++) if (Number.isFinite(means[i])) idx.push(i);
  if (idx.length === 0) return -1;
  idx.sort((a, b) => means[a] - means[b] || a - b);
  return idx[Math.floor((idx.length - 1) / 2)];
}
