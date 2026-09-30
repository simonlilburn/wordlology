// Pure game-board logic: input handling, guess validation, hard mode,
// keyboard key states and the text used for accessible labels and messages.
// No store or DOM access here, so all of it is unit-tested.

/** A feedback cell: 0 absent, 1 present, 2 correct. */
export type Cell = 0 | 1 | 2;
export const CELL_NAMES = ['absent', 'present', 'correct'] as const;
export type CellName = (typeof CELL_NAMES)[number];

/** Cells of a feedback code (the contract: code = sum of c_i * 3^i). */
export function decodePattern(code: number, len: number): Cell[] {
  const cells: Cell[] = [];
  let c = code;
  for (let i = 0; i < len; i++) {
    cells.push((c % 3) as Cell);
    c = Math.floor(c / 3);
  }
  return cells;
}

/** The all-correct code for a word length. */
export function solvedCode(len: number): number {
  return 3 ** len - 1;
}

/** The subset of WordData the board logic needs. */
export interface Lexicon {
  wordLength: number;
  /** Word -> word id for every allowed guess. */
  index: Map<string, number>;
}

/** A submitted row: the guess word (lowercase) and its feedback code. */
export interface Row {
  word: string;
  pattern: number;
}

// ---------------------------------------------------------------------------
// Input

export type KeyInput = { kind: 'letter'; letter: string } | { kind: 'enter' } | { kind: 'backspace' };

/** Map a KeyboardEvent.key to a board input, or null if the board ignores it. */
export function keyFromEvent(key: string): KeyInput | null {
  if (key === 'Enter') return { kind: 'enter' };
  if (key === 'Backspace') return { kind: 'backspace' };
  if (key.length === 1) {
    const l = key.toLowerCase();
    if (l >= 'a' && l <= 'z') return { kind: 'letter', letter: l };
  }
  return null;
}

/** What a key press did to the input row. */
export type InputEffect =
  /** The typed letters changed (or a key was ignored because the row is full/empty). */
  | { kind: 'edit' }
  /** The board is not accepting input (game over, not ready). */
  | { kind: 'blocked'; message: string }
  /** Enter on an empty row (replay mode plays the strategy's move). */
  | { kind: 'empty-enter' }
  /** Enter on a row that cannot be played: shake it and show the message. */
  | { kind: 'invalid'; reason: InvalidReason; message: string }
  /** Enter on a valid guess: submit it. */
  | { kind: 'submit'; word: string; id: number };

export type InvalidReason = 'short' | 'unknown' | 'hard';

export interface InputContext {
  lexicon: Lexicon;
  hardMode: boolean;
  /** Rows already played (up to the replay cursor in replay mode). */
  history: Row[];
  /** Null when the board accepts input, else why not. */
  blocked: string | null;
}

/**
 * The board's input state machine: given the letters typed so far and a key,
 * return the new letters and what should happen.
 */
export function handleKey(input: string, key: KeyInput, ctx: InputContext): { input: string; effect: InputEffect } {
  if (ctx.blocked !== null) return { input, effect: { kind: 'blocked', message: ctx.blocked } };
  const len = ctx.lexicon.wordLength;
  switch (key.kind) {
    case 'letter':
      return { input: input.length < len ? input + key.letter : input, effect: { kind: 'edit' } };
    case 'backspace':
      return { input: input.slice(0, -1), effect: { kind: 'edit' } };
    case 'enter': {
      if (input.length === 0) return { input, effect: { kind: 'empty-enter' } };
      const check = checkGuess(input, ctx);
      if (!check.ok) return { input, effect: { kind: 'invalid', reason: check.reason, message: check.message } };
      return { input: '', effect: { kind: 'submit', word: check.word, id: check.id } };
    }
  }
}

export type GuessCheck =
  | { ok: true; word: string; id: number }
  | { ok: false; reason: InvalidReason; message: string };

/** Validate a guess: full length, in the allowed list, and (in hard mode) using every revealed hint. */
export function checkGuess(input: string, ctx: Omit<InputContext, 'blocked'>): GuessCheck {
  const word = input.toLowerCase();
  const len = ctx.lexicon.wordLength;
  if (word.length < len) return { ok: false, reason: 'short', message: 'Not enough letters' };
  const id = ctx.lexicon.index.get(word);
  if (id === undefined) return { ok: false, reason: 'unknown', message: `${word.toUpperCase()} is not in the word list` };
  if (ctx.hardMode) {
    const v = hardModeViolation(word, ctx.history);
    if (v) return { ok: false, reason: 'hard', message: `Hard mode: ${v}` };
  }
  return { ok: true, word, id };
}

// ---------------------------------------------------------------------------
// Hard mode (mirrors wl_core::hard): correct letters stay in place, and every
// letter revealed as present or correct appears at least as often as revealed.

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** The first hard-mode violation, described for the player, or null. */
export function hardModeViolation(guess: string, history: Row[]): string | null {
  const len = guess.length;
  for (const row of history) {
    const cells = decodePattern(row.pattern, len);
    for (let i = 0; i < len; i++) {
      if (cells[i] === 2 && guess[i] !== row.word[i]) {
        return `${ordinal(i + 1)} letter must be ${row.word[i].toUpperCase()}`;
      }
    }
    for (let i = 0; i < len; i++) {
      if (cells[i] === 0) continue;
      const letter = row.word[i];
      let need = 0;
      for (let j = 0; j < len; j++) if (row.word[j] === letter && cells[j] !== 0) need++;
      let have = 0;
      for (let j = 0; j < len; j++) if (guess[j] === letter) have++;
      if (have < need) {
        const L = letter.toUpperCase();
        return need > 1 ? `guess must contain ${need} ${L}s` : `guess must contain ${L}`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Keyboard key states

/** Best known state per letter over the rows: correct beats present beats absent. */
export function keyStates(rows: Row[]): Map<string, Cell> {
  const out = new Map<string, Cell>();
  for (const row of rows) {
    const cells = decodePattern(row.pattern, row.word.length);
    for (let i = 0; i < row.word.length; i++) {
      const l = row.word[i];
      const prev = out.get(l);
      if (prev === undefined || cells[i] > prev) out.set(l, cells[i]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text

/** Accessible tile label: "S, correct", "S" (typed), or "empty". */
export function tileLabel(letter: string, cell: Cell | null): string {
  if (!letter) return 'empty';
  const L = letter.toUpperCase();
  return cell === null ? L : `${L}, ${CELL_NAMES[cell]}`;
}

/** Accessible keyboard key label: "A", "A, correct". */
export function keyLabel(letter: string, cell: Cell | undefined): string {
  const L = letter.toUpperCase();
  return cell === undefined ? L : `${L}, ${CELL_NAMES[cell]}`;
}

/** The live-region announcement for a submitted row. */
export function rowAnnouncement(turn: number, row: Row): string {
  const cells = decodePattern(row.pattern, row.word.length);
  const parts = [...row.word].map((l, i) => `${l.toUpperCase()} ${CELL_NAMES[cells[i]]}`);
  return `Guess ${turn}, ${row.word.toUpperCase()}: ${parts.join(', ')}.`;
}

const PRAISE = ['Unbelievable!', 'Brilliant!', 'Excellent!', 'Nicely done!', 'Good work!', 'Close one!'];

/** The short message shown at the end of a game. */
export function endMessage(won: boolean, nGuesses: number, target: string): string {
  if (won) {
    const word = PRAISE[Math.min(nGuesses, PRAISE.length) - 1];
    return `${word} Solved in ${nGuesses} ${nGuesses === 1 ? 'guess' : 'guesses'}.`;
  }
  return `Out of guesses. The word was ${target.toUpperCase()}.`;
}

/** Status after a submitted guess. */
export function statusAfter(pattern: number, nGuesses: number, len: number, maxGuesses: number): 'playing' | 'won' | 'lost' {
  if (pattern === solvedCode(len)) return 'won';
  if (nGuesses >= maxGuesses) return 'lost';
  return 'playing';
}

/** On-screen keyboard rows (English letters). */
export const KEY_ROWS: string[][] = [
  [...'qwertyuiop'],
  [...'asdfghjkl'],
  ['enter', ...'zxcvbnm', 'backspace'],
];
