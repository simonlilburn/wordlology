import { describe, expect, it } from 'vitest';
import type { Game } from '../../backend/types';
import { firstWithLetter, layoutThumb, sortTargets, TargetIndex } from './stats';

function turn(guess: number) {
  return { guess, pattern: 0, candsBefore: 1, candsAfter: 1, pChosen: 1, bitsExpected: 0, phase: 0, isCandidate: true };
}

function game(target: number, ids: number[], solved = true, replicate = 0): Game {
  return { target, replicate, turns: ids.map(turn), solved };
}

const config = { rules: { max_guesses: 6, hard_mode: false } } as never;

describe('TargetIndex', () => {
  it('groups games by target incrementally', () => {
    const idx = new TargetIndex(6);
    const games = [game(0, [1, 2]), game(1, [1, 3, 4]), game(0, [5, 6, 7])];
    const run = { key: 'r1', games, config };
    expect(idx.sync(run)).toBe(true);
    expect(idx.sync(run)).toBe(false);
    const s0 = idx.byTarget.get(0)!;
    expect(s0.games).toHaveLength(2);
    expect(s0.mean).toBeCloseTo(2.5);
    expect(s0.breadth).toBe(2);
    expect(s0.outcomes).toEqual([0, 1, 1, 0, 0, 0, 0]);
    games.push(game(0, [1, 2, 3, 4, 5, 6], false));
    expect(idx.sync(run)).toBe(true);
    expect(idx.byTarget.get(0)!.failRate).toBeCloseTo(1 / 3);
    expect(idx.byTarget.get(0)!.outcomes[6]).toBe(1);
  });

  it('resets when the run changes', () => {
    const idx = new TargetIndex(6);
    idx.sync({ key: 'a', games: [game(0, [1])], config });
    idx.sync({ key: 'b', games: [game(3, [1, 2])], config });
    expect([...idx.byTarget.keys()]).toEqual([3]);
    expect(idx.sync(null)).toBe(true);
    expect(idx.byTarget.size).toBe(0);
  });

  it('ignores player games', () => {
    const idx = new TargetIndex(6);
    idx.sync({ key: 'a', games: [{ ...game(0, [1]), isPlayer: true }], config });
    expect(idx.byTarget.size).toBe(0);
  });
});

describe('sortTargets', () => {
  const idx = new TargetIndex(6);
  idx.sync({
    key: 'k',
    config,
    games: [
      game(0, [1, 2, 3]), // mean 3
      game(1, [1, 2, 3, 4, 5, 6], false), // mean 6, fail 1
      game(2, [1, 2, 3, 4]), // mean 4, two paths
      game(2, [1, 5, 3, 4]),
      game(3, [1, 2, 3, 4]), // mean 4, one path
    ],
  });

  it('sorts alphabetically by answer index', () => {
    expect(sortTargets([3, 1, 4, 0, 2], idx.byTarget, 'alpha')).toEqual([0, 1, 2, 3, 4]);
  });

  it('sorts hardest first with unseen targets last', () => {
    expect(sortTargets([0, 1, 2, 3, 4], idx.byTarget, 'mean')).toEqual([1, 2, 3, 0, 4]);
    expect(sortTargets([0, 1, 2, 3, 4], idx.byTarget, 'fail')).toEqual([1, 2, 3, 0, 4]);
    expect(sortTargets([0, 1, 2, 3, 4], idx.byTarget, 'breadth')).toEqual([2, 0, 1, 3, 4]);
  });

  it('shuffles reproducibly by seed', () => {
    const a = sortTargets([0, 1, 2, 3, 4, 5, 6, 7], idx.byTarget, 'random', 7);
    expect(sortTargets([7, 6, 5, 4, 3, 2, 1, 0], idx.byTarget, 'random', 7)).toEqual(a);
    expect([...a].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(sortTargets([0, 1, 2, 3, 4, 5, 6, 7], idx.byTarget, 'random', 8)).not.toEqual(a);
  });

  it('finds the first target with a letter', () => {
    const words = ['apple', 'bacon', 'baker', 'cider'];
    expect(firstWithLetter([0, 1, 2, 3], (t) => words[t], 'B')).toBe(1);
    expect(firstWithLetter([3, 2, 1, 0], (t) => words[t], 'b')).toBe(1);
    expect(firstWithLetter([0, 1, 2, 3], (t) => words[t], 'z')).toBe(-1);
  });
});

describe('layoutThumb', () => {
  it('puts the most likely path on a straight trunk', () => {
    const games = [game(0, [1, 2, 9]), game(0, [1, 2, 9]), game(0, [1, 3, 9]), game(0, [4, 9])];
    const l = layoutThumb(games, 6);
    expect(l.games).toBe(4);
    const trunk = l.edges.filter((e) => e.trunk);
    expect(trunk.map((e) => [e.d0, e.d1])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    for (const e of trunk) {
      expect(e.x0).toBeCloseTo(0.5);
      expect(e.x1).toBeCloseTo(0.5);
    }
    expect(trunk[0].share).toBeCloseTo(0.75);
    expect(l.shares).toEqual([0, 0.25, 0.75, 0, 0, 0, 0]);
    // Every game ends once.
    expect(l.ends.reduce((a, e) => a + e.share, 0)).toBeCloseTo(1);
    // Side branches sit off the trunk.
    expect(l.edges.filter((e) => !e.trunk).every((e) => Math.abs(e.x1 - 0.5) > 1e-9)).toBe(true);
  });

  it('puts failures in the X row', () => {
    const l = layoutThumb([game(0, [1, 2, 3, 4, 5, 6], false)], 6);
    expect(l.ends).toEqual([{ x: 0.5, d: 7, solved: false, share: 1 }]);
    expect(l.shares[6]).toBe(1);
  });

  it('is empty without games', () => {
    expect(layoutThumb([], 6)).toMatchObject({ games: 0, edges: [], ends: [] });
  });
});
