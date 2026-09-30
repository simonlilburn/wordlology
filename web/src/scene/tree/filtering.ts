// Letter filter over a target trie (pure): which nodes match, which paths run
// through a match, the isolate-mode masses, badges and "Reveal matches".

import type { TrieNode } from '../../model/types';

export interface TreeFilter {
  mode: 'highlight' | 'isolate';
  /** Per node id: the node matches. */
  match: Uint8Array;
  /** Per node id: some node on the path from the root to it (inclusive) matches. */
  above: Uint8Array;
  /** Per node id: matching nodes in its subtree (inclusive). */
  below: Uint32Array;
  /** Per node id: games through the node that touch a match anywhere on their path (isolate mass). */
  fmass: Float64Array;
  /** Totals for the readout. */
  nodesMatched: number;
  gamesTouching: number;
  /** Matching nodes per guess number (index 0 = guess 1). */
  perRow: number[];
}

/** Nodes in breadth-first order (parents before children). */
export function bfsOrder(root: TrieNode): TrieNode[] {
  const out: TrieNode[] = [root];
  for (let i = 0; i < out.length; i++) for (const c of out[i].children) out.push(c);
  return out;
}

/**
 * Compute match data for every node. `matches(n)` decides a single node
 * (scope included); the root never matches. `size` bounds the node ids.
 */
export function computeTreeFilter(root: TrieNode, size: number, matches: (n: TrieNode) => boolean, mode: 'highlight' | 'isolate', maxGuesses: number): TreeFilter {
  const order = bfsOrder(root);
  let n = size;
  for (const x of order) if (x.id + 1 > n) n = x.id + 1;
  const match = new Uint8Array(n);
  const above = new Uint8Array(n);
  const below = new Uint32Array(n);
  const fmass = new Float64Array(n);
  const perRow = new Array<number>(maxGuesses).fill(0);
  let nodesMatched = 0;
  for (const x of order) {
    const m = x.parent !== null && matches(x);
    if (m) {
      match[x.id] = 1;
      nodesMatched++;
      if (x.depth >= 1 && x.depth <= maxGuesses) perRow[x.depth - 1]++;
    }
    above[x.id] = m || (x.parent !== null && above[x.parent.id] === 1) ? 1 : 0;
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const x = order[i];
    below[x.id] += match[x.id];
    if (above[x.id]) fmass[x.id] = x.mass;
    else {
      let s = 0;
      for (const c of x.children) s += fmass[c.id];
      fmass[x.id] = s;
    }
    if (x.parent) below[x.parent.id] += below[x.id];
  }
  return { mode, match, above, below, fmass, nodesMatched, gamesTouching: fmass[root.id], perRow };
}

/** Whether a node sits on a path through a match (drawn at full strength in highlight mode). */
export function onMatchedPath(f: TreeFilter, n: TrieNode): boolean {
  return f.above[n.id] === 1 || f.below[n.id] > 0;
}

/**
 * "Reveal matches": the ids of the heaviest matching nodes (at most `limit`),
 * whose paths the layout forces visible, expanding just enough streams.
 */
export function revealMatchIds(root: TrieNode, f: TreeFilter, limit = 50): number[] {
  const matched: TrieNode[] = [];
  for (const x of bfsOrder(root)) if (f.match[x.id]) matched.push(x);
  matched.sort((a, b) => b.mass - a.mass || a.depth - b.depth || a.id - b.id);
  return matched.slice(0, limit).map((x) => x.id);
}
