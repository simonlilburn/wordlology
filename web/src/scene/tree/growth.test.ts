import { describe, expect, it } from 'vitest';
import { advanceClock, growthDuration, growthTiming, revealCount, RevealQueue, sharedDepth } from './growth';

const full = growthTiming('full')!;

describe('growth schedule', () => {
  it('draws the first five games one at a time, about 500 ms each', () => {
    expect(revealCount(0, 200, full)).toBe(1);
    expect(revealCount(499, 200, full)).toBe(1);
    expect(revealCount(500, 200, full)).toBe(2);
    expect(revealCount(2499, 200, full)).toBe(5);
  });

  it('then doubles the reveal rate every second', () => {
    const t1 = 2500;
    const a = revealCount(t1 + 1000, 1000, full) - revealCount(t1, 1000, full);
    const b = revealCount(t1 + 2000, 1000, full) - revealCount(t1 + 1000, 1000, full);
    expect(b / a).toBeGreaterThan(1.8);
    expect(b / a).toBeLessThan(2.2);
  });

  it('is monotone and reveals every game within about 6 s', () => {
    for (const R of [1, 5, 6, 50, 200, 1000]) {
      let prev = 0;
      for (let t = 0; t <= 6100; t += 50) {
        const n = revealCount(t, R, full);
        expect(n).toBeGreaterThanOrEqual(prev);
        prev = n;
      }
      expect(revealCount(6000, R, full)).toBe(R);
      expect(growthDuration(R, full)).toBeLessThanOrEqual(6000 + 1e-6);
    }
  });

  it('fast mode finishes within 2 s and off has no schedule', () => {
    const fast = growthTiming('fast')!;
    expect(revealCount(2000, 1000, fast)).toBe(1000);
    expect(growthTiming('off')).toBeNull();
  });

  it('stalls the clock while compute is behind ("computing 142 / 200")', () => {
    const r1 = advanceClock(0, 100, 200, 0, false, full);
    expect(r1.stalled).toBe(true);
    expect(r1.clock).toBe(0);
    const at = 3000;
    const avail = revealCount(at, 200, full) + 1;
    const r2 = advanceClock(at, 2000, 200, avail, false, full);
    expect(r2.stalled).toBe(true);
    expect(r2.clock).toBeGreaterThan(at);
    expect(revealCount(r2.clock, 200, full)).toBeLessThanOrEqual(avail);
    const r3 = advanceClock(4000, 100, 200, 30, true, full);
    expect(r3.stalled).toBe(false);
    expect(r3.clock).toBe(4100);
  });
});

describe('RevealQueue', () => {
  it('pops the games that stay with the trunk longest first, FIFO within a depth', () => {
    const q = new RevealQueue<string>();
    q.push('a1', 1);
    q.push('c3', 3);
    q.push('b1', 1);
    q.push('d3', 3);
    q.push('e0', 0);
    expect([q.pop(), q.pop(), q.pop(), q.pop(), q.pop(), q.pop()]).toEqual(['c3', 'd3', 'a1', 'b1', 'e0', undefined]);
    expect(q.size).toBe(0);
  });

  it('sharedDepth counts common leading guesses', () => {
    expect(sharedDepth([1, 2, 3], [1, 2, 4])).toBe(2);
    expect(sharedDepth([5], [1, 2])).toBe(0);
  });
});
