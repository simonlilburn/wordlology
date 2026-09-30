// Which of a tree's strategy games are on screen (growth animation), the
// revealed mass per node, and when each node first appeared (for the
// draw-on). Pure: works on any TargetTree.

import type { Game } from '../../backend/types';
import type { TargetTree, TrieNode } from '../../model/types';
import { RevealQueue, sharedDepth } from './growth';

function childOf(n: TrieNode, guess: number): TrieNode | null {
  for (const c of n.children) if (c.guess === guess) return c;
  return null;
}

/** Nodes of a game's path, root first (null if the trie does not have it yet). */
export function gamePath(tree: TargetTree, g: Game): TrieNode[] | null {
  const out: TrieNode[] = [tree.root];
  let n: TrieNode = tree.root;
  for (const t of g.turns) {
    const c = childOf(n, t.guess);
    if (!c) return null;
    out.push(c);
    n = c;
  }
  return out;
}

export class RevealState {
  /** Games (by index into tree.games) scanned into the queue so far. */
  private scanned = 0;
  private queue = new RevealQueue<number>();
  /** Revealed strategy games. */
  count = 0;
  /** Revealed mass per node id. */
  mass: Float64Array = new Float64Array(64);
  /** Scene time (ms) at which a node's river starts to draw, and how long it takes; NaN = not yet shown. */
  start: Float64Array = new Float64Array(64).fill(NaN);
  dur: Float32Array = new Float32Array(64);
  /** Revealed games whose river segments are still drawing (for animation). */
  lastDrawEnd = 0;

  constructor(
    public tree: TargetTree,
    private trunk: readonly number[] = [],
  ) {}

  private ensure(n: number): void {
    if (n <= this.mass.length) return;
    let cap = this.mass.length;
    while (cap < n) cap *= 2;
    const m = new Float64Array(cap);
    m.set(this.mass);
    const s = new Float64Array(cap).fill(NaN);
    s.set(this.start);
    const d = new Float32Array(cap);
    d.set(this.dur);
    this.mass = m;
    this.start = s;
    this.dur = d;
  }

  /** Change the priority path (the trunk's guesses); affects games not yet queued only. */
  setTrunk(guesses: readonly number[]): void {
    this.trunk = guesses;
  }

  /** Queue strategy games that arrived since the last scan. */
  scan(): void {
    const games = this.tree.games;
    for (; this.scanned < games.length; this.scanned++) {
      const g = games[this.scanned];
      if (g.isPlayer) continue;
      this.queue.push(this.scanned, sharedDepth(g.turns.map((t) => t.guess), this.trunk));
    }
  }

  /** Games computed and waiting to be revealed. */
  get pending(): number {
    return this.queue.size;
  }

  /** Games available so far (revealed + waiting). */
  get available(): number {
    return this.count + this.queue.size;
  }

  /**
   * Reveal the next game: its path's revealed mass grows and nodes that were
   * not on screen get a draw-on slot, one after another over `drawMs`.
   * Returns false when nothing is waiting.
   */
  revealNext(now: number, drawMs: number): boolean {
    const gi = this.queue.pop();
    if (gi === undefined) return false;
    const g = this.tree.games[gi];
    const path = gamePath(this.tree, g);
    this.count++;
    if (!path) return true;
    this.ensure(this.tree.nodes.length);
    let fresh = 0;
    for (const n of path) if (this.mass[n.id] === 0 && Number.isNaN(this.start[n.id])) fresh++;
    const seg = fresh > 0 ? drawMs / fresh : 0;
    let k = 0;
    for (const n of path) {
      if (this.mass[n.id] === 0 && Number.isNaN(this.start[n.id])) {
        this.start[n.id] = now + k * seg;
        this.dur[n.id] = seg;
        k++;
      }
      this.mass[n.id] += 1;
    }
    this.lastDrawEnd = Math.max(this.lastDrawEnd, now + drawMs);
    return true;
  }

  /** Reveal everything waiting (Skip, growth off, or streaming after the growth). */
  revealAll(now: number, drawMs: number): number {
    let n = 0;
    while (this.revealNext(now, drawMs)) n++;
    return n;
  }

  /** Mark a node as shown without a draw-on (player paths, forced nodes). */
  showNow(n: TrieNode): void {
    this.ensure(n.id + 1);
    if (Number.isNaN(this.start[n.id])) {
      this.start[n.id] = -Infinity;
      this.dur[n.id] = 0;
    }
  }

  massOf = (n: TrieNode): number => (n.id < this.mass.length ? this.mass[n.id] : 0);

  /** Draw-on progress of the river into a node at time `now` (1 when fully drawn or never animated). */
  progress(id: number, now: number): number {
    if (id >= this.start.length) return 1;
    const s = this.start[id];
    if (Number.isNaN(s)) return 1;
    const d = this.dur[id];
    if (!(d > 0)) return now >= s ? 1 : 0;
    return Math.min(1, Math.max(0, (now - s) / d));
  }

  /** Whether any river is still drawing at `now`. */
  drawing(now: number): boolean {
    return now < this.lastDrawEnd;
  }
}
