// Descriptions of nodes and paths in a target tree, shared by the path
// tooltip and the text outline. Pure.

import type { TrieNode } from '../../model/types';

export interface PathRow {
  word: string;
  pattern: number;
  /** Share of games from the previous guess that chose this one. */
  p: number;
  player: boolean;
}

export interface PathInfo {
  rows: PathRow[];
  outcome: string;
  /** Games through the path's last node and the tree's total. */
  mass: number;
  total: number;
  prob: number;
  solved: boolean;
  failed: boolean;
}

const intFmt = new Intl.NumberFormat('en-GB');
export function fmtInt(n: number): string {
  return Number.isFinite(n) ? intFmt.format(Math.round(n)) : '–';
}

export function fmtProb(p: number): string {
  if (!Number.isFinite(p)) return '–';
  if (p >= 0.1) return (p * 100).toFixed(0) + '%';
  if (p >= 0.01) return (p * 100).toFixed(1) + '%';
  if (p > 0) return (p * 100).toPrecision(2) + '%';
  return '0%';
}

export function pathNodes(node: TrieNode): TrieNode[] {
  const out: TrieNode[] = [];
  for (let n: TrieNode | null = node; n && n.parent; n = n.parent) out.push(n);
  return out.reverse();
}

export function isSolvedNode(n: TrieNode, wordLength: number): boolean {
  return n.pattern === Math.pow(3, wordLength) - 1;
}

export function outcomeOf(node: TrieNode, maxGuesses: number, wordLength: number): { text: string; solved: boolean; failed: boolean } {
  const solved = isSolvedNode(node, wordLength);
  if (solved) return { text: `Solved in ${node.depth}`, solved, failed: false };
  if (node.depth >= maxGuesses) return { text: `Not solved in ${maxGuesses}`, solved: false, failed: true };
  if (node.mass === 0 && node.player) return { text: 'Your game (unfinished)', solved: false, failed: false };
  return { text: `${fmtInt(node.mass)} game${node.mass === 1 ? '' : 's'} continue from here`, solved: false, failed: false };
}

export function pathInfo(node: TrieNode, guesses: readonly string[], total: number, maxGuesses: number, wordLength: number): PathInfo {
  const nodes = pathNodes(node);
  const o = outcomeOf(node, maxGuesses, wordLength);
  let outcome = o.text;
  if (node.mass === 0 && node.player && (o.solved || o.failed)) outcome += ' · your game (carries no mass)';
  return {
    rows: nodes.map((n) => ({ word: (guesses[n.guess] ?? '?').toUpperCase(), pattern: n.pattern, p: n.pEdge, player: n.player && n.mass === 0 })),
    outcome,
    mass: node.mass,
    total,
    prob: total > 0 ? node.mass / total : 0,
    solved: o.solved,
    failed: o.failed,
  };
}

const CELL_WORDS = ['absent', 'present', 'correct'];

/** "CRANE: C absent, R present, A correct, N absent, E absent". */
export function describeFeedback(word: string, code: number): string {
  const len = [...word].length;
  const parts: string[] = [];
  let c = code;
  for (let i = 0; i < len; i++) {
    parts.push(`${word[i].toUpperCase()} ${CELL_WORDS[c % 3]}`);
    c = Math.floor(c / 3);
  }
  return `${word.toUpperCase()}: ${parts.join(', ')}`;
}

/** Cells of a feedback code (0 absent, 1 present, 2 correct). */
export function cells(code: number, len: number): number[] {
  const out: number[] = [];
  let c = code;
  for (let i = 0; i < len; i++) {
    out.push(c % 3);
    c = Math.floor(c / 3);
  }
  return out;
}

/** One outline row's accessible label. */
export function nodeLabel(n: TrieNode, word: string, total: number, maxGuesses: number, wordLength: number, match: boolean): string {
  const o = outcomeOf(n, maxGuesses, wordLength);
  const games = n.mass > 0 ? `${fmtInt(n.mass)} game${n.mass === 1 ? '' : 's'} (${fmtProb(total > 0 ? n.mass / total : 0)})` : 'no strategy games';
  const bits = [`Guess ${n.depth}: ${describeFeedback(word, n.pattern)}`, games];
  if (o.solved) bits.push(`${fmtInt(n.endSolved)} solved here`);
  else if (o.failed) bits.push(`${fmtInt(n.endFailed)} not solved`);
  if (n.player) bits.push('your game');
  if (match) bits.push('matches the filter');
  return bits.join('; ');
}
