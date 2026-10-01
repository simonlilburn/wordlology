// Compare mode fallback (pure): the target-by-target pairing of two cards from
// their per-target means, used while model/compare.ts is unavailable and to
// fill in fields it leaves out.

import type { Comparison } from '../../model/compare';
import { largestDiffs, winTieLoss } from './histogram';

/** Pair two cards target by target: diffs = A − B (NaN where either is missing). */
export function pairCards(meansA: ArrayLike<number>, meansB: ArrayLike<number>, distA: number[], distB: number[], top = 12): Comparison {
  const n = Math.min(meansA.length, meansB.length);
  const diffs = new Float64Array(n);
  let sum = 0, sum2 = 0, m = 0;
  for (let t = 0; t < n; t++) {
    const a = meansA[t], b = meansB[t];
    const d = Number.isFinite(a) && Number.isFinite(b) ? a - b : NaN;
    diffs[t] = d;
    if (Number.isFinite(d)) {
      sum += d;
      sum2 += d * d;
      m++;
    }
  }
  const meanDiff = m > 0 ? sum / m : NaN;
  const variance = m > 1 ? Math.max(0, (sum2 - m * meanDiff * meanDiff) / (m - 1)) : NaN;
  const { wins, ties, losses } = winTieLoss(diffs);
  return {
    distA: distA.slice(),
    distB: distB.slice(),
    diffs,
    wins,
    ties,
    losses,
    largest: largestDiffs(diffs, top),
    meanDiff,
    meanDiffSe: m > 1 ? Math.sqrt(variance / m) : NaN,
  };
}

/** Targets paired so far (both cards have played them). */
export function pairedCount(diffs: ArrayLike<number>): number {
  let n = 0;
  for (let i = 0; i < diffs.length; i++) if (Number.isFinite(diffs[i])) n++;
  return n;
}
