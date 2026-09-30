import { describe, expect, it } from 'vitest';
import { feedback } from '../../model/feedback';
import { consistentAnswers, expectedBits, fmtBits, fmtCount, fmtProb, turnStats } from './candidates';

const ANSWERS = ['crane', 'crate', 'trace', 'slate', 'caret', 'react', 'erase', 'reset', 'abide', 'bread', 'dread', 'tread'];
const row = (word: string, target: string) => ({ word, pattern: feedback(word, target) });

describe('consistentAnswers', () => {
  it('the target is always consistent with its own feedback', () => {
    for (const target of ANSWERS) {
      const history = ['slate', 'crane', 'abide'].map((w) => row(w, target));
      const cands = consistentAnswers(ANSWERS, history, feedback);
      expect(cands).toContain(target);
      for (const c of cands) for (const h of history) expect(feedback(h.word, c)).toBe(h.pattern);
    }
  });
  it('an empty history keeps every answer', () => {
    expect(consistentAnswers(ANSWERS, [], feedback)).toEqual(ANSWERS);
  });
  it('the solving guess leaves one candidate', () => {
    expect(consistentAnswers(ANSWERS, [row('bread', 'bread')], feedback)).toEqual(['bread']);
  });
});

describe('expectedBits', () => {
  it('is zero for one or no candidates', () => {
    expect(expectedBits('crane', ['crane'], feedback)).toBe(0);
    expect(expectedBits('crane', [], feedback)).toBe(0);
  });
  it('is log2 n when every candidate gives distinct feedback', () => {
    const cands = ['bread', 'dread', 'tread'];
    // DEBIT splits these three into three buckets.
    expect(new Set(cands.map((c) => feedback('debit', c))).size).toBe(3);
    expect(expectedBits('debit', cands, feedback)).toBeCloseTo(Math.log2(3), 10);
    // BREAD cannot tell DREAD from TREAD.
    expect(expectedBits('bread', cands, feedback)).toBeCloseTo(-(1 / 3) * Math.log2(1 / 3) - (2 / 3) * Math.log2(2 / 3), 10);
  });
  it('is zero when every candidate gives the same feedback', () => {
    expect(expectedBits('zzzzz', ['bread', 'dread'], feedback)).toBe(0);
  });
});

describe('turnStats', () => {
  it('reports candidates before and after, and bits', () => {
    const history = [row('slate', 'tread'), row('bread', 'tread'), row('tread', 'tread')];
    const { stats, remaining } = turnStats(ANSWERS, history, feedback);
    expect(stats).toHaveLength(3);
    expect(stats[0].before).toBe(ANSWERS.length);
    expect(stats[1].before).toBe(stats[0].after);
    expect(stats[2].after).toBe(1);
    expect(remaining[2]).toEqual(['tread']);
    for (let i = 0; i < 3; i++) {
      expect(remaining[i]).toHaveLength(stats[i].after);
      expect(stats[i].bitsObserved).toBeCloseTo(Math.log2(stats[i].before / stats[i].after), 10);
      expect(stats[i].bitsExpected).toBeGreaterThanOrEqual(0);
    }
    expect(stats[0].isCandidate).toBe(true);
    expect(stats[2].isCandidate).toBe(true);
  });
  it('flags guesses that were no longer candidates', () => {
    const { stats } = turnStats(ANSWERS, [row('crane', 'bread'), row('crane', 'bread')], feedback);
    expect(stats[1].isCandidate).toBe(false);
    expect(stats[1].bitsObserved).toBe(0);
  });
});

describe('formatting', () => {
  it('probabilities', () => {
    expect(fmtProb(1)).toBe('100%');
    expect(fmtProb(0.234)).toBe('23%');
    expect(fmtProb(0.0456)).toBe('4.6%');
    expect(fmtProb(0.0004)).toBe('<0.1%');
    expect(fmtProb(0)).toBe('0%');
    expect(fmtProb(NaN)).toBe('—');
  });
  it('bits and counts', () => {
    expect(fmtBits(5.8712)).toBe('5.87');
    expect(fmtBits(11.29)).toBe('11.3');
    expect(fmtCount(2500)).toBe('2,500');
  });
});
