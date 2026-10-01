// Small trie builder for the tree layout tests (mirrors model/trie.ts, which
// the platform owns, closely enough for layout purposes).

import type { TrieNode } from '../../model/types';

export interface FixtureTree {
  root: TrieNode;
  nodes: TrieNode[];
  /** Add a game as a guess sequence; `solved` marks the last guess as the target. */
  add(guesses: number[], opts?: { solved?: boolean; player?: boolean; times?: number }): TrieNode;
  find(guesses: number[]): TrieNode | null;
}

export const SOLVED = 242; // 3^5 - 1

export function fixtureTree(): FixtureTree {
  const nodes: TrieNode[] = [];
  const make = (parent: TrieNode | null, depth: number, guess: number, pattern: number): TrieNode => {
    const n: TrieNode = {
      id: nodes.length,
      parent,
      depth,
      guess,
      pattern,
      mass: 0,
      endSolved: 0,
      endFailed: 0,
      children: [],
      player: false,
      sampleGames: [],
      pEdge: 1,
    };
    nodes.push(n);
    if (parent) parent.children.push(n);
    return n;
  };
  const root = make(null, 0, -1, 0);
  const find = (guesses: number[]): TrieNode | null => {
    let n: TrieNode = root;
    for (const g of guesses) {
      const c = n.children.find((x) => x.guess === g);
      if (!c) return null;
      n = c;
    }
    return n;
  };
  const add = (guesses: number[], opts: { solved?: boolean; player?: boolean; times?: number } = {}): TrieNode => {
    const times = opts.times ?? 1;
    let n: TrieNode = root;
    if (!opts.player) root.mass += times;
    else root.player = true;
    guesses.forEach((g, i) => {
      const last = i === guesses.length - 1;
      const pattern = last && opts.solved ? SOLVED : (g * 7) % 242;
      let c = n.children.find((x) => x.guess === g);
      if (!c) c = make(n, n.depth + 1, g, pattern);
      if (opts.player) c.player = true;
      else c.mass += times;
      n = c;
    });
    if (!opts.player) {
      if (opts.solved) n.endSolved += times;
      else n.endFailed += times;
    }
    return n;
  };
  return { root, nodes, add, find };
}
