// Pure replay-mode logic: the cursor, branching a new player path at the
// cursor, and what the Next button does.

/** Who chose a turn of the replayed game. */
export type TurnSource = 'path' | 'player' | 'strategy' | 'hint';

export interface TurnMeta {
  source: TurnSource;
  /** The strategy's probability of this guess, if known. */
  pChosen: number | null;
  /** Hybrid phase label ("opener", "player", a phase name), if known. */
  phase: string | null;
}

export interface ReplayPath {
  /** Guess word ids and feedback codes of the whole path. */
  guesses: number[];
  patterns: number[];
  /** Rows shown at full strength (0..guesses.length). */
  cursor: number;
  /** Per-turn metadata (same length as guesses). */
  meta: TurnMeta[];
  /** First turn that differs from the opened path, or -1 while the player has not branched. */
  branchAt: number;
}

export function openPath(guesses: number[], patterns: number[], cursor = guesses.length, meta?: TurnMeta[]): ReplayPath {
  const n = Math.min(guesses.length, patterns.length);
  return {
    guesses: guesses.slice(0, n),
    patterns: patterns.slice(0, n),
    cursor: clampCursor(cursor, n),
    meta: meta?.slice(0, n) ?? Array.from({ length: n }, () => ({ source: 'path' as const, pChosen: null, phase: null })),
    branchAt: -1,
  };
}

export function clampCursor(cursor: number, n: number): number {
  if (!Number.isFinite(cursor)) return n;
  return Math.max(0, Math.min(n, Math.round(cursor)));
}

/** Move the cursor to an absolute stop. */
export function scrubTo(path: ReplayPath, cursor: number): ReplayPath {
  return { ...path, cursor: clampCursor(cursor, path.guesses.length) };
}

/** Move the cursor by delta stops (← / →). */
export function stepCursor(path: ReplayPath, delta: number): ReplayPath {
  return scrubTo(path, path.cursor + delta);
}

/** Whether the game has ended at a cursor position: 'won', 'lost', or null while it can continue. */
export function endedAt(path: ReplayPath, cursor: number, solvedCode: number, maxGuesses: number): 'won' | 'lost' | null {
  if (cursor > 0 && path.patterns[cursor - 1] === solvedCode) return 'won';
  if (cursor >= maxGuesses) return 'lost';
  return null;
}

/**
 * Play a guess at the cursor. If it is the path's own next guess the cursor
 * just advances; otherwise the path is cut at the cursor and the guess starts
 * (or continues) a player branch.
 */
export function playAtCursor(path: ReplayPath, guess: number, pattern: number, meta: TurnMeta): ReplayPath {
  const c = path.cursor;
  if (c < path.guesses.length && path.guesses[c] === guess) {
    return { ...path, cursor: c + 1 };
  }
  const branchAt = path.branchAt >= 0 && path.branchAt <= c ? path.branchAt : c;
  return {
    guesses: [...path.guesses.slice(0, c), guess],
    patterns: [...path.patterns.slice(0, c), pattern],
    meta: [...path.meta.slice(0, c), meta],
    cursor: c + 1,
    branchAt,
  };
}

/** Whether playing a guess at the cursor starts a new branch (rather than continuing the current one). */
export function startsNewBranch(path: ReplayPath, guess: number): boolean {
  const c = path.cursor;
  if (c < path.guesses.length && path.guesses[c] === guess) return false;
  return !(path.branchAt >= 0 && path.branchAt <= c);
}

export type NextAction =
  /** The path's own next guess: move the cursor one stop. */
  | { kind: 'advance' }
  /** A fresh seeded draw from the strategy after this history (word ids). */
  | { kind: 'draw'; history: number[] }
  /** Nothing to play. */
  | { kind: 'none'; reason: string };

/** What Next (or Enter on an empty row) does at the cursor. */
export function nextAction(path: ReplayPath, solvedCode: number, maxGuesses: number): NextAction {
  const ended = endedAt(path, path.cursor, solvedCode, maxGuesses);
  if (ended === 'won') return { kind: 'none', reason: 'Solved: scrub back to branch from an earlier turn' };
  if (ended === 'lost') return { kind: 'none', reason: 'Out of guesses: scrub back to branch from an earlier turn' };
  if (path.cursor < path.guesses.length) return { kind: 'advance' };
  return { kind: 'draw', history: path.guesses.slice(0, path.cursor) };
}

/**
 * Replicate index for fresh draws: beyond the configuration's R so it never
 * repeats one of the tree's own games, and distinct for each branch.
 */
export function drawReplicate(configReplicates: number, branchSerial: number): number {
  return Math.max(1, configReplicates) + branchSerial;
}

/** Phase label for a Turn.phase index. */
export function phaseLabel(phase: number, labels: string[] | null | undefined): string | null {
  if (phase === 255) return 'opener';
  if (phase === 254) return 'player';
  const l = labels?.[phase];
  if (l) return l;
  return labels && labels.length ? `phase ${phase}` : null;
}
