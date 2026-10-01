import { describe, expect, it } from 'vitest';
import { fixtureTree } from '../../scene/tree/fixtures';
import { flattenOutline, outlineKey } from './outline';
import { nodeLabel, outcomeOf, pathInfo } from './pathinfo';

function tree() {
  const t = fixtureTree();
  t.add([1, 2, 3], { solved: true, times: 5 });
  t.add([1, 4], { solved: true, times: 3 });
  t.add([6], { solved: false, times: 1 });
  return t;
}
const sorted = (n: { children: { mass: number; guess: number }[] }) => [...n.children].sort((a, b) => b.mass - a.mass || a.guess - b.guess);

describe('tree outline', () => {
  it('lists the root children and the children of expanded nodes, heaviest first', () => {
    const t = tree();
    const collapsed = flattenOutline(t.root, new Set(), sorted as never);
    expect(collapsed.map((r) => r.node.guess)).toEqual([1, 6]);
    expect(collapsed[0]).toMatchObject({ level: 1, setsize: 2, posinset: 1, expandable: true, expanded: false });
    const open = flattenOutline(t.root, new Set([t.find([1])!.id]), sorted as never);
    expect(open.map((r) => [r.node.guess, r.level])).toEqual([
      [1, 1],
      [2, 2],
      [4, 2],
      [6, 1],
    ]);
  });

  it('follows the ARIA tree keyboard pattern', () => {
    const t = tree();
    const op = t.find([1])!;
    const rows = flattenOutline(t.root, new Set([op.id]), sorted as never);
    expect(outlineKey(rows, 0, 'ArrowDown', false)).toEqual({ kind: 'focus', index: 1 });
    expect(outlineKey(rows, 0, 'ArrowLeft', false)).toEqual({ kind: 'collapse', id: op.id, index: 0 });
    expect(outlineKey(rows, 2, 'ArrowLeft', false)).toEqual({ kind: 'focus', index: 0 });
    expect(outlineKey(rows, 1, 'ArrowRight', false)).toEqual({ kind: 'expand', id: t.find([1, 2])!.id });
    expect(outlineKey(rows, 1, 'Enter', false)).toEqual({ kind: 'select', id: t.find([1, 2])!.id });
    expect(outlineKey(rows, 1, 'Enter', true)).toEqual({ kind: 'play', id: t.find([1, 2])!.id });
    expect(outlineKey(rows, 3, 'End', false)).toEqual({ kind: 'focus', index: 3 });
  });

  it('describes nodes and paths with counts and outcomes', () => {
    const t = tree();
    const leaf = t.find([1, 2, 3])!;
    const words = ['aaaaa', 'crane', 'slate', 'shake', 'trace', 'brine', 'moist'];
    const info = pathInfo(leaf, words, 9, 6, 5);
    expect(info.rows.map((r) => r.word)).toEqual(['CRANE', 'SLATE', 'SHAKE']);
    expect(info.outcome).toBe('Solved in 3');
    expect(info.prob).toBeCloseTo(5 / 9);
    expect(outcomeOf(t.find([1])!, 6, 5).text).toBe('8 games continue from here');
    const label = nodeLabel(leaf, 'shake', 9, 6, 5, true);
    expect(label).toContain('Guess 3');
    expect(label).toContain('5 games');
    expect(label).toContain('matches the filter');
  });
});
