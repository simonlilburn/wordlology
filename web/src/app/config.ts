// Building configurations from the current settings. Owned by the platform agent.
import type { Config, StrategySpec } from '../backend/types';

export interface MakeConfigOptions {
  strategy: StrategySpec;
  opener: string | null;
  /** 'tree' uses the Tree view replicate count, 'card' the card/atlas count. */
  kind: 'tree' | 'card';
  /** Override replicates (e.g. Quick check). */
  replicates?: number;
}

/** A configuration from the store's result settings. */
export function makeConfig(opts: MakeConfigOptions): Config {
  throw new Error('not implemented');
}

/** Whether a spec is deterministic (mirrors Strategy::is_deterministic). */
export function isDeterministicSpec(spec: StrategySpec): boolean {
  throw new Error('not implemented');
}

/** A short human label for a spec, e.g. "Info-proportional β=1". */
export function specLabel(spec: StrategySpec): string {
  throw new Error('not implemented');
}
