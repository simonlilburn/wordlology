// Target browser data: per-target statistics from the focused card run (R games
// per target), sort orders, and the thumbnail layout of each target's tree.
// Pure (no DOM), so it is unit-tested.
import type { Game } from '../../backend/types';
import type { Run } from '../../model/types';
import { mulberry32 } from '../util';
import type { TargetSort } from '../state.svelte';

export interface TargetStats {
  target: number;
  /** Strategy games against this target, in arrival order. */
  games: Game[];
  /** Mean guesses (a failure counts as max guesses). */
  mean: number;
  failRate: number;
  /** Distinct paths (guess sequences). */
  breadth: number;
  /** Game counts per outcome row: index k-1 for "solved in k", last for X. */
  outcomes: number[];
  /** Internal: distinct path keys. */
  paths: Set<string>;
  sumGuesses: number;
  fails: number;
}

/** Groups a run's games by target incrementally (the games array only grows). */
export class TargetIndex {
  runKey = '';
  processed = 0;
  byTarget = new Map<number, TargetStats>();
  /** Increments whenever stats change. */
  version = 0;

  constructor(public maxGuesses: number) {}

  reset(runKey: string, maxGuesses: number): void {
    this.runKey = runKey;
    this.maxGuesses = maxGuesses;
    this.processed = 0;
    this.byTarget.clear();
    this.version++;
  }

  /** Ingest new games of `run` (resetting when the run changes). Returns whether anything changed. */
  sync(run: Pick<Run, 'key' | 'games' | 'config'> | null): boolean {
    if (!run) {
      if (this.runKey !== '') {
        this.reset('', this.maxGuesses);
        return true;
      }
      return false;
    }
    const mg = run.config?.rules?.max_guesses ?? this.maxGuesses;
    if (run.key !== this.runKey || mg !== this.maxGuesses) this.reset(run.key, mg);
    const games = run.games;
    if (games.length === this.processed) return false;
    for (let i = this.processed; i < games.length; i++) this.add(games[i]);
    this.processed = games.length;
    this.version++;
    return true;
  }

  add(g: Game): void {
    if (g.isPlayer) return;
    let s = this.byTarget.get(g.target);
    if (!s) {
      s = {
        target: g.target,
        games: [],
        mean: NaN,
        failRate: NaN,
        breadth: 0,
        outcomes: new Array(this.maxGuesses + 1).fill(0),
        paths: new Set(),
        sumGuesses: 0,
        fails: 0,
      };
      this.byTarget.set(g.target, s);
    }
    s.games.push(g);
    const n = g.turns.length;
    s.sumGuesses += n;
    if (!g.solved) s.fails++;
    const row = g.solved ? Math.min(n, this.maxGuesses) - 1 : this.maxGuesses;
    s.outcomes[row]++;
    s.paths.add(g.turns.map((t) => t.guess).join(','));
    s.breadth = s.paths.size;
    s.mean = s.sumGuesses / s.games.length;
    s.failRate = s.fails / s.games.length;
  }
}

function cmpDesc(a: number, b: number): number {
  const an = Number.isNaN(a);
  const bn = Number.isNaN(b);
  if (an || bn) return an === bn ? 0 : an ? 1 : -1; // unseen targets last
  return b - a;
}

/**
 * Order of targets for the browser. `targets` are answer indices (answer
 * order is alphabetical, so 'alpha' keeps index order).
 */
export function sortTargets(targets: number[], stats: Map<number, TargetStats>, sort: TargetSort, seed = 1): number[] {
  const out = targets.slice();
  const st = (t: number) => stats.get(t);
  switch (sort) {
    case 'alpha':
      out.sort((a, b) => a - b);
      break;
    case 'mean':
      out.sort((a, b) => cmpDesc(st(a)?.mean ?? NaN, st(b)?.mean ?? NaN) || cmpDesc(st(a)?.failRate ?? NaN, st(b)?.failRate ?? NaN) || a - b);
      break;
    case 'fail':
      out.sort((a, b) => cmpDesc(st(a)?.failRate ?? NaN, st(b)?.failRate ?? NaN) || cmpDesc(st(a)?.mean ?? NaN, st(b)?.mean ?? NaN) || a - b);
      break;
    case 'breadth':
      out.sort((a, b) => cmpDesc(st(a) ? st(a)!.breadth : NaN, st(b) ? st(b)!.breadth : NaN) || a - b);
      break;
    case 'random': {
      out.sort((a, b) => a - b);
      const r = mulberry32(seed);
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      break;
    }
  }
  return out;
}

/** Index of the first target (in `order`) whose word starts with `letter`, or -1. */
export function firstWithLetter(order: number[], wordOf: (t: number) => string, letter: string): number {
  const l = letter.toLowerCase();
  for (let i = 0; i < order.length; i++) if (wordOf(order[i])?.[0] === l) return i;
  return -1;
}

// ---------------------------------------------------------------------------
// Thumbnail layout

export interface ThumbEdge {
  /** Horizontal positions in [0, 1] of parent and child; depths of parent and child (root = 0). */
  x0: number;
  x1: number;
  d0: number;
  d1: number;
  /** Share of the target's games carried. */
  share: number;
  trunk: boolean;
}

export interface ThumbEnd {
  x: number;
  /** Row of the end: guess number when solved, maxGuesses + 1 for failures. */
  d: number;
  solved: boolean;
  share: number;
}

export interface ThumbLayout {
  edges: ThumbEdge[];
  ends: ThumbEnd[];
  /** Outcome shares per row (maxGuesses + 1). */
  shares: number[];
  games: number;
}

interface MiniNode {
  guess: number;
  depth: number;
  mass: number;
  solved: number;
  failed: number;
  children: Map<number, MiniNode>;
}

/**
 * Layout of a target's tree for a thumbnail. The heaviest child continues
 * straight below its parent (so the most likely path is a vertical trunk at
 * the centre); siblings alternate right and left, each as wide as its share.
 */
export function layoutThumb(games: Game[], maxGuesses: number): ThumbLayout {
  const root: MiniNode = { guess: -1, depth: 0, mass: 0, solved: 0, failed: 0, children: new Map() };
  const shares = new Array(maxGuesses + 1).fill(0);
  let n = 0;
  for (const g of games) {
    if (g.isPlayer) continue;
    n++;
    root.mass++;
    let node = root;
    for (const t of g.turns) {
      let c = node.children.get(t.guess);
      if (!c) {
        c = { guess: t.guess, depth: node.depth + 1, mass: 0, solved: 0, failed: 0, children: new Map() };
        node.children.set(t.guess, c);
      }
      c.mass++;
      node = c;
    }
    if (g.solved) node.solved++;
    else node.failed++;
    shares[g.solved ? Math.min(g.turns.length, maxGuesses) - 1 : maxGuesses]++;
  }
  const edges: ThumbEdge[] = [];
  const ends: ThumbEnd[] = [];
  if (n === 0) return { edges, ends, shares, games: 0 };
  for (let i = 0; i < shares.length; i++) shares[i] /= n;

  const visit = (node: MiniNode, x: number, trunk: boolean) => {
    if (node.solved) ends.push({ x, d: node.depth, solved: true, share: node.solved / n });
    if (node.failed) ends.push({ x, d: maxGuesses + 1, solved: false, share: node.failed / n });
    const kids = [...node.children.values()].sort((a, b) => b.mass - a.mass || a.guess - b.guess);
    let right = 0; // offset of the right edge of the right side
    let left = 0;
    kids.forEach((k, i) => {
      const w = k.mass / n;
      let cx: number;
      if (i === 0) {
        cx = x;
        right = w / 2;
        left = w / 2;
      } else if (i % 2 === 1) {
        cx = x + right + w / 2;
        right += w;
      } else {
        cx = x - left - w / 2;
        left += w;
      }
      const isTrunk = trunk && i === 0;
      edges.push({ x0: x, x1: cx, d0: node.depth, d1: k.depth, share: w, trunk: isTrunk });
      visit(k, cx, isTrunk);
    });
  };
  visit(root, 0.5, true);
  return { edges, ends, shares, games: n };
}
