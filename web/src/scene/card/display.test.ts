import { describe, expect, it } from 'vitest';
import type { CardSnapshot } from '../../model/types';
import { displayFromSnapshot, drawKey, emptyDisplay, firstDataSnap, medianTarget, packDisplay, unpackDisplay, vectorLength } from './display';

function snap(over: Partial<CardSnapshot>): CardSnapshot {
  return {
    maxGuesses: 6,
    counts: [0, 10, 40, 30, 15, 4, 1],
    shares: [0, 0.1, 0.4, 0.3, 0.15, 0.04, 0.01],
    bands: [
      [0, 0],
      [0.08, 0.12],
      [0.35, 0.45],
      [0.25, 0.35],
      [0.12, 0.18],
      [0.02, 0.06],
      [0, 0.02],
    ],
    shareSe: null,
    mean: 3.6,
    meanSe: 0.02,
    sd: 1,
    median: 3,
    p95: 5,
    solveRate: 0.99,
    nGames: 100,
    nTargetsDone: 100,
    nTargets: 100,
    complete: true,
    deterministic: false,
    ...over,
  };
}

describe('card display', () => {
  it('passes a complete stochastic card through with collapsed bands', () => {
    const d = displayFromSnapshot(snap({}), 20);
    expect(d.shares).toEqual([0, 0.1, 0.4, 0.3, 0.15, 0.04, 0.01]);
    expect(d.bandTop).toBe(7);
    expect(d.unresolvedFrac).toBe(0);
    expect(d.counts).toEqual([0, 10, 40, 30, 15, 4, 1]);
  });

  it('estimates counts of a filling stochastic card from the expected games', () => {
    const d = displayFromSnapshot(snap({ complete: false, nTargetsDone: 10, nGames: 10 }), 20);
    expect(d.expectedGames).toBe(2000);
    expect(d.counts[2]).toBeCloseTo(800, 9);
    expect(d.lo[2]).toBe(0.35);
    expect(d.hi[2]).toBe(0.45);
  });

  it('fills a deterministic card top-down with a hatched unresolved band', () => {
    // Top-down shares are fractions of all targets (settled rows only).
    const s = snap({
      deterministic: true,
      complete: false,
      shares: [0, 0.1, 0.3, 0, 0, 0, 0],
      counts: [0, 10, 30, 0, 0, 0, 0],
      nTargetsDone: 40,
      settledDepth: 3,
      unresolved: 60,
    });
    const d = displayFromSnapshot(s, 1);
    expect(d.unresolvedFrac).toBeCloseTo(0.6, 9);
    expect(d.unresolved).toBe(60);
    expect(d.bandTop).toBe(3);
    // Settled rows keep their final size (shares of all targets).
    expect(d.shares[2]).toBeCloseTo(0.3, 9);
    expect(d.expectedGames).toBe(100);
    expect(d.lo).toEqual(d.shares);
  });

  it('packs and unpacks the spring vector', () => {
    const d = displayFromSnapshot(snap({}), 20);
    const v = packDisplay(d);
    expect(v.length).toBe(vectorLength(d.n));
    const back = unpackDisplay(v, d);
    expect(back.shares).toEqual(d.shares);
    expect(back.mean).toBeCloseTo(3.6, 9);
    expect(back.meanSe).toBeCloseTo(0.02, 9);
    const e = emptyDisplay(6);
    expect(unpackDisplay(packDisplay(e), e).mean).toBeNaN();
  });

  it('finds the median-difficulty target', () => {
    expect(medianTarget([4, NaN, 2, 3, 5])).toBe(3);
    expect(medianTarget([3, 3, 3, 3])).toBe(1);
    expect(medianTarget([NaN])).toBe(-1);
  });
});

describe('drawKey', () => {
  const base = displayFromSnapshot(snap({}), 20);
  it('ignores changes too small to see', () => {
    const tiny = { ...base, shares: base.shares.map((x) => x + 0.00001), mean: base.mean + 0.00001 };
    expect(drawKey(tiny, 'full')).toBe(drawKey(base, 'full'));
    const chipTiny = { ...base, shares: base.shares.map((x) => x + 0.001) };
    expect(drawKey(chipTiny, 'chip')).toBe(drawKey(base, 'chip'));
  });
  it('changes with visible values, flags and progress', () => {
    expect(drawKey({ ...base, mean: base.mean + 0.01 }, 'full')).not.toBe(drawKey(base, 'full'));
    expect(drawKey({ ...base, complete: !base.complete }, 'chip')).not.toBe(drawKey(base, 'chip'));
    expect(drawKey({ ...base, nTargetsDone: base.nTargetsDone + 1 }, 'full')).not.toBe(drawKey(base, 'full'));
    const moved = { ...base, shares: base.shares.map((x, i) => (i === 2 ? x + 0.01 : x)) };
    expect(drawKey(moved, 'chip')).not.toBe(drawKey(base, 'chip'));
    expect(drawKey(base, 'chip')).not.toBe(drawKey(base, 'full'));
  });
});

describe('firstDataSnap', () => {
  it('snaps everything for a stochastic card, all but the band for a deterministic one', () => {
    const n = 7;
    expect(firstDataSnap(n, false)).toHaveLength(vectorLength(n));
    const det = firstDataSnap(n, true);
    expect(det).toHaveLength(vectorLength(n) - 2);
    expect(det).not.toContain(4 * n + 3);
    expect(det).not.toContain(4 * n + 4);
    // The indices really are the band's: unresolvedFrac and bandTop.
    const d = { ...emptyDisplay(6, true), unresolvedFrac: 0.25, bandTop: 3 };
    const v = packDisplay(d);
    expect(v[4 * n + 3]).toBe(0.25);
    expect(v[4 * n + 4]).toBe(3);
  });
});
