// Text for a card's distribution table (the Level 2 text alternative), from
// the same display values the card face draws, so both read alike.

import type { CardSnapshot } from '../../model/types';
import { displayFromSnapshot } from '../../scene/card/display';
import { fmtCount, fmtInt, fmtMean, fmtPercent, fmtQuantile, progressText, rowLongName } from '../../scene/card/format';

export interface DistributionRow {
  name: string;
  count: string;
  share: string;
  /** 95% interval while a stochastic card fills, or ± SE when complete; null otherwise. */
  interval: string | null;
  /** Numeric share (for bars). */
  value: number;
}

export interface CardSummary {
  rows: DistributionRow[];
  /** Deterministic partial runs: games still unresolved (hatched band), else null. */
  unresolved: string | null;
  mean: string;
  solved: string;
  p95: string;
  status: string;
  provisional: boolean;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export function summarise(s: CardSnapshot, replicates: number): CardSummary {
  const d = displayFromSnapshot(s, replicates);
  const provisional = !d.complete;
  const rows: DistributionRow[] = [];
  for (let i = 0; i < d.n; i++) {
    let interval: string | null = null;
    if (!s.deterministic) {
      if (!s.complete && d.hi[i] - d.lo[i] > 0) interval = `${pct(d.lo[i])} – ${pct(d.hi[i])}`;
      else if (s.complete && s.shareSe) interval = `± ${pct(1.96 * s.shareSe[i])}`;
    }
    const unsettled = s.deterministic && !s.complete && i >= d.bandTop;
    rows.push({
      name: rowLongName(i, d.maxGuesses),
      count: unsettled && d.counts[i] === 0 ? 'unresolved' : fmtCount(d.counts[i], provisional && !s.deterministic),
      share: unsettled && d.shares[i] === 0 ? '–' : fmtPercent(d.shares[i], provisional && !s.deterministic),
      interval,
      value: d.shares[i],
    });
  }
  const status = d.complete
    ? `${d.deterministic ? 'exact' : 'complete'} · ${fmtInt(d.nTargets)} targets · ${fmtInt(d.nGames)} games`
    : progressText(d);
  return {
    rows,
    unresolved: d.deterministic && !d.complete && d.unresolved > 0 ? `${fmtInt(d.unresolved)} games unresolved` : null,
    mean: fmtMean(s.nGames > 0 ? s.mean : NaN, s.deterministic ? null : s.meanSe, provisional),
    solved: fmtPercent(s.nGames > 0 ? s.solveRate : NaN, provisional),
    p95: fmtQuantile(s.nGames > 0 ? s.p95 : NaN, s.maxGuesses, provisional),
    status,
    provisional,
  };
}
