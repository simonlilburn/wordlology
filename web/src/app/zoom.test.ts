import { describe, expect, it } from 'vitest';
import { OMEGA_STACK, stiffness } from './zoom';

describe('zoom spring stiffness', () => {
  it('slows the Tree ↔ Card move, where the stack animates', () => {
    expect(stiffness(1, 2)).toBe(OMEGA_STACK);
    expect(stiffness(2, 1)).toBe(OMEGA_STACK);
    expect(stiffness(1.4, 2)).toBe(OMEGA_STACK);
  });

  it('keeps the other moves at the usual speed', () => {
    for (const [z, t] of [
      [0, 1],
      [1, 0],
      [2, 3],
      [3, 2],
      [0.5, 2],
    ]) {
      expect(stiffness(z, t)).toBeGreaterThan(OMEGA_STACK);
    }
  });
});
