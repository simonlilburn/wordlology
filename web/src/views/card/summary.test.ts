import { describe, expect, it } from 'vitest';
import type { CardSnapshot } from '../../model/types';
import { summarise } from './summary';

const base: CardSnapshot = {
  maxGuesses: 6,
  counts: [0, 120, 900, 950, 280, 50, 15],
  shares: [0, 0.052, 0.389, 0.41, 0.121, 0.0216, 0.0065],
  bands: [
    [0, 0],
    [0.04, 0.06],
    [0.37, 0.41],
    [0.39, 0.43],
    [0.11, 0.13],
    [0.015, 0.03],
    [0.003, 0.01],
  ],
  shareSe: null,
  mean: 3.62,
  meanSe: 0.011,
  sd: 0.9,
  median: 4,
  p95: 5,
  solveRate: 0.9935,
  nGames: 640,
  nTargetsDone: 640,
  nTargets: 2315,
  complete: false,
  deterministic: false,
};

describe('card summary (text alternative)', () => {
  it('marks a filling stochastic card as an estimate with intervals', () => {
    const s = summarise(base, 20);
    expect(s.provisional).toBe(true);
    expect(s.rows.map((r) => r.name)).toEqual(['Guess 1', 'Guess 2', 'Guess 3', 'Guess 4', 'Guess 5', 'Guess 6', 'Out']);
    expect(s.rows[2].share).toBe('~39%');
    expect(s.rows[2].interval).toBe('37.0% – 41.0%');
    expect(s.mean).toBe('~3.6');
    expect(s.status).toBe('estimate · 640 / 2,315 targets');
    expect(s.unresolved).toBeNull();
  });

  it('gives final numbers with ± SE once complete', () => {
    const s = summarise(
      { ...base, complete: true, nTargetsDone: 2315, nGames: 46300, shareSe: [0, 0.001, 0.002, 0.002, 0.001, 0.0005, 0.0002] },
      20,
    );
    expect(s.provisional).toBe(false);
    expect(s.rows[3].share).toBe('41.0%');
    expect(s.rows[3].count).toBe('950');
    expect(s.rows[3].interval).toBe('± 0.4%');
    expect(s.mean).toBe('3.62 ± 0.01');
    expect(s.solved).toBe('99.4%');
    expect(s.p95).toBe('5');
    expect(s.status).toBe('complete · 2,315 targets · 46,300 games');
  });

  it('shows the unresolved band of a deterministic card filling top-down', () => {
    const s = summarise(
      {
        ...base,
        deterministic: true,
        meanSe: null,
        shares: [0, 0.05, 0.3, 0, 0, 0, 0],
        counts: [0, 116, 695, 0, 0, 0, 0],
        settledDepth: 3,
        unresolved: 1504,
        nTargetsDone: 811,
      },
      1,
    );
    expect(s.unresolved).toBe('1,504 games unresolved');
    expect(s.rows[1].count).toBe('116');
    expect(s.rows[4].count).toBe('unresolved');
    expect(s.rows[4].interval).toBeNull();
  });
});
