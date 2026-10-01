import { describe, expect, it } from 'vitest';
import { fixtureTree } from './fixtures';
import { layoutTree, pathOf, type LayoutParams } from './layout';
import { Morph } from './morph';

const params: LayoutParams = {
  maxGuesses: 6,
  totalGames: 20,
  width: 800,
  scale: 1,
  minLabel: 56,
  maxChildren: 12,
  expandStep: 12,
  bandHeight: 72,
  headerHeight: 36,
  riverScale: 0.2,
  solvedCode: 242,
};

function trees() {
  const a = fixtureTree();
  a.add([1, 2], { solved: true, times: 10 });
  a.add([1, 3], { solved: true, times: 10 });
  const b = fixtureTree();
  b.add([1, 2], { solved: true, times: 10 });
  b.add([1, 4], { solved: true, times: 10 });
  const la = layoutTree({ root: a.root, params, trunk: pathOf(a.find([1, 2])!) });
  const lb = layoutTree({ root: b.root, params, trunk: pathOf(b.find([1, 2])!) });
  return { la, lb };
}

describe('Morph', () => {
  it('keeps shared nodes, fades leaving ones out by half-time and new ones in afterwards', () => {
    const { la, lb } = trees();
    const m = new Morph();
    m.setLayout(la, 0, 0);
    m.setLayout(lb, 0, 600);
    const shared = m.nodes.get('r/1')!;
    const leaving = m.nodes.get('r/1/3')!;
    const coming = m.nodes.get('r/1/4')!;
    expect(leaving.dying).toBe(true);
    m.step(150);
    expect(shared.alpha).toBe(1);
    expect(leaving.alpha).toBeGreaterThan(0);
    expect(coming.alpha).toBe(0);
    m.step(300);
    expect(leaving.alpha).toBeCloseTo(0);
    m.step(450);
    expect(coming.alpha).toBeGreaterThan(0);
    expect(coming.alpha).toBeLessThan(1);
    // New nodes appear at their place rather than flying out of their parent.
    expect(coming.x).toBe(lb.byKey.get('r/1/4')!.x);
    expect(m.step(600)).toBe(false);
    expect(coming.alpha).toBe(1);
    expect(m.nodes.has('r/1/3')).toBe(false);
  });

  it('jumps when the duration is 0 (reduced motion)', () => {
    const { la, lb } = trees();
    const m = new Morph();
    m.setLayout(la, 0, 0);
    m.setLayout(lb, 0, 0);
    expect(m.animating).toBe(false);
    expect(m.nodes.get('r/1/4')!.alpha).toBe(1);
    expect(m.nodes.has('r/1/3')).toBe(false);
  });
});
