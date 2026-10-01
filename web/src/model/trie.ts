// Target trie: the prefix trie of every game against one target. Owned by the platform agent.
//
// A node is a game state: the guesses so far (feedback is implied by the
// fixed target). Strategy games add mass along their path; player games are
// inserted as flagged paths with no mass.

import { PHASE_PLAYER, type Game } from '../backend/types';
import type { TargetTree, TrieNode } from './types';

/** Strategy games remembered per node in `sampleGames`. */
export const SAMPLE_GAMES_CAP = 16;
/** Children kept in a list below this count; above it a Map indexes them by guess. */
const MAP_AT = 12;

interface Node extends TrieNode {
  parent: Node | null;
  children: Node[];
  /** Children by guess word id (large fan-outs only). */
  byGuess: Map<number, Node> | null;
  /** Sum of p_chosen over strategy games through this node (pEdge = pSum / mass). */
  pSum: number;
  /** Cached sortedChildren and the trie version it was computed at. */
  sorted: Node[] | null;
  sortedAt: number;
}

export class TargetTrie implements TargetTree {
  root!: TrieNode;
  nodes: TrieNode[] = [];
  games: Game[] = [];
  totalMass = 0;
  version = 0;
  /** Number of player games inserted. */
  playerCount = 0;
  constructor(
    public target: number,
    public maxGuesses: number,
  ) {
    this.root = this.makeNode(null, 0, -1, 0);
  }

  private makeNode(parent: Node | null, depth: number, guess: number, pattern: number): Node {
    const node: Node = {
      id: this.nodes.length,
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
      pEdge: 0,
      byGuess: null,
      pSum: 0,
      sorted: null,
      sortedAt: -1,
    };
    this.nodes.push(node);
    if (parent) {
      parent.children.push(node);
      if (parent.byGuess) parent.byGuess.set(guess, node);
      else if (parent.children.length > MAP_AT) {
        parent.byGuess = new Map(parent.children.map((c) => [c.guess, c]));
      }
    }
    return node;
  }

  private child(node: Node, guess: number, pattern: number): Node {
    let c: Node | undefined;
    if (node.byGuess) c = node.byGuess.get(guess);
    else {
      for (const x of node.children) {
        if (x.guess === guess) {
          c = x;
          break;
        }
      }
    }
    return c ?? this.makeNode(node, node.depth + 1, guess, pattern);
  }

  /** Add strategy games (games for other targets and player games are handled separately). */
  ingest(games: Game[]): void {
    let changed = false;
    for (const g of games) {
      if (g.target !== this.target) continue;
      if (g.isPlayer) {
        this.addPlayer(g);
        continue;
      }
      const gi = this.games.length;
      this.games.push(g);
      let node = this.root as Node;
      node.mass++;
      if (node.sampleGames.length < SAMPLE_GAMES_CAP) node.sampleGames.push(gi);
      for (const t of g.turns) {
        node = this.child(node, t.guess, t.pattern);
        node.mass++;
        node.pSum += t.pChosen;
        node.pEdge = node.pSum / node.mass;
        if (node.sampleGames.length < SAMPLE_GAMES_CAP) node.sampleGames.push(gi);
      }
      if (g.turns.length) {
        if (g.solved) node.endSolved++;
        else node.endFailed++;
      }
      this.totalMass++;
      changed = true;
    }
    if (changed) this.version++;
  }

  /** Insert a player game as a flagged path with no mass; returns its leaf. */
  addPlayer(game: Game): TrieNode {
    let node = this.root as Node;
    node.player = true;
    for (const t of game.turns) {
      node = this.child(node, t.guess, t.pattern);
      node.player = true;
    }
    const dup = this.games.some(
      (g) => g.isPlayer && g.turns.length === game.turns.length && g.turns.every((t, i) => t.guess === game.turns[i].guess),
    );
    if (!dup) {
      this.games.push({ ...game, isPlayer: true, turns: game.turns.map((t) => ({ ...t, phase: t.phase ?? PHASE_PLAYER })) });
      this.playerCount++;
    }
    this.version++;
    return node;
  }

  /** Nodes from the first guess down to `node` (the root is not included). */
  pathTo(node: TrieNode): TrieNode[] {
    const out: TrieNode[] = [];
    for (let n: TrieNode | null = node; n && n.parent; n = n.parent) out.push(n);
    return out.reverse();
  }

  /** Guess word ids along the path to a node. */
  guessesTo(node: TrieNode): number[] {
    return this.pathTo(node).map((n) => n.guess);
  }

  /** The node reached by a guess sequence, or null if the trie has no such path. */
  find(guesses: number[]): TrieNode | null {
    let node = this.root as Node;
    for (const g of guesses) {
      let c: Node | undefined;
      if (node.byGuess) c = node.byGuess.get(g);
      else c = node.children.find((x) => x.guess === g);
      if (!c) return null;
      node = c;
    }
    return node;
  }

  /** Children sorted by descending mass (ties by word id). */
  sortedChildren(node: TrieNode): TrieNode[] {
    const n = node as Node;
    if (n.sorted && n.sortedAt === this.version) return n.sorted;
    const s = [...n.children].sort((a, b) => b.mass - a.mass || a.guess - b.guess);
    n.sorted = s;
    n.sortedAt = this.version;
    return s;
  }

  /** Whether a node ends games (the guess solved, or it was the last allowed guess). */
  isTerminal(node: TrieNode): boolean {
    return node.endSolved + node.endFailed > 0;
  }

  /** Number of distinct strategy paths (leaves with mass). */
  breadth(): number {
    let n = 0;
    for (const x of this.nodes) if (x.endSolved + x.endFailed > 0) n++;
    return n;
  }
}
