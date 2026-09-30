import { describe, expect, it } from 'vitest';
import { binDiffs, largestDiffs, niceStep, winTieLoss } from './histogram';
import { dropIndex, meanOf, moveItem, sortByMean } from './order';
import { fmtEntryValue, fmtMetric, isScreenedOut, rankingCsv, ReorderThrottle, roundProgress, tieBrackets } from './ranking';

describe('difference histogram', () => {
  it('bins integer differences one per integer, centred on 0', () => {
    const h = binDiffs([-2, -1, -1, 0, 0, 0, 1, NaN]);
    expect(h.n).toBe(7);
    expect(h.binWidth).toBe(1);
    expect(h.counts[h.zeroBin]).toBe(3);
    expect(h.edges[h.zeroBin]).toBe(-0.5);
    expect(h.edges[h.zeroBin + 1]).toBe(0.5);
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(7);
    expect(h.max).toBe(3);
  });

  it('uses nice widths for fractional differences and caps the bin count', () => {
    const vals = Array.from({ length: 1000 }, (_, i) => Math.sin(i) * 3.3);
    const h = binDiffs(vals, 21);
    expect(h.counts.length).toBeLessThanOrEqual(21);
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(1000);
    expect([1, 2, 2.5, 5].some((m) => Math.abs(h.binWidth / Math.pow(10, Math.floor(Math.log10(h.binWidth))) - m) < 1e-9)).toBe(true);
    // Zero is a bin centre.
    expect((h.edges[h.zeroBin] + h.edges[h.zeroBin + 1]) / 2).toBeCloseTo(0, 9);
  });

  it('handles empty input', () => {
    const h = binDiffs([NaN]);
    expect(h.n).toBe(0);
    expect(h.counts).toEqual([0]);
  });

  it('rounds steps up to 1, 2, 2.5, 5 × 10^k', () => {
    expect(niceStep(0.13)).toBeCloseTo(0.2, 12);
    expect(niceStep(2.2)).toBe(2.5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(0)).toBe(1);
  });

  it('counts wins, ties and losses for A (fewer guesses is a win)', () => {
    expect(winTieLoss([-1, -0.5, 0, 0, 2, NaN])).toEqual({ wins: 2, ties: 2, losses: 1 });
  });

  it('lists the targets with the largest differences', () => {
    expect(largestDiffs([0.5, -3, 0, 2, NaN, -2], 3)).toEqual([1, 3, 5]);
  });
});

describe('arranging the grid', () => {
  it('moves items', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveItem(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b'], 0, 9)).toEqual(['b', 'a']);
  });

  it('sorts rows by mean, best first, unknown last', () => {
    expect(sortByMean(['a', 'b', 'c', 'd'], [3.9, NaN, 3.5, 3.7])).toEqual(['c', 'd', 'a', 'b']);
    expect(sortByMean([null, 'x'], [4, 3])).toEqual(['x', null]);
  });

  it('computes drop indices from drag offsets', () => {
    expect(dropIndex(1, 430, 424, 4)).toBe(2);
    expect(dropIndex(1, -1000, 424, 4)).toBe(0);
    expect(dropIndex(1, 100, 424, 4)).toBe(1);
    expect(dropIndex(0, 5000, 424, 4)).toBe(3);
  });

  it('averages finite values', () => {
    expect(meanOf([1, 2, NaN, 3])).toBe(2);
    expect(meanOf([NaN])).toBeNaN();
  });
});

describe('ranking panel helpers', () => {
  it('reorders at most twice a second', () => {
    const t = new ReorderThrottle(500);
    expect(t.offer(['a', 'b', 'c'], 0).order).toEqual(['a', 'b', 'c']);
    // The first reorder applies at once...
    expect(t.offer(['b', 'a', 'c'], 100).order).toEqual(['b', 'a', 'c']);
    // ...the next one within 500 ms is held back...
    const r = t.offer(['a', 'b', 'c'], 300);
    expect(r.order).toEqual(['b', 'a', 'c']);
    expect(r.pendingMs).toBe(300);
    // ...until the interval has passed.
    expect(t.offer(['a', 'b', 'c'], 600).order).toEqual(['a', 'b', 'c']);
    expect(t.offer(['c', 'b', 'a'], 700).order).toEqual(['a', 'b', 'c']);
    expect(t.offer(['c', 'b', 'a'], 1100).order).toEqual(['c', 'b', 'a']);
  });

  it('adds and drops entries at once without reordering the rest', () => {
    const t = new ReorderThrottle(500);
    t.offer(['a', 'b'], 0);
    t.offer(['b', 'a'], 600);
    const r = t.offer(['b', 'x', 'a'], 650);
    expect(r.order).toEqual(['b', 'a', 'x']);
    expect(t.offer(['a'], 700).order).toEqual(['a']);
  });

  it('brackets adjacent entries tied within noise', () => {
    expect(tieBrackets([-1, 0, 0, 0, -1, 1, 1, 2])).toEqual([null, 'start', 'mid', 'end', null, 'start', 'end', null]);
    expect(tieBrackets([])).toEqual([]);
  });

  it('formats metric values', () => {
    expect(fmtMetric('mean', 3.614)).toBe('3.61');
    expect(fmtMetric('mean', 3.614, true)).toBe('~3.6');
    expect(fmtMetric('fail_rate', 0.0123)).toBe('1.2%');
    expect(fmtMetric('le3', NaN)).toBe('–');
  });

  it('writes ranking.csv with the specified columns', () => {
    const csv = rankingCsv({
      id: 'r1',
      fixedKind: 'opener',
      fixedValue: 'crane',
      metric: 'mean',
      entries: [
        { key: 'max_info', label: 'Max', rank: 2, value: 3.6, ciLow: 3.55, ciHigh: 3.65, failRate: 0.01, distribution: [], stage: 'full', tieGroup: -1 },
        { key: 'a,b', label: 'A', rank: 1, value: 3.5, ciLow: NaN, ciHigh: NaN, failRate: 0, distribution: [], stage: 'screened', tieGroup: -1 },
      ],
    });
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('ranking_id,fixed_kind,fixed_value,entry,rank,metric,value,ci_low,ci_high,fail_rate,stage');
    expect(lines[1]).toBe('r1,opener,crane,"a,b",1,mean,3.5,NA,NA,0,screened');
    expect(lines[2]).toBe('r1,opener,crane,max_info,2,mean,3.6,3.55,3.65,0.01,full');
  });
});

describe('compare fallback', () => {
  it('pairs targets and summarises A − B', async () => {
    const { pairCards, pairedCount } = await import('./compare');
    const c = pairCards([3, 4, NaN, 5], [4, 4, 3, 2], [0.5, 0.5], [0.4, 0.6], 2);
    expect(Array.from(c.diffs).map((x) => (Number.isNaN(x) ? 'NA' : x))).toEqual([-1, 0, 'NA', 3]);
    expect([c.wins, c.ties, c.losses]).toEqual([1, 1, 1]);
    expect(c.largest).toEqual([3, 0]);
    expect(c.meanDiff).toBeCloseTo(2 / 3, 9);
    // sd of (-1, 0, 3) = sqrt(13/3 - ... ) → se = sd / sqrt(3)
    const sd = Math.sqrt(((-1 - 2 / 3) ** 2 + (0 - 2 / 3) ** 2 + (3 - 2 / 3) ** 2) / 2);
    expect(c.meanDiffSe).toBeCloseTo(sd / Math.sqrt(3), 9);
    expect(pairedCount(c.diffs)).toBe(3);
    expect(c.distA).toEqual([0.5, 0.5]);
  });
});

describe('ranking progress', () => {
  const e = (stage: 'full' | 'screened', round: number, provisional: boolean, scoreKind: 'mean' | 'info' = 'mean') => ({ stage, round, provisional, scoreKind });

  it('tells screened-out entries from those still in the running', () => {
    // Round 3 is running: candidates evaluated in round 2 are still in; round 1 was screened out.
    expect(isScreenedOut(e('screened', 2, true), 3, 'running')).toBe(false);
    expect(isScreenedOut(e('screened', 1, false), 3, 'running')).toBe(true);
    expect(isScreenedOut(e('full', 2, true), 3, 'running')).toBe(false);
    // Once done (or cancelled), every entry without a full card was screened.
    expect(isScreenedOut(e('screened', 2, false), 3, 'done')).toBe(true);
    expect(isScreenedOut(e('screened', 2, false), 3, 'cancelled')).toBe(true);
  });

  it('counts the candidates that finished the current round', () => {
    const entries = [e('screened', 1, false), e('screened', 1, true), e('screened', 1, true), e('screened', 0, false)];
    expect(roundProgress(entries, 2, 'running')).toEqual({ active: 3, done: 1 });
    expect(roundProgress(entries, 2, 'done')).toEqual({ active: 0, done: 0 });
  });

  it('formats one-step information in bits', () => {
    expect(fmtEntryValue('mean', { scoreKind: 'info', value: 5.8912 }, true)).toBe('5.89 bits');
    expect(fmtEntryValue('mean', { scoreKind: 'mean', value: 3.456 }, true)).toBe('~3.5');
    expect(fmtEntryValue('fail_rate', { scoreKind: 'fail_rate', value: 0.0123 }, false)).toBe('1.2%');
  });
});
