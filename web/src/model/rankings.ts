// Rankings by successive halving. Owned by the platform agent.
import type { StrategySpec } from '../backend/types';
import type { StrategyEntry } from '../app/store.svelte';

export type RankMetric = 'mean' | 'fail_rate' | 'le3' | 'mean_fail_plus';

export interface RankingEntry {
  /** Opener word, or strategy id. */
  key: string;
  label: string;
  colour?: string;
  spec?: StrategySpec;
  opener?: string | null;
  rank: number;
  value: number;
  ciLow: number;
  ciHigh: number;
  failRate: number;
  /** Seven-row (max guesses + X) mini distribution. */
  distribution: number[];
  stage: 'full' | 'screened';
  /** Index of the tie group ("tied within noise"), or -1. */
  tieGroup: number;
}

export interface Ranking {
  id: string;
  fixedKind: 'opener' | 'strategy';
  fixedValue: string;
  metric: RankMetric;
  round: number;
  rounds: number;
  entries: RankingEntry[];
  status: 'running' | 'done' | 'cancelled' | 'error';
  version: number;
  onChange(cb: () => void): () => void;
  cancel(): void;
}

/** Rank every strategy in `set` for a fixed opener (row ranking). */
export function rankStrategies(opener: string | null, set: StrategyEntry[]): Ranking {
  throw new Error('not implemented');
}

/** Rank openers for a fixed strategy (column ranking). */
export function rankOpeners(strategy: StrategyEntry, openers: string[] | null): Ranking {
  throw new Error('not implemented');
}
