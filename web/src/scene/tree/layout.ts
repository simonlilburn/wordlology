// Tree layout: pure functions from a target trie to world positions.
//
// World units are CSS px at camera scale 1; y points up and the tree grows
// downward (band k is centred at y = -(k - 0.5) * bandHeight; the header band
// holding the root sits above y = 0).
//
// The layout runs in three passes:
//  1. Choose what is visible, top down. Each node's width budget is its share
//     of the width it was allocated (slots ∝ subtree games, water-filled with
//     a minimum label width). A node shows its children in descending mass
//     while they fit (minLabel screen px each at the layout scale, at most
//     maxChildren); the rest merge into one ellipsis node. Taps on an
//     ellipsis add expandStep more children each. Forced nodes (trunk,
//     player paths, the selected path, revealed filter matches) always show.
//  2. Measure what each visible subtree needs, bottom up (so forced nodes
//     never overlap their neighbours).
//  3. Place, top down: trunk nodes sit at x = 0 with their trunk child
//     straight below and the other children alternating right and left by
//     mass (heaviest nearest the trunk); other nodes order their children by
//     mass from the trunk side outward, ellipsis outermost.

import type { TrieNode } from '../../model/types';

export type LKind = 'root' | 'node' | 'ellipsis' | 'out';

export interface LNode {
  /** Stable path key ("r/12/345", "r/12/…", "r/12/345/7/x"): the morph matches nodes by it across layouts and trees. */
  key: string;
  kind: LKind;
  /** The trie node (root and node kinds; for 'out', the failed last-guess node). */
  trie: TrieNode | null;
  parent: LNode | null;
  /** Children in left-to-right order. */
  children: LNode[];
  /** Band: 0 the header (root), 1..maxGuesses the guesses, maxGuesses + 1 Out. */
  band: number;
  x: number;
  y: number;
  /** Allocated slot, world x. */
  left: number;
  right: number;
  /** Games carried by the river into this node (layout mass: filtered in isolate mode). */
  mass: number;
  /** On the trunk (the straight centre path). */
  trunk: boolean;
  /** -1 left of the trunk, 0 on it, 1 right of it. */
  side: number;
  /** River into this node: start offset from the parent's x and width, in river px (legend units). */
  riverOffset: number;
  riverWidth: number;
  /** Ellipsis: the hidden children, their games and the filter matches inside them. */
  hidden: TrieNode[] | null;
  hiddenMass: number;
  hiddenMatches: number;
  /** Index in Layout.nodes (pre-order). */
  index: number;
}

export interface LayoutParams {
  maxGuesses: number;
  /** Games the widths are proportional to (R, or the games so far). */
  totalGames: number;
  /** World width that totalGames span. */
  width: number;
  /** Layout scale L ≥ 1: labels need minLabel screen px, i.e. minLabel / L world px. */
  scale: number;
  minLabel: number;
  maxChildren: number;
  expandStep: number;
  bandHeight: number;
  headerHeight: number;
  /** River px per game (legend scale). */
  riverScale: number;
  /** Feedback code of a solving guess (all correct). */
  solvedCode: number;
}

export const DEFAULT_LAYOUT: Omit<LayoutParams, 'maxGuesses' | 'totalGames' | 'width' | 'solvedCode'> = {
  scale: 1,
  minLabel: 56,
  maxChildren: 12,
  expandStep: 12,
  bandHeight: 72,
  headerHeight: 36,
  riverScale: 0.2,
};

export interface LayoutInput {
  root: TrieNode;
  params: LayoutParams;
  /** Layout mass of a node (default node.mass); nodes with 0 are dropped unless forced. */
  massOf?: (n: TrieNode) => number;
  /** The trunk: nodes from the first guess down (root excluded). */
  trunk?: readonly TrieNode[];
  /** Node ids that must be visible (their ancestors are made visible too). */
  forced?: Iterable<number>;
  /** Parent node id -> ellipsis taps (each shows expandStep more children). */
  expanded?: ReadonlyMap<number, number>;
  /** Filter matches in a node's subtree, for ellipsis badges. */
  matchesBelow?: (n: TrieNode) => number;
}

export interface Layout {
  /** Pre-order: parents before children. */
  nodes: LNode[];
  byKey: Map<string, LNode>;
  /** Trie node id -> layout node (visible nodes only). */
  byTrie: Map<number, LNode>;
  root: LNode;
  minX: number;
  maxX: number;
  /** World y of the top of the header and of the bottom of the Out band. */
  top: number;
  bottom: number;
  params: LayoutParams;
}

/** River px for a mass (1 px minimum; massless paths get 0 and draw as a hairline). */
export function riverPx(mass: number, riverScale: number): number {
  return mass > 0 ? Math.max(1, mass * riverScale) : 0;
}

/** Centre y of a band. */
export function bandY(band: number, p: Pick<LayoutParams, 'bandHeight' | 'headerHeight'>): number {
  return band <= 0 ? p.headerHeight / 2 : -(band - 0.5) * p.bandHeight;
}

/** Top y of a band (band 0 is the header). */
export function bandTop(band: number, p: Pick<LayoutParams, 'bandHeight' | 'headerHeight'>): number {
  return band <= 0 ? p.headerHeight : -(band - 1) * p.bandHeight;
}

/**
 * Water-filling: widths w_i = max(min_i, λ·mass_i) summing to total (when
 * total ≥ Σ min_i; otherwise every width is its minimum). Items without mass
 * stay at their minimum unless every item is massless, when the spare width is
 * shared equally.
 */
export function waterFill(total: number, mins: readonly number[], masses: readonly number[]): number[] {
  const n = mins.length;
  const out = mins.slice();
  if (n === 0) return out;
  let sumMin = 0;
  for (let i = 0; i < n; i++) sumMin += mins[i];
  if (!(total > sumMin)) return out;
  const free: number[] = [];
  let fixed = 0;
  let massSum = 0;
  for (let i = 0; i < n; i++) {
    if (masses[i] > 0) {
      free.push(i);
      massSum += masses[i];
    } else fixed += mins[i];
  }
  if (massSum <= 0) {
    const extra = (total - sumMin) / n;
    for (let i = 0; i < n; i++) out[i] = mins[i] + extra;
    return out;
  }
  // Largest threshold min/mass first: those items are the first to sit at their minimum.
  free.sort((a, b) => mins[b] / masses[b] - mins[a] / masses[a]);
  let lambda = (total - fixed) / massSum;
  let k = 0;
  while (k < free.length) {
    const i = free[k];
    if (mins[i] / masses[i] <= lambda) break;
    fixed += mins[i];
    massSum -= masses[i];
    k++;
    lambda = massSum > 0 ? (total - fixed) / massSum : Infinity;
  }
  for (let j = k; j < free.length; j++) out[free[j]] = lambda * masses[free[j]];
  return out;
}

/**
 * How many children a node shows: all of them when they fit its slots (and
 * the cap), otherwise the heaviest `slots - 1` (at most the cap) plus an
 * ellipsis, and `expandStep` more per tap. Hiding a single child is never
 * worth an ellipsis. Returns the count shown before forced extras.
 */
export function visibleCount(n: number, slots: number, maxChildren: number, taps: number, expandStep: number): number {
  if (n <= Math.min(Math.max(1, slots), maxChildren)) return n;
  const k = Math.max(0, Math.min(maxChildren, Math.max(1, slots) - 1)) + expandStep * Math.max(0, taps);
  return k >= n - 1 ? n : k;
}

interface VNode {
  kind: LKind;
  trie: TrieNode | null;
  mass: number;
  trunk: boolean;
  children: VNode[];
  hidden: TrieNode[] | null;
  hiddenMatches: number;
  need: number;
  needL: number;
  needR: number;
  side: number;
  left: number;
  right: number;
  x: number;
}

function vnode(kind: LKind, trie: TrieNode | null, mass: number, trunk: boolean): VNode {
  return { kind, trie, mass, trunk, children: [], hidden: null, hiddenMatches: 0, need: 0, needL: 0, needR: 0, side: 0, left: 0, right: 0, x: 0 };
}

export function layoutTree(input: LayoutInput): Layout {
  const p = input.params;
  const massOf = input.massOf ?? ((n: TrieNode) => n.mass);
  const expanded = input.expanded ?? new Map<number, number>();
  const matchesBelow = input.matchesBelow ?? (() => 0);
  const L = Math.max(1, p.scale);
  const minW = p.minLabel / L;
  const N = p.maxGuesses;
  const total = Math.max(1, p.totalGames);

  // Forced ids plus their ancestors.
  const trunkIds = new Set<number>();
  const forced = new Set<number>();
  const force = (n: TrieNode | null) => {
    for (let x = n; x && !forced.has(x.id); x = x.parent) forced.add(x.id);
  };
  for (const n of input.trunk ?? []) {
    trunkIds.add(n.id);
    force(n);
  }
  if (input.forced) {
    const byId = new Map<number, TrieNode>();
    const want = new Set(input.forced);
    if (want.size) {
      const stack = [input.root];
      while (stack.length && byId.size < want.size) {
        const n = stack.pop()!;
        if (want.has(n.id)) byId.set(n.id, n);
        for (const c of n.children) stack.push(c);
      }
      for (const n of byId.values()) force(n);
    }
  }

  const solved = (n: TrieNode) => n.pattern === p.solvedCode;
  const candidates = (n: TrieNode): TrieNode[] => {
    const out: TrieNode[] = [];
    for (const c of n.children) if (massOf(c) > 0 || forced.has(c.id)) out.push(c);
    out.sort((a, b) => massOf(b) - massOf(a) || a.guess - b.guess);
    return out;
  };

  // Pass 1: visible structure.
  const decide = (t: TrieNode, width: number, onTrunk: boolean, kind: 'root' | 'node'): VNode => {
    const v = vnode(kind, t, kind === 'root' ? Math.max(massOf(t), 0) : massOf(t), onTrunk);
    if (kind === 'node') {
      if (solved(t)) return v;
      if (t.depth >= N) {
        v.children.push(vnode('out', t, v.mass, onTrunk));
        return v;
      }
    }
    const kids = candidates(t);
    if (!kids.length) return v;
    const slots = Math.max(1, Math.floor((width * L) / p.minLabel + 1e-6));
    const k = visibleCount(kids.length, slots, p.maxChildren, expanded.get(t.id) ?? 0, p.expandStep);
    let shown: TrieNode[] = kids;
    let hidden: TrieNode[] = [];
    if (k < kids.length) {
      shown = [];
      for (let i = 0; i < kids.length; i++) {
        if (i < k || forced.has(kids[i].id)) shown.push(kids[i]);
        else hidden.push(kids[i]);
      }
      if (hidden.length === 1) {
        shown = kids;
        hidden = [];
      }
    }
    const masses = shown.map((c) => massOf(c));
    let hiddenMass = 0;
    for (const h of hidden) hiddenMass += massOf(h);
    if (hidden.length) masses.push(hiddenMass);
    const widths = waterFill(width, masses.map(() => minW), masses);
    shown.forEach((c, i) => v.children.push(decide(c, widths[i], onTrunk && trunkIds.has(c.id), 'node')));
    if (hidden.length) {
      const e = vnode('ellipsis', null, hiddenMass, false);
      e.hidden = hidden;
      for (const h of hidden) e.hiddenMatches += matchesBelow(h);
      v.children.push(e);
    }
    return v;
  };
  const rootV = decide(input.root, Math.max(p.width, minW), true, 'root');
  if (rootV.mass <= 0) rootV.mass = total;

  // Pass 2: needs, bottom up. Trunk nodes need room on each side separately.
  const trunkChild = (v: VNode): VNode | null => {
    for (const c of v.children) if (c.trunk) return c;
    return null;
  };
  const measure = (v: VNode): void => {
    for (const c of v.children) measure(c);
    const own = v.kind === 'root' ? 0 : minW;
    if (!v.trunk) {
      let sum = 0;
      for (const c of v.children) sum += c.need;
      v.need = Math.max(own, sum);
      v.needL = v.needR = v.need / 2;
      return;
    }
    const tc = trunkChild(v);
    let next = 1;
    let sumR = 0;
    let sumL = 0;
    let ell: VNode | null = null;
    for (const c of v.children) {
      if (c === tc) continue;
      if (c.kind === 'ellipsis') {
        ell = c;
        continue;
      }
      c.side = next;
      if (next > 0) sumR += c.need;
      else sumL += c.need;
      next = -next;
    }
    if (ell) {
      ell.side = sumR <= sumL ? 1 : -1;
      if (ell.side > 0) sumR += ell.need;
      else sumL += ell.need;
    }
    v.needR = Math.max(own / 2, (tc ? tc.needR : 0) + sumR);
    v.needL = Math.max(own / 2, (tc ? tc.needL : 0) + sumL);
    v.need = v.needL + v.needR;
  };
  measure(rootV);

  // Pass 3: placement, top down.
  const place = (v: VNode, a: number, b: number): void => {
    v.left = a;
    v.right = b;
    if (v.trunk) {
      v.x = 0;
      const tc = trunkChild(v);
      const right = v.children.filter((c) => c !== tc && c.side > 0);
      const left = v.children.filter((c) => c !== tc && c.side < 0);
      // Ellipsis outermost on its side.
      right.sort((x, y) => Number(x.kind === 'ellipsis') - Number(y.kind === 'ellipsis'));
      left.sort((x, y) => Number(x.kind === 'ellipsis') - Number(y.kind === 'ellipsis'));
      const side = (items: VNode[], avail: number, tcNeed: number): number[] => {
        const mins = tc ? [tcNeed, ...items.map((c) => c.need)] : items.map((c) => c.need);
        const masses = tc ? [tc.mass / 2, ...items.map((c) => c.mass)] : items.map((c) => c.mass);
        return waterFill(avail, mins, masses);
      };
      const wr = side(right, b, tc ? tc.needR : 0);
      const wl = side(left, -a, tc ? tc.needL : 0);
      const tcR = tc ? wr[0] : 0;
      const tcL = tc ? wl[0] : 0;
      if (tc) place(tc, -tcL, tcR);
      let x = tcR;
      right.forEach((c, i) => {
        const w = wr[i + (tc ? 1 : 0)];
        place(c, x, x + w);
        x += w;
      });
      x = -tcL;
      left.forEach((c, i) => {
        const w = wl[i + (tc ? 1 : 0)];
        place(c, x - w, x);
        x -= w;
      });
      return;
    }
    v.x = (a + b) / 2;
    if (!v.children.length) return;
    if (v.children.length === 1) {
      place(v.children[0], a, b);
      return;
    }
    // Mass order from the trunk side outward (the ellipsis is last already).
    const order = v.x >= 0 ? v.children : [...v.children].reverse();
    const widths = waterFill(
      b - a,
      order.map((c) => c.need),
      order.map((c) => c.mass),
    );
    let x = a;
    order.forEach((c, i) => {
      place(c, x, x + widths[i]);
      x += widths[i];
    });
  };
  const halfW = Math.max(p.width, minW) / 2;
  place(rootV, -Math.max(rootV.needL, halfW), Math.max(rootV.needR, halfW));

  // Emit LNodes with keys, bands, y and river stacking.
  const nodes: LNode[] = [];
  const byKey = new Map<string, LNode>();
  const byTrie = new Map<number, LNode>();
  let minX = Infinity;
  let maxX = -Infinity;
  const emit = (v: VNode, parent: LNode | null): LNode => {
    let key: string;
    let band: number;
    if (v.kind === 'root') {
      key = 'r';
      band = 0;
    } else if (v.kind === 'node') {
      key = `${parent!.key}/${v.trie!.guess}`;
      band = v.trie!.depth;
    } else if (v.kind === 'ellipsis') {
      key = `${parent!.key}/…`;
      band = parent!.band + 1;
    } else {
      key = `${parent!.key}/x`;
      band = N + 1;
    }
    const l: LNode = {
      key,
      kind: v.kind,
      trie: v.trie,
      parent,
      children: [],
      band,
      x: v.x,
      y: bandY(band, p),
      left: v.left,
      right: v.right,
      mass: v.mass,
      trunk: v.trunk,
      side: v.trunk ? 0 : v.x < 0 ? -1 : 1,
      riverOffset: 0,
      riverWidth: riverPx(v.mass, p.riverScale),
      hidden: v.hidden,
      hiddenMass: v.kind === 'ellipsis' ? v.mass : 0,
      hiddenMatches: v.hiddenMatches,
      index: nodes.length,
    };
    nodes.push(l);
    byKey.set(key, l);
    if (v.trie && (v.kind === 'node' || v.kind === 'root')) byTrie.set(v.trie.id, l);
    if (l.left < minX) minX = l.left;
    if (l.right > maxX) maxX = l.right;
    const kids = v.children.map((c) => emit(c, l));
    kids.sort((x, y) => x.x - y.x);
    l.children = kids;
    stackRivers(l);
    return l;
  };
  const root = emit(rootV, null);
  return {
    nodes,
    byKey,
    byTrie,
    root,
    minX: Number.isFinite(minX) ? minX : -p.width / 2,
    maxX: Number.isFinite(maxX) ? maxX : p.width / 2,
    top: p.headerHeight,
    bottom: -(N + 1) * p.bandHeight,
    params: p,
  };
}

/**
 * Sankey stacking of the rivers leaving a node, left to right by the
 * children's x: the trunk child's river stays centred (so the trunk is
 * straight) with the others stacked beside it; otherwise the bundle is centred.
 */
function stackRivers(l: LNode): void {
  const kids = l.children;
  if (!kids.length) return;
  const t = kids.findIndex((c) => c.trunk);
  if (t >= 0) {
    kids[t].riverOffset = 0;
    let x = kids[t].riverWidth / 2;
    for (let i = t + 1; i < kids.length; i++) {
      kids[i].riverOffset = x + kids[i].riverWidth / 2;
      x += kids[i].riverWidth;
    }
    x = -kids[t].riverWidth / 2;
    for (let i = t - 1; i >= 0; i--) {
      kids[i].riverOffset = x - kids[i].riverWidth / 2;
      x -= kids[i].riverWidth;
    }
    return;
  }
  let totalW = 0;
  for (const c of kids) totalW += c.riverWidth;
  let x = -totalW / 2;
  for (const c of kids) {
    c.riverOffset = x + c.riverWidth / 2;
    x += c.riverWidth;
  }
}

/** Nodes from the first guess down to `n` (root excluded). */
export function pathOf(n: TrieNode): TrieNode[] {
  const out: TrieNode[] = [];
  for (let x: TrieNode | null = n; x && x.parent; x = x.parent) out.push(x);
  return out.reverse();
}

/** Extend a path along the heaviest children (by layout mass) to a leaf. */
export function extendHeaviest(path: TrieNode[], root: TrieNode, massOf: (n: TrieNode) => number = (n) => n.mass): TrieNode[] {
  const out = path.slice();
  let n = out.length ? out[out.length - 1] : root;
  for (;;) {
    let best: TrieNode | null = null;
    for (const c of n.children) {
      const m = massOf(c);
      if (m <= 0) continue;
      if (!best || m > massOf(best) || (m === massOf(best) && c.guess < best.guess)) best = c;
    }
    if (!best) return out;
    out.push(best);
    n = best;
  }
}

/** A node's layout-visible ancestor chain as layout nodes (itself first), or [] if it is not laid out. */
export function layoutPath(layout: Layout, trieId: number): LNode[] {
  const l = layout.byTrie.get(trieId);
  const out: LNode[] = [];
  for (let x: LNode | null = l ?? null; x; x = x.parent) out.push(x);
  return out;
}
