// The one shared store: zoom value, configuration, focus, filter and settings.
// Svelte components read and write it reactively; the three.js scene reads it
// on each animation frame (plain property reads, no subscriptions), so Svelte
// updates never trigger scene work.
//
// Ownership: each area adds fields only inside its own namespace object
// (game, tree, card, atlas, lab, ui, ...). Shared fields at the top level are
// changed only through the helpers in app/actions.ts.

import type { Config, StrategySpec } from '../backend/types';
import type { WordData } from '../model/types';

export type Level = 0 | 1 | 2 | 3;
export const LEVEL_NAMES = ['Game', 'Tree', 'Card', 'Atlas'] as const;

/** Settings that are part of the configuration (a change gives a new config ID). */
export interface ResultSettings {
  maxGuesses: number;
  hardMode: boolean;
  /** Default: the 2,500 most frequent reviewed answers. */
  answers: { kind: 'default' } | { kind: 'top'; n: number } | { kind: 'pasted'; words: string[] };
  arrivalStrategy: StrategySpec;
  /** Guess pool for information-based stochastic strategies. */
  stochasticPool: 'candidates' | 'allowed';
  replicatesTree: number;
  replicatesCard: number;
  weighting: 'equal' | 'frequency';
  baseSeed: number;
  rankStrategySet: 'all' | string[];
  rankOpenerSet: { kind: 'answers' } | { kind: 'allowed' } | { kind: 'top_info'; n: number } | { kind: 'pasted'; words: string[] };
  rankKeep: number;
  rankMetric: 'mean' | 'fail_rate' | 'le3' | 'mean_fail_plus';
}

/** Settings that only change how things look (kept per browser). */
export interface DisplaySettings {
  zoomOutAfterGame: boolean;
  palette: 'standard' | 'high-contrast';
  colourBlindMarks: boolean;
  counterfactualBranches: number; // 0 = off, else top 2..5
  growthAnimation: 'full' | 'fast' | 'off';
  labelThreshold: number; // px
  replayAnnotations: boolean;
  yIsVowel: boolean;
  filterScope: 'tree' | 'all';
  rowBars: boolean;
  motion: 'system' | 'reduced' | 'full';
  keepPlayerBranches: boolean;
  exportWarnRows: number;
}

export const DEFAULT_RESULT: ResultSettings = {
  maxGuesses: 6,
  hardMode: false,
  answers: { kind: 'default' },
  arrivalStrategy: { kind: 'info_proportional', beta: 1, pool: 'candidates' },
  stochasticPool: 'candidates',
  replicatesTree: 200,
  replicatesCard: 20,
  weighting: 'equal',
  baseSeed: 1,
  rankStrategySet: 'all',
  rankOpenerSet: { kind: 'answers' },
  rankKeep: 10,
  rankMetric: 'mean',
};

export const DEFAULT_DISPLAY: DisplaySettings = {
  zoomOutAfterGame: true,
  palette: 'standard',
  colourBlindMarks: true,
  counterfactualBranches: 0,
  growthAnimation: 'full',
  labelThreshold: 10,
  replayAnnotations: false,
  yIsVowel: false,
  filterScope: 'tree',
  rowBars: true,
  motion: 'system',
  keepPlayerBranches: false,
  exportWarnRows: 1_000_000,
};

/** A strategy column of the atlas (and of the current card). */
export interface StrategyEntry {
  /** Stable id: a preset id or a saved strategy's id. */
  id: string;
  label: string;
  colour: string;
  spec: StrategySpec;
}

/** A finished or in-progress game on the board, or a replayed path. */
export interface BoardGame {
  /** Answer index of the target. */
  target: number;
  /** Guess word ids so far. */
  guesses: number[];
  /** Feedback codes so far. */
  patterns: number[];
  status: 'playing' | 'won' | 'lost';
}

export interface FilterState {
  /** Text form, e.g. "?A??Y +E -S"; several rules separated by " | " combine per `combine`. */
  text: string;
  combine: 'all' | 'any';
  mode: 'highlight' | 'isolate';
  /** Guess numbers the filter applies to; empty = every row. */
  rows: number[];
  includeFinal: boolean;
}

export const app = $state({
  /** Current continuous zoom value (animated toward zTarget). */
  z: 0,
  /** The level z is heading to (buttons, Esc, snap after pinch). */
  zTarget: 0 as number,
  /** Whether the user is actively pinching/scrolling (no snapping yet). */
  zDragging: false,

  words: null as WordData | null,
  loadError: null as string | null,
  /** Solver ready (workers loaded the list and built the pattern matrix). */
  solverReady: false,

  result: structuredClone(DEFAULT_RESULT) as ResultSettings,
  display: structuredClone(DEFAULT_DISPLAY) as DisplaySettings,
  /** Resolved from display.motion and the system preference. */
  reducedMotion: false,

  /** The board: the player's current or last game. */
  game: {
    board: null as BoardGame | null,
    /** Letters typed into the current row. */
    input: '',
    message: '' as string,
    /** Player games finished this session (for player paths). */
    history: [] as BoardGame[],
  },

  /** Replay mode: a path opened from a higher level. */
  replay: {
    active: false,
    /** Guess ids and feedback codes of the replayed path (prefix may be extended by the player). */
    guesses: [] as number[],
    patterns: [] as number[],
    target: -1,
    /** Cursor: number of rows visible at full strength (0..guesses.length). */
    cursor: 0,
    /** Config the path came from (for Next / hint). */
    config: null as Config | null,
  },

  /** The configuration in focus (tree and card), and the target and path in focus. */
  focus: {
    strategy: null as StrategyEntry | null,
    /** Opener: a word, or null for the strategy's own choice. */
    opener: null as string | null,
    /** Answer index of the focused target. */
    target: -1,
    /** Selected trie node id in the focused tree (the end of the selected path), or -1. */
    node: -1,
    /** Hovered trie node id, or -1. */
    hoverNode: -1,
    recentOpeners: [] as string[],
  },

  filter: null as FilterState | null,

  atlas: {
    columns: [] as StrategyEntry[],
    /** Openers (null = strategy's choice). */
    rows: [] as (string | null)[],
    /** Selected cells for compare mode: [column, row] pairs (max 2). */
    selected: [] as [number, number][],
  },

  /** Saved strategies from the Lab (kept in this browser). */
  saved: [] as StrategyEntry[],

  ui: {
    paneOpen: true,
    lab: false,
    settings: false,
    search: false,
    help: false,
    about: false,
    exportDialog: false,
    openerPicker: false,
    rankingFor: null as null | { kind: 'row'; opener: string | null } | { kind: 'column'; strategy: string },
    compare: false,
    toasts: [] as { id: number; text: string; kind: 'info' | 'error' }[],
  },
});

export type AppState = typeof app;
