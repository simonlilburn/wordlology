import { describe, expect, it } from 'vitest';
import { DensityGrid, pathXs, patternScore, tracePath } from './ghost';

const turns = (pairs: [number, number][]) => pairs.map(([guess, pattern]) => ({ guess, pattern }));
const ALL_GREEN = 242; // 2 · (1 + 3 + 9 + 27 + 81)

describe('ghost path layout', () => {
  it('scores feedback from 0 (all grey) to 1 (all green)', () => {
    expect(patternScore(0, 5)).toBe(0);
    expect(patternScore(ALL_GREEN, 5)).toBe(1);
    expect(patternScore(1, 5)).toBeCloseTo(0.1, 9);
  });

  it('starts at the centre with one point per guess (plus Out for a failure)', () => {
    const solved = pathXs(turns([[10, 0], [20, 5], [30, ALL_GREEN]]), true, 6, 5);
    expect(solved.length).toBe(3);
    expect(solved[0]).toBe(0.5);
    for (const x of solved) expect(x).toBeGreaterThanOrEqual(0.02);
    const failed = pathXs(turns([[1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0]]), false, 6, 5);
    expect(failed.length).toBe(7);
    expect(failed[6]).toBe(failed[5]);
  });

  it('keeps games with the same history together (shared prefixes overlap)', () => {
    const a = pathXs(turns([[10, 3], [20, 7], [30, ALL_GREEN]]), true, 6, 5);
    const b = pathXs(turns([[10, 3], [20, 7], [30, 1], [40, ALL_GREEN]]), true, 6, 5);
    expect(b.slice(0, 3)).toEqual(a.slice(0, 3));
  });

  it('traces from the top edge through every row centre', () => {
    const ys: number[] = [];
    const n = tracePath([0.5, 0.6, 0.4], 7, 100, 140, (_x, y) => ys.push(y));
    expect(n).toBe(ys.length);
    expect(ys[0]).toBe(0);
    expect(ys[ys.length - 1]).toBeCloseTo(2.5 / 7, 9);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1] - 1e-12);
  });
});

describe('density grid', () => {
  it('accumulates paths incrementally and renders faint opacity', () => {
    const g = new DensityGrid(20, 28, 7);
    const xs = [0.5, 0.3, 0.3];
    g.addPath(xs);
    const v1 = g.version;
    const max1 = g.max;
    g.addPath(xs);
    expect(g.version).toBeGreaterThan(v1);
    expect(g.games).toBe(2);
    expect(g.max).toBeCloseTo(2 * max1, 9);
    const px = g.toRgba([10, 20, 30], 0.5);
    expect(px.length).toBe(20 * 28 * 4);
    let maxA = 0, lit = 0;
    for (let i = 3; i < px.length; i += 4) {
      maxA = Math.max(maxA, px[i]);
      if (px[i] > 0) {
        lit++;
        expect(px[i]).toBeGreaterThanOrEqual(8);
      }
    }
    expect(lit).toBeGreaterThan(10);
    expect(maxA).toBe(Math.round(0.5 * 255));
    g.clear();
    expect(g.max).toBe(0);
    expect(g.data.every((v) => v === 0)).toBe(true);
  });
});
