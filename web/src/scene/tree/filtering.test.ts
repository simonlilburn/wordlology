import { describe, expect, it } from 'vitest';
import { fixtureTree } from './fixtures';
import { computeTreeFilter, onMatchedPath, revealMatchIds } from './filtering';
import { layoutTree, pathOf } from './layout';

function build() {
  const t = fixtureTree();
  t.add([1, 2, 3], { solved: true, times: 6 });
  t.add([1, 2, 4], { solved: true, times: 4 });
  t.add([1, 5, 6], { solved: true, times: 3 });
  t.add([1, 5, 7], { solved: true, times: 2 });
  return t;
}

describe('computeTreeFilter', () => {
  it('marks matches, paths through them and isolate masses', () => {
    const t = build();
    const f = computeTreeFilter(t.root, t.nodes.length, (n) => n.guess === 5 || n.guess === 4, 'highlight', 6);
    const n = (g: number[]) => t.find(g)!;
    expect(f.nodesMatched).toBe(2);
    expect(f.match[n([1, 5]).id]).toBe(1);
    expect(f.above[n([1, 5, 6]).id]).toBe(1);
    expect(f.below[n([1]).id]).toBe(2);
    // Games touching a match: all 5 through guess 5, plus 4 through [1,2,4].
    expect(f.gamesTouching).toBe(9);
    expect(f.fmass[n([1, 2]).id]).toBe(4);
    expect(f.fmass[n([1, 2, 3]).id]).toBe(0);
    expect(f.perRow).toEqual([0, 1, 1, 0, 0, 0]);
    expect(onMatchedPath(f, n([1]))).toBe(true);
    expect(onMatchedPath(f, n([1, 2, 3]))).toBe(false);
  });

  it('never matches the root', () => {
    const t = build();
    const f = computeTreeFilter(t.root, t.nodes.length, () => true, 'highlight', 6);
    expect(f.match[t.root.id]).toBe(0);
    expect(f.nodesMatched).toBe(t.nodes.length - 1);
  });

  it('isolate mode re-lays out with only the filtered games', () => {
    const t = build();
    const f = computeTreeFilter(t.root, t.nodes.length, (n) => n.guess === 5, 'isolate', 6);
    const massOf = (n: { id: number }) => f.fmass[n.id];
    const trunk = pathOf(t.find([1, 5, 6])!);
    const L = layoutTree({
      root: t.root,
      params: { maxGuesses: 6, totalGames: 5, width: 600, scale: 1, minLabel: 56, maxChildren: 12, expandStep: 12, bandHeight: 72, headerHeight: 36, riverScale: 1, solvedCode: 242 },
      trunk,
      massOf,
    });
    expect(L.byTrie.has(t.find([1, 2])!.id)).toBe(false);
    expect(L.byTrie.get(t.find([1])!.id)!.mass).toBe(5);
  });

  it('reveal picks the heaviest matches, up to the limit', () => {
    const t = build();
    const f = computeTreeFilter(t.root, t.nodes.length, (n) => n.depth === 3, 'highlight', 6);
    const ids = revealMatchIds(t.root, f, 2);
    expect(ids).toEqual([t.find([1, 2, 3])!.id, t.find([1, 2, 4])!.id]);
    expect(revealMatchIds(t.root, f).length).toBe(4);
  });
});
