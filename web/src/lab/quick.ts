// Quick check: a mini card from a small sampled run (pure, unit-tested).
import type { Game } from '../backend/types';

export const QUICK_TARGETS = 200;
export const QUICK_REPLICATES = 5;

export interface MiniCard {
  /** Estimated share of games per row: index k-1 for "solved in k", last for X. */
  shares: number[];
  /** Mean guesses (a failure counts max guesses). */
  mean: number;
  solveRate: number;
  nGames: number;
  nTargets: number;
}

/**
 * A mini card from games: each target's games are averaged first, then targets
 * are combined with their weights (equal when `weightOf` is absent), so the
 * estimate stays unbiased while replicates arrive unevenly.
 */
export function miniCard(games: readonly Game[], maxGuesses: number, weightOf?: (target: number) => number): MiniCard {
  const rows = maxGuesses + 1;
  const per = new Map<number, { counts: number[]; n: number; sum: number }>();
  let nGames = 0;
  for (const g of games) {
    if (g.isPlayer) continue;
    let t = per.get(g.target);
    if (!t) {
      t = { counts: new Array(rows).fill(0), n: 0, sum: 0 };
      per.set(g.target, t);
    }
    const k = g.turns.length;
    const row = g.solved ? Math.min(Math.max(k, 1), maxGuesses) - 1 : maxGuesses;
    t.counts[row]++;
    t.n++;
    t.sum += Math.min(k, maxGuesses);
    nGames++;
  }
  const shares = new Array(rows).fill(0);
  let wSum = 0;
  let mean = 0;
  for (const [target, t] of per) {
    const w = weightOf ? Math.max(0, weightOf(target)) : 1;
    if (!(w > 0)) continue;
    wSum += w;
    for (let r = 0; r < rows; r++) shares[r] += (w * t.counts[r]) / t.n;
    mean += (w * t.sum) / t.n;
  }
  if (wSum > 0) {
    for (let r = 0; r < rows; r++) shares[r] /= wSum;
    mean /= wSum;
  } else mean = NaN;
  return { shares, mean, solveRate: wSum > 0 ? 1 - shares[maxGuesses] : NaN, nGames, nTargets: per.size };
}
