// Compare mode: target-by-target pairing of two cards. Owned by the platform agent.
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

export function compareRuns(a: Run, b: Run, nTargets: number, maxGuesses: number): Comparison {
  throw new Error('not implemented');
}
