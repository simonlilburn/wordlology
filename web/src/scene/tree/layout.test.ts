import { describe, expect, it } from 'vitest';
import { fixtureTree, SOLVED } from './fixtures';
import { bandY, extendHeaviest, layoutTree, pathOf, riverPx, visibleCount, waterFill, type LayoutParams, type LNode } from './layout';

const params = (over: Partial<LayoutParams> = {}): LayoutParams => ({
  maxGuesses: 6,
  totalGames: 100,
  width: 800,
  scale: 1,
  minLabel: 56,
  maxChildren: 12,
  expandStep: 12,
  bandHeight: 72,
  headerHeight: 36,
  riverScale: 0.2,
  solvedCode: SOLVED,
  ...over,
});

function kids(l: LNode): string[] {
  return l.children.map((c) => (c.kind === 'node' ? String(c.trie!.guess) : c.kind));
}

describe('waterFill', () => {
  it('is proportional to mass when every item is above its minimum', () => {
    const w = waterFill(100, [10, 10], [3, 1]);
    expect(w[0]).toBeCloseTo(75);
    expect(w[1]).toBeCloseTo(25);
  });
  it('holds light items at their minimum and shares the rest by mass', () => {
    const w = waterFill(100, [10, 10, 10], [98, 1, 1]);
    expect(w[1]).toBe(10);
    expect(w[2]).toBe(10);
    expect(w[0]).toBeCloseTo(80);
  });
  it('returns the minimums when the total is too small', () => {
    expect(waterFill(5, [10, 10], [1, 1])).toEqual([10, 10]);
  });
  it('shares spare width equally among massless items', () => {
    expect(waterFill(40, [10, 10], [0, 0])).toEqual([20, 20]);
  });
  it('always sums to the total when feasible', () => {
    const mins = [5, 12, 3, 20, 8];
    const masses = [1, 50, 0, 7, 2];
    const w = waterFill(200, mins, masses);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(200);
    w.forEach((x, i) => expect(x).toBeGreaterThanOrEqual(mins[i] - 1e-9));
  });
});

describe('visibleCount', () => {
  it('shows every child that fits', () => {
    expect(visibleCount(5, 10, 12, 0, 12)).toBe(5);
  });
  it('caps at maxChildren with an ellipsis for the rest', () => {
    expect(visibleCount(40, 100, 12, 0, 12)).toBe(12);
  });
  it('leaves one slot for the ellipsis when the width runs out', () => {
    expect(visibleCount(40, 5, 12, 0, 12)).toBe(4);
  });
  it('expands by a step per tap', () => {
    expect(visibleCount(40, 100, 12, 1, 12)).toBe(24);
    expect(visibleCount(40, 100, 12, 2, 12)).toBe(36);
    expect(visibleCount(40, 100, 12, 3, 12)).toBe(40);
  });
  it('never hides a single child behind an ellipsis', () => {
    expect(visibleCount(13, 100, 12, 0, 12)).toBe(13);
  });
});

describe('riverPx', () => {
  it('has a 1 px minimum for any mass and 0 for massless paths', () => {
    expect(riverPx(1, 0.2)).toBe(1);
    expect(riverPx(100, 0.2)).toBeCloseTo(20);
    expect(riverPx(0, 0.2)).toBe(0);
  });
});

describe('layoutTree', () => {
  it('puts the trunk straight down the centre and nodes in their guess bands', () => {
    const t = fixtureTree();
    t.add([1, 2, 3], { solved: true, times: 60 });
    t.add([1, 4, 5], { solved: true, times: 30 });
    t.add([1, 2, 6, 7], { solved: true, times: 10 });
    const trunk = pathOf(t.find([1, 2, 3])!);
    const L = layoutTree({ root: t.root, params: params(), trunk });
    for (const n of trunk) {
      const l = L.byTrie.get(n.id)!;
      expect(l.x).toBe(0);
      expect(l.trunk).toBe(true);
      expect(l.y).toBe(bandY(n.depth, L.params));
    }
    const off = L.byTrie.get(t.find([1, 4])!.id)!;
    expect(off.trunk).toBe(false);
    expect(off.band).toBe(2);
  });

  it('alternates siblings right and left of the trunk, heaviest nearest', () => {
    const t = fixtureTree();
    t.add([1, 10], { solved: true, times: 5 }); // trunk (light)
    t.add([1, 11], { solved: true, times: 40 });
    t.add([1, 12], { solved: true, times: 30 });
    t.add([1, 13], { solved: true, times: 20 });
    t.add([1, 14], { solved: true, times: 5 });
    const trunk = pathOf(t.find([1, 10])!);
    const L = layoutTree({ root: t.root, params: params({ width: 2000 }), trunk });
    const x = (g: number) => L.byTrie.get(t.find([1, g])!.id)!.x;
    expect(x(10)).toBe(0);
    expect(x(11)).toBeGreaterThan(0);
    expect(x(12)).toBeLessThan(0);
    expect(x(13)).toBeGreaterThan(x(11));
    expect(x(14)).toBeLessThan(x(12));
  });

  it('gives slots proportional to subtree games above the minimum width', () => {
    const t = fixtureTree();
    t.add([1, 2], { solved: true, times: 10 });
    t.add([1, 3], { solved: true, times: 60 });
    t.add([1, 4], { solved: true, times: 30 });
    const trunk = pathOf(t.find([1, 2])!);
    const L = layoutTree({ root: t.root, params: params({ width: 1000 }), trunk });
    const w = (g: number) => {
      const l = L.byTrie.get(t.find([1, g])!.id)!;
      return l.right - l.left;
    };
    expect(w(3) / w(4)).toBeCloseTo(2, 1);
    expect(w(2)).toBeGreaterThanOrEqual(56 - 1e-9);
  });

  it('merges light children into an ellipsis that carries their games', () => {
    const t = fixtureTree();
    t.add([1, 100], { solved: true, times: 50 });
    for (let g = 0; g < 30; g++) t.add([1, 200 + g], { solved: true, times: 30 - g });
    const trunk = pathOf(t.find([1, 100])!);
    const L = layoutTree({ root: t.root, params: params({ width: 400 }), trunk });
    const opener = L.byTrie.get(t.find([1])!.id)!;
    const ell = opener.children.find((c) => c.kind === 'ellipsis')!;
    expect(ell).toBeTruthy();
    const shown = opener.children.filter((c) => c.kind === 'node');
    // 400 px: 200 px either side of the trunk, which takes half a label
    // (28 px) from each; 56 px per label, and the ellipsis needs room for its
    // river (0.2 px per game): the trunk child and 3 others plus the ellipsis.
    expect(shown.length).toBe(4);
    expect(ell.hidden!.length).toBe(31 - 4);
    expect(ell.right - ell.left).toBeGreaterThanOrEqual(ell.riverWidth);
    const hiddenGames = ell.hidden!.reduce((s, n) => s + n.mass, 0);
    expect(ell.mass).toBe(hiddenGames);
    expect(ell.riverWidth).toBeCloseTo(riverPx(hiddenGames, 0.2));
    // The shown children are the heaviest.
    const minShown = Math.min(...shown.map((c) => c.mass));
    expect(Math.max(...ell.hidden!.map((n) => n.mass))).toBeLessThanOrEqual(minShown);
  });

  it('expands an ellipsis by the next 12 streams per tap, down to single games', () => {
    const t = fixtureTree();
    t.add([1, 100], { solved: true, times: 50 });
    for (let g = 0; g < 40; g++) t.add([1, 200 + g], { solved: true });
    const trunk = pathOf(t.find([1, 100])!);
    const opener = t.find([1])!;
    const count = (taps: number) => {
      const L = layoutTree({ root: t.root, params: params({ width: 3000 }), trunk, expanded: new Map([[opener.id, taps]]) });
      const l = L.byTrie.get(opener.id)!;
      return { shown: l.children.filter((c) => c.kind === 'node').length, ell: l.children.find((c) => c.kind === 'ellipsis') };
    };
    expect(count(0).shown).toBe(12);
    expect(count(0).ell!.hidden!.length).toBe(29);
    expect(count(1).shown).toBe(24);
    expect(count(2).shown).toBe(36);
    expect(count(3).shown).toBe(41);
    expect(count(3).ell).toBeUndefined();
  });

  it('puts expanded streams on the ellipsis side, beyond the streams already shown', () => {
    const t = fixtureTree();
    t.add([1, 100], { solved: true, times: 50 });
    for (let g = 0; g < 40; g++) t.add([1, 200 + g], { solved: true, times: 40 - g });
    const trunk = pathOf(t.find([1, 100])!);
    const opener = t.find([1])!;
    const before = layoutTree({ root: t.root, params: params({ width: 900, totalGames: t.root.mass }), trunk });
    const ell = before.byTrie.get(opener.id)!.children.find((c) => c.kind === 'ellipsis')!;
    const side = Math.sign(ell.x);
    const shownBefore = new Set(before.byTrie.get(opener.id)!.children.filter((c) => c.kind === 'node').map((c) => c.trie!.id));
    const after = layoutTree({ root: t.root, params: params({ width: 900, totalGames: t.root.mass }), trunk, expanded: new Map([[opener.id, 1]]) });
    const kidsAfter = after.byTrie.get(opener.id)!.children;
    const added = kidsAfter.filter((c) => c.kind === 'node' && !shownBefore.has(c.trie!.id));
    expect(added.length).toBe(12);
    for (const c of added) expect(Math.sign(c.x)).toBe(side);
    // Beyond every stream that was already on that side, and the new ellipsis outermost.
    const oldOnSide = kidsAfter.filter((c) => c.kind === 'node' && shownBefore.has(c.trie!.id) && Math.sign(c.x) === side);
    const edge = (c: { x: number }) => c.x * side;
    for (const c of added) for (const o of oldOnSide) expect(edge(c)).toBeGreaterThan(edge(o));
    const ell2 = kidsAfter.find((c) => c.kind === 'ellipsis')!;
    for (const c of added) expect(edge(ell2)).toBeGreaterThan(edge(c));
  });

  it('shows more children when zoomed in (the layout scale shrinks the label width)', () => {
    const t = fixtureTree();
    t.add([1, 100], { solved: true, times: 20 });
    for (let g = 0; g < 10; g++) t.add([1, 200 + g], { solved: true, times: 5 });
    const trunk = pathOf(t.find([1, 100])!);
    const opener = t.find([1])!;
    const shown = (scale: number) =>
      layoutTree({ root: t.root, params: params({ width: 300, scale }), trunk })
        .byTrie.get(opener.id)!
        .children.filter((c) => c.kind === 'node').length;
    expect(shown(1)).toBeLessThan(11);
    expect(shown(4)).toBe(11);
  });

  it('always shows forced nodes (player paths, selections) even when light', () => {
    const t = fixtureTree();
    t.add([1, 100], { solved: true, times: 50 });
    for (let g = 0; g < 30; g++) t.add([1, 200 + g], { solved: true, times: 2 });
    const hiddenLeaf = t.find([1, 229])!;
    const trunk = pathOf(t.find([1, 100])!);
    const L = layoutTree({ root: t.root, params: params({ width: 300 }), trunk, forced: [hiddenLeaf.id] });
    expect(L.byTrie.has(hiddenLeaf.id)).toBe(true);
  });

  it('keeps massless player paths visible as forced nodes', () => {
    const t = fixtureTree();
    t.add([1, 2, 3], { solved: true, times: 10 });
    const p = t.add([1, 9, 3], { player: true, solved: true });
    const L = layoutTree({ root: t.root, params: params(), trunk: pathOf(p) });
    const l = L.byTrie.get(p.id)!;
    expect(l.x).toBe(0);
    expect(l.riverWidth).toBe(0);
  });

  it('ends failed games in an Out node below the last guess band', () => {
    const t = fixtureTree();
    t.add([1, 2, 3, 4, 5, 6], { solved: false, times: 3 });
    const leaf = t.find([1, 2, 3, 4, 5, 6])!;
    const L = layoutTree({ root: t.root, params: params(), trunk: pathOf(leaf) });
    const l = L.byTrie.get(leaf.id)!;
    expect(l.children.length).toBe(1);
    expect(l.children[0].kind).toBe('out');
    expect(l.children[0].band).toBe(7);
    expect(l.children[0].mass).toBe(3);
  });

  it('never overlaps sibling slots and keeps children inside their parent slot', () => {
    const t = fixtureTree();
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 400; i++) {
      const path = [1];
      const len = 2 + Math.floor(rnd() * 4);
      for (let d = 1; d < len; d++) path.push(10 + Math.floor(rnd() * rnd() * 20));
      t.add(path, { solved: true });
    }
    const trunk = extendHeaviest([], t.root);
    const L = layoutTree({ root: t.root, params: params({ totalGames: 400, width: 900 }), trunk });
    for (const n of L.nodes) {
      const cs = [...n.children].sort((a, b) => a.left - b.left);
      for (let i = 1; i < cs.length; i++) expect(cs[i].left).toBeGreaterThanOrEqual(cs[i - 1].right - 1e-6);
      for (const c of cs) {
        expect(c.x).toBeGreaterThanOrEqual(c.left - 1e-6);
        expect(c.x).toBeLessThanOrEqual(c.right + 1e-6);
      }
    }
    for (const n of trunk) expect(L.byTrie.get(n.id)?.x).toBe(0);
  });

  it('stacks rivers so the trunk river stays centred and widths add up', () => {
    const t = fixtureTree();
    t.add([1, 2], { solved: true, times: 50 });
    t.add([1, 3], { solved: true, times: 30 });
    t.add([1, 4], { solved: true, times: 20 });
    const trunk = pathOf(t.find([1, 2])!);
    const L = layoutTree({ root: t.root, params: params({ riverScale: 1 }), trunk });
    const op = L.byTrie.get(t.find([1])!.id)!;
    const tc = op.children.find((c) => c.trunk)!;
    expect(tc.riverOffset).toBe(0);
    const sorted = [...op.children].sort((a, b) => a.riverOffset - b.riverOffset);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].riverOffset - sorted[i - 1].riverOffset).toBeCloseTo((sorted[i].riverWidth + sorted[i - 1].riverWidth) / 2);
    }
  });

  it('uses stable path keys for morphing', () => {
    const t = fixtureTree();
    t.add([1, 2, 3], { solved: true, times: 5 });
    const L = layoutTree({ root: t.root, params: params(), trunk: pathOf(t.find([1, 2, 3])!) });
    expect(L.byKey.has('r/1/2/3')).toBe(true);
    expect(L.root.key).toBe('r');
  });

  it('drops branches with no layout mass (isolate mode) unless forced', () => {
    const t = fixtureTree();
    t.add([1, 2], { solved: true, times: 5 });
    t.add([1, 3], { solved: true, times: 5 });
    const keep = t.find([1, 2])!;
    const massOf = (n: { id: number; mass: number }) => (n.id === t.find([1, 3])!.id ? 0 : n.mass);
    const L = layoutTree({ root: t.root, params: params(), trunk: pathOf(keep), massOf });
    expect(L.byTrie.has(t.find([1, 3])!.id)).toBe(false);
    expect(L.byTrie.has(keep.id)).toBe(true);
  });
});

describe('layoutTree fits the width', () => {
  // A broad tree like info-proportional play after a fixed opener: one heavy
  // trunk child and many light siblings.
  function broad() {
    const t = fixtureTree();
    t.add([1, 100], { solved: true, times: 4 });
    let seed = 3;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let g = 0; g < 50; g++) {
      const n = 1 + Math.floor(rnd() * rnd() * 12);
      for (let i = 0; i < n; i++) t.add([1, 200 + g, 400 + Math.floor(rnd() * 6)], { solved: true });
    }
    return t;
  }

  it('keeps the trunk centred with both sides within half the width', () => {
    const t = broad();
    const trunk = pathOf(t.find([1, 100])!);
    const total = t.root.mass;
    const L = layoutTree({ root: t.root, params: params({ totalGames: total, width: 850 }), trunk });
    expect(L.maxX).toBeLessThanOrEqual(425 + 1e-6);
    expect(L.minX).toBeGreaterThanOrEqual(-425 - 1e-6);
    // The heavier side reaches the edge (the tree uses the width it has).
    expect(Math.max(L.maxX, -L.minX)).toBeGreaterThan(425 - 1);
    const ell = L.nodes.find((n) => n.kind === 'ellipsis' && n.parent?.trie === t.find([1]));
    expect(ell).toBeTruthy();
    expect(Math.abs(ell!.x)).toBeLessThan(425);
    expect(ell!.right - ell!.left).toBeGreaterThanOrEqual(ell!.riverWidth);
  });

  it('still fits when grandchildren need wider ellipses than a label', () => {
    const t = fixtureTree();
    t.add([1, 100], { solved: true, times: 30 });
    for (let g = 0; g < 30; g++) for (let c = 0; c < 14; c++) t.add([1, 200 + g, 500 + c], { solved: true, times: 9 });
    const trunk = pathOf(t.find([1, 100])!);
    const L = layoutTree({ root: t.root, params: params({ totalGames: t.root.mass, width: 856, riverScale: 0.05 }), trunk });
    // "… 14 more" over "126 games" needs more than 56 px.
    const ells = L.nodes.filter((n) => n.kind === 'ellipsis' && n.band === 3);
    expect(ells.length).toBeGreaterThan(0);
    expect(L.maxX).toBeLessThanOrEqual(428 + 1e-6);
    expect(L.minX).toBeGreaterThanOrEqual(-428 - 1e-6);
  });

  it('lets an expanded node overflow rather than undo the expansion', () => {
    const t = fixtureTree();
    t.add([1, 100], { solved: true, times: 30 });
    for (let g = 0; g < 40; g++) t.add([1, 200 + g], { solved: true, times: 2 });
    const trunk = pathOf(t.find([1, 100])!);
    const opener = t.find([1])!;
    const L = layoutTree({ root: t.root, params: params({ totalGames: t.root.mass, width: 600 }), trunk, expanded: new Map([[opener.id, 1]]) });
    const shown = L.byTrie.get(opener.id)!.children.filter((c) => c.kind === 'node').length;
    expect(shown).toBeGreaterThan(12);
    expect(L.maxX - L.minX).toBeGreaterThan(600);
  });

  it('gives a node with room for one label an ellipsis rather than hiding it', () => {
    const t = broad();
    const trunk = pathOf(t.find([1, 100])!);
    const L = layoutTree({ root: t.root, params: params({ totalGames: t.root.mass, width: 850 }), trunk });
    const guess2 = L.nodes.filter((n) => n.band === 2 && n.kind === 'node' && !n.trunk);
    expect(guess2.length).toBeGreaterThan(4);
    for (const n of guess2) {
      const kids = n.trie!.children.length;
      if (kids === 0) continue;
      // Every stream of a shown node is accounted for: shown children or one ellipsis.
      const shownGames = n.children.reduce((s, c) => s + c.mass, 0);
      expect(shownGames).toBe(n.mass);
      if (kids > 1 && n.right - n.left < 2 * 56) expect(n.children.map((c) => c.kind)).toEqual(['ellipsis']);
    }
  });

  it('keeps slots ∝ games on both sides of the trunk while the tree is sparse', () => {
    const t = fixtureTree();
    t.add([1, 2], { solved: true, times: 10 });
    t.add([1, 3], { solved: true, times: 60 });
    t.add([1, 4], { solved: true, times: 30 });
    const L = layoutTree({ root: t.root, params: params({ width: 1000 }), trunk: pathOf(t.find([1, 2])!) });
    expect(L.maxX).toBeLessThanOrEqual(500 + 1e-6);
    expect(L.minX).toBeGreaterThanOrEqual(-500 - 1e-6);
  });

  it('holds positions steady while games are still arriving (λ ≤ width / total)', () => {
    const t = fixtureTree();
    t.add([1, 2], { solved: true, times: 3 });
    t.add([1, 3], { solved: true, times: 1 });
    const L = layoutTree({ root: t.root, params: params({ width: 1000, totalGames: 200 }), trunk: pathOf(t.find([1, 2])!) });
    // 4 of 200 games: the tree is narrow, not stretched over the whole width.
    expect(L.maxX - L.minX).toBeLessThan(300);
  });
});

describe('extendHeaviest', () => {
  it('follows the heaviest children to a leaf', () => {
    const t = fixtureTree();
    t.add([1, 2, 3], { solved: true, times: 5 });
    t.add([1, 4, 5], { solved: true, times: 7 });
    expect(extendHeaviest([], t.root).map((n) => n.guess)).toEqual([1, 4, 5]);
    expect(extendHeaviest([t.find([1])!, t.find([1, 2])!], t.root).map((n) => n.guess)).toEqual([1, 2, 3]);
  });
});
