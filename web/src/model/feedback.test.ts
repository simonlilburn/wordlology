import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { allCorrect, feedback, patternCells, patternFromLetters, patternLetters } from './feedback';

const vectors = JSON.parse(readFileSync(new URL('../../../data/testvectors/feedback.json', import.meta.url), 'utf8')) as {
  cases: { guess: string; target: string; code: number; letters: string }[];
};

describe('feedback', () => {
  it('matches the shared test vectors', () => {
    expect(vectors.cases.length).toBeGreaterThan(10);
    for (const c of vectors.cases) {
      expect(feedback(c.guess, c.target), `${c.guess} vs ${c.target}`).toBe(c.code);
      expect(patternLetters(c.code, c.guess.length)).toBe(c.letters);
      expect(patternFromLetters(c.letters)).toBe(c.code);
    }
  });

  it('marks greens first, then yellows left to right', () => {
    // SPEED against ABIDE: absent, absent, present, absent, present.
    expect(patternLetters(feedback('speed', 'abide'), 5)).toBe('bbyby');
    // Only one E is left for a yellow after the green.
    expect(patternLetters(feedback('eerie', 'crepe'), 5)).toBe('ybgbg');
  });

  it('is all correct against itself, and every target is consistent with its own feedback', () => {
    const words = ['crane', 'abbey', 'kebab', 'speed', 'geese', 'llama', 'eerie', 'mamma'];
    for (const w of words) expect(feedback(w, w)).toBe(allCorrect(5));
    for (const g of words) {
      for (const t of words) {
        const p = feedback(g, t);
        // A target is consistent with the feedback it produced.
        expect(feedback(g, t)).toBe(p);
        const cells = patternCells(p, 5);
        cells.forEach((c, i) => {
          if (c === 2) expect(g[i]).toBe(t[i]);
          else expect(g[i] === t[i]).toBe(false);
        });
      }
    }
  });

  it('works for 4 to 7 letters', () => {
    expect(feedback('abcd', 'abcd')).toBe(allCorrect(4));
    expect(feedback('letters', 'settler')).toBe(1132);
    expect(allCorrect(7)).toBe(3 ** 7 - 1);
    expect(() => feedback('abc', 'abcd')).toThrow();
    expect(patternFromLetters('gyx')).toBeNull();
  });
});
