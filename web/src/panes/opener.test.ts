import { describe, expect, it } from 'vitest';
import { HUMAN_OPENERS, openerProblem, topK, withAtlasRow } from './opener';
import { cellsOf, describeGuess, fmtProb, mulberry32, outcomeLabels } from './util';

describe('openerProblem', () => {
  const list = new Set(['crane', 'slate']);
  const inList = (w: string) => list.has(w);
  it('validates typed openers', () => {
    expect(openerProblem('', 5, inList)).toBe('');
    expect(openerProblem('cr4ne', 5, inList)).toBe('Letters only.');
    expect(openerProblem('cra', 5, inList)).toBe('2 more letters.');
    expect(openerProblem('cran', 5, inList)).toBe('1 more letter.');
    expect(openerProblem('cranes', 5, inList)).toBe('Openers have 5 letters.');
    expect(openerProblem('QQQQQ', 5, inList)).toBe('QQQQQ is not in the guess list.');
    expect(openerProblem(' Crane ', 5, inList)).toBe('');
    expect(openerProblem('qqqqq', 5, null)).toBe('');
  });

  it('lists lowercase five-letter human openers', () => {
    for (const w of HUMAN_OPENERS) expect(w).toMatch(/^[a-z]{5}$/);
  });
});

describe('topK', () => {
  it('returns the highest scores, ties toward the lower id', () => {
    expect(topK([1, 5, 3, 5, NaN, 4], 3)).toEqual([1, 3, 5]);
    expect(topK([2, 1], 5)).toEqual([0, 1]);
    expect(topK(new Float64Array([0.5, 0.25, 0.75]), 1)).toEqual([2]);
    expect(topK([], 3)).toEqual([]);
  });
});

describe('withAtlasRow', () => {
  it('seeds with the focused opener and avoids duplicates', () => {
    expect(withAtlasRow([], 'crane', 'slate')).toEqual(['crane', 'slate']);
    expect(withAtlasRow([], null, 'slate')).toEqual([null, 'slate']);
    expect(withAtlasRow(['crane', 'slate'], 'crane', 'slate')).toEqual(['crane', 'slate']);
    expect(withAtlasRow(['crane'], 'crane', null)).toEqual(['crane', null]);
  });
});

describe('util', () => {
  it('decodes feedback cells', () => {
    // c = 2 (correct) at 0, 1 (present) at 2: 2 + 1 * 9 = 11.
    expect(cellsOf(11, 5)).toEqual([2, 0, 1, 0, 0]);
    expect(describeGuess('crane', 11)).toBe('CRANE: C correct, R absent, A present, N absent, E absent');
  });

  it('formats probabilities', () => {
    expect(fmtProb(0.5)).toBe('50%');
    expect(fmtProb(0.025)).toBe('2.5%');
    expect(fmtProb(0.00123)).toBe('0.12%');
    expect(fmtProb(0)).toBe('0%');
  });

  it('labels outcome rows and shuffles reproducibly', () => {
    expect(outcomeLabels(6)).toEqual(['1', '2', '3', '4', '5', '6', 'X']);
    const a = mulberry32(3);
    const b = mulberry32(3);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});
