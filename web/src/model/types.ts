// Shared data-model contracts used by the views and the scene.
// Implementations live beside this file (see docs/architecture.md, "Frontend").

import type { AnswerSelection, Config, Game, Priority, ProgressEvent, Scope, SummaryEvent, WordListManifest } from '../backend/types';

/** A loaded word list on the main thread. */
export interface WordData {
  manifest: WordListManifest;
  /** The answer selection this data was built for. */
  selection: AnswerSelection;
  wordLength: number;
  /** Word id -> word (guesses.txt order). */
  guesses: string[];
  /** Answer index -> word id. */
  answers: number[];
  /** Word id -> answer index, or -1. */
  answerOf: Int32Array;
  /** Word -> word id. */
  index: Map<string, number>;
  /** Zipf per word id, if the list has frequencies. */
  zipf: Float32Array | null;
  /** answers-ranked.txt words, most frequent first, if present. */
  ranked: string[] | null;
  /** Raw file texts, handed to solver workers. */
  texts: { guesses: string; answers: string; frequencies: string | null };
}

export type RunStatus = 'queued' | 'running' | 'paused' | 'done' | 'error' | 'cancelled';

/** A (config, scope) job and everything it has produced so far. */
export interface Run {
  /** `${configId}|${scopeKey}`. */
  key: string;
  configId: string;
  config: Config;
  scope: Scope;
  /** Games in arrival order. Only ever appended to. */
  games: Game[];
  progress: ProgressEvent | null;
  summary: SummaryEvent | null;
  status: RunStatus;
  error: string | null;
  deterministic: boolean;
  /** Phase labels, indexed by Turn.phase (filled from the summary, or earlier from the worker). */
  phases: string[];
  /** Increments on every change; cheap to poll from requestAnimationFrame. */
  version: number;
  priority: Priority;
  onChange(cb: (run: Run) => void): () => void;
  setPriority(p: Priority): void;
  cancel(): void;
}

/** A node of a target tree (a prefix trie of games against one target). */
export interface TrieNode {
  /** Unique within its tree; the root is 0. */
  id: number;
  parent: TrieNode | null;
  /** Guess number of this node's guess (1-based); the root is 0. */
  depth: number;
  /** Word id of this node's guess (-1 for the root). */
  guess: number;
  /** Feedback code of the guess against the tree's target. */
  pattern: number;
  /** Strategy games passing through this node (player games carry no mass). */
  mass: number;
  /** Strategy games that end here solved (this guess was the target). */
  endSolved: number;
  /** Strategy games that end here unsolved (this was the last allowed guess). */
  endFailed: number;
  children: TrieNode[];
  /** Whether a player path passes through this node. */
  player: boolean;
  /** Indices (into the tree's games array) of strategy games passing through, in arrival order, capped for memory. */
  sampleGames: number[];
  /** Mean probability of reaching this node from its parent (for the path readout). */
  pEdge: number;
}

export interface TargetTree {
  target: number;
  root: TrieNode;
  /** All nodes by id. */
  nodes: TrieNode[];
  /** Games ingested (strategy games first as they arrive, player games flagged). */
  games: Game[];
  totalMass: number;
  version: number;
  ingest(games: Game[]): void;
  /** Insert a player game as a flagged path with no mass; returns its leaf. */
  addPlayer(game: Game): TrieNode;
  pathTo(node: TrieNode): TrieNode[];
  /** Children sorted by descending mass (ties by word id). */
  sortedChildren(node: TrieNode): TrieNode[];
}

/** Outcome rows: index k-1 for "solved in k" (k = 1..maxGuesses), last index for X. */
export interface CardSnapshot {
  maxGuesses: number;
  /** Weighted game counts per row (weights sum to the number of games for equal weighting). */
  counts: number[];
  /** Estimated P(K = row). */
  shares: number[];
  /** 95% band per row [lo, hi]; equal to the share when exact. */
  bands: [number, number][];
  /** Standard error per row across replicates (stochastic, complete); null otherwise. */
  shareSe: number[] | null;
  /** Mean guesses; a failure counts max guesses. */
  mean: number;
  meanSe: number | null;
  sd: number;
  /** Median and 95th percentile of guesses, a failure counting max guesses + 1. */
  median: number;
  p95: number;
  solveRate: number;
  nGames: number;
  nTargetsDone: number;
  nTargets: number;
  complete: boolean;
  deterministic: boolean;
  /** Deterministic progressive fill. */
  settledDepth?: number;
  unresolved?: number;
}

export interface RunManager {
  /** Start (or join) a run; runs are shared by key. */
  request(config: Config, scope: Scope, priority?: Priority): Run;
  get(key: string): Run | undefined;
  /** Compute a config ID (async: the solver computes it). */
  configId(config: Config): Promise<string>;
}
