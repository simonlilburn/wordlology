// Card statistics from games. Owned by the platform agent. Formulas: docs/architecture.md.
import type { Game, ProgressEvent } from '../backend/types';
import type { CardSnapshot } from './types';

export class CardAccumulator {
  version = 0;
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
  ) {}
  ingest(games: Game[]): void {}
  progress(p: ProgressEvent): void {}
  markComplete(): void {}
  snapshot(): CardSnapshot {
    throw new Error('not implemented');
  }
  /** Per-target mean guesses (NaN for unseen targets), for sorting and paired comparisons. */
  targetMeans(): Float64Array {
    return new Float64Array(this.nTargets).fill(NaN);
  }
  /** Per-target failure rate (NaN for unseen). */
  targetFailRates(): Float64Array {
    return new Float64Array(this.nTargets).fill(NaN);
  }
}
