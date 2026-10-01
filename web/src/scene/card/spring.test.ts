import { describe, expect, it } from 'vitest';
import { CARD_OMEGA, omegaForSettle, SpringArray, springStep } from './spring';

describe('critically damped spring', () => {
  it('settles to within 2% in about 300 ms without overshoot', () => {
    let x = 0, v = 0;
    const dt = 1 / 120;
    let t = 0;
    let max = 0;
    while (t < 0.3 - 1e-9) {
      [x, v] = springStep(x, v, 1, dt);
      t += dt;
      max = Math.max(max, x);
    }
    expect(x).toBeGreaterThan(0.975);
    expect(x).toBeLessThanOrEqual(1);
    // Half-way there well before the end, but not instantly.
    const [x50] = springStep(0, 0, 1, 0.05);
    expect(x50).toBeGreaterThan(0.1);
    expect(x50).toBeLessThan(0.9);
    for (let i = 0; i < 200; i++) {
      [x, v] = springStep(x, v, 1, dt);
      max = Math.max(max, x);
    }
    expect(max).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('is frame-rate independent (exact solution)', () => {
    let a: [number, number] = [0, 0];
    for (let i = 0; i < 10; i++) a = springStep(a[0], a[1], 1, 0.01);
    const b = springStep(0, 0, 1, 0.1);
    expect(a[0]).toBeCloseTo(b[0], 9);
    expect(a[1]).toBeCloseTo(b[1], 9);
  });

  it('stays stable for huge steps and ignores non-positive dt', () => {
    const [x, v] = springStep(0, 0, 5, 10);
    expect(x).toBeCloseTo(5, 6);
    expect(Math.abs(v)).toBeLessThan(1e-6);
    expect(springStep(2, 1, 5, 0)).toEqual([2, 1]);
  });

  it('solves omega for a settle time', () => {
    const w = omegaForSettle(300, 0.02);
    const t = 0.3;
    expect((1 + w * t) * Math.exp(-w * t)).toBeCloseTo(0.02, 6);
    expect(CARD_OMEGA).toBeCloseTo(w, 9);
  });
});

describe('SpringArray', () => {
  it('snaps on first display and eases afterwards', () => {
    const s = new SpringArray(3);
    s.set([1, 2, 3], true);
    expect(Array.from(s.x)).toEqual([1, 2, 3]);
    expect(s.settled()).toBe(true);
    s.set([2, 2, NaN]);
    expect(s.target[2]).toBe(0);
    expect(s.step(0.016)).toBe(true);
    expect(s.x[0]).toBeGreaterThan(1);
    expect(s.x[0]).toBeLessThan(2);
    for (let i = 0; i < 100; i++) s.step(0.016);
    expect(s.settled()).toBe(true);
    expect(Array.from(s.x)).toEqual([2, 2, 0]);
    expect(s.step(0.016)).toBe(false);
  });
});

describe('SpringArray.snap', () => {
  it('jumps chosen springs to their targets and leaves the rest easing', () => {
    const a = new SpringArray(3);
    a.set([1, 2, 3]);
    a.snap([0, 2]);
    expect(a.x[0]).toBe(1);
    expect(a.x[1]).toBe(0);
    expect(a.x[2]).toBe(3);
    expect(a.step(0.016)).toBe(true);
    expect(a.x[0]).toBe(1);
    expect(a.x[1]).toBeGreaterThan(0);
  });
});
