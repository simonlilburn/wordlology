// Game-view state and actions: typing and submitting guesses, the end of a
// game, and replay mode (cursor, branching, Next, hint chip, annotations).
// Shared fields live in the store (app.game, app.replay); everything only the
// Game view needs lives here.

import { app } from '../../app/store.svelte';
import { finishGame, newGame, recordPlayerPath } from '../../app/actions';
import { inGameView } from '../../app/keyboard';
import { focusData } from '../../model/focus';
import type { ScoresResult } from '../../backend/types';
import {
  endMessage,
  handleKey,
  rowAnnouncement,
  solvedCode,
  statusAfter,
  type InputContext,
  type KeyInput,
  type Row,
} from './logic';
import {
  drawReplicate,
  endedAt,
  nextAction,
  phaseLabel,
  playAtCursor,
  scrubTo,
  startsNewBranch,
  stepCursor,
  type ReplayPath,
  type TurnMeta,
} from './replay';
import { attempt, feedbackOrNull, getBackend, replayConfig } from './services';

export const FLIP_STAGGER_MS = 180;
export const FLIP_MS = 450;
export const SHAKE_MS = 600;

export interface Hint {
  word: number;
  p: number;
  phase: string;
  deterministic: boolean;
  /** Path key and cursor the hint was computed for. */
  key: string;
}

export const view = $state({
  /** Row that shakes after an invalid guess; the key restarts the animation. */
  shakeRow: -1,
  shakeKey: 0,
  /** Row whose tiles are flipping. */
  revealRow: -1,
  revealKey: 0,
  /** Input is ignored while a row flips. */
  animating: false,
  /** Text for the polite live region. */
  announcement: '',

  // Replay extras (the path itself lives in app.replay).
  meta: [] as TurnMeta[],
  branchAt: -1,
  /** Key of the path these extras belong to. */
  pathKey: '',
  /** Counts branches, so each branch draws from a fresh replicate stream. */
  branchSerial: 0,
  /** Key of the last branch recorded as a player game. */
  recordedKey: '',
  /** A strategy draw is in flight. */
  drawing: false,
  hint: null as Hint | null,
  hintState: 'idle' as 'idle' | 'loading' | 'unavailable',
  /** Row whose remaining candidates are listed (-1: none). */
  listRow: -1,
});

let messageTimer: ReturnType<typeof setTimeout> | undefined;
let animTimer: ReturnType<typeof setTimeout> | undefined;
let endToken = 0;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Derived facts

export function inReplay(): boolean {
  return app.replay.active && app.replay.target >= 0;
}

/** Whether the Game view is the active level (keyboard input, shortcuts). */
export function gameActive(): boolean {
  return attempt(() => inGameView(), Math.round(app.zTarget) === 0 && app.z < 0.5);
}

export function anyDialogOpen(): boolean {
  const u = app.ui;
  return u.settings || u.help || u.about || u.search || u.exportDialog || u.openerPicker || u.lab;
}

export function wordLength(): number {
  return app.words?.wordLength ?? 5;
}

export function maxGuesses(): number {
  if (inReplay()) return attempt(() => replayConfig()?.rules.max_guesses, undefined) ?? app.result.maxGuesses;
  return app.result.maxGuesses;
}

export function hardMode(): boolean {
  if (inReplay()) return attempt(() => replayConfig()?.rules.hard_mode, undefined) ?? app.result.hardMode;
  return app.result.hardMode;
}

/** The word of an answer index, or null. */
export function answerWord(idx: number): string | null {
  const w = app.words;
  if (!w || idx < 0 || idx >= w.answers.length) return null;
  return w.guesses[w.answers[idx]] ?? null;
}

export function wordOf(id: number): string {
  return app.words?.guesses[id] ?? '';
}

export function targetIndex(): number {
  return inReplay() ? app.replay.target : (app.game.board?.target ?? -1);
}

/** Rows currently on the board (the whole replay path in replay mode). */
export function boardRows(): Row[] {
  if (inReplay()) return app.replay.guesses.map((g, i) => ({ word: wordOf(g), pattern: app.replay.patterns[i] }));
  const b = app.game.board;
  if (!b) return [];
  return b.guesses.map((g, i) => ({ word: wordOf(g), pattern: b.patterns[i] }));
}

/** Index of the row that receives typed letters (-1: none). */
export function inputRow(): number {
  if (inReplay()) return app.replay.cursor;
  const b = app.game.board;
  if (!b || b.status !== 'playing') return -1;
  return b.guesses.length;
}

/** Rows that count as played for hints and keys (up to the cursor in replay mode). */
export function playedRows(): Row[] {
  const rows = boardRows();
  return inReplay() ? rows.slice(0, app.replay.cursor) : rows;
}

export function currentPath(): ReplayPath {
  return {
    guesses: app.replay.guesses,
    patterns: app.replay.patterns,
    cursor: app.replay.cursor,
    meta: view.meta,
    branchAt: view.branchAt,
  };
}

export function pathKey(): string {
  return `${app.replay.target}|${app.replay.guesses.join(',')}`;
}

/** Why the board is not accepting a guess right now, or null. */
export function blockedReason(): string | null {
  if (!app.words) return 'The word list is still loading';
  if (view.animating) return '';
  if (inReplay()) {
    if (view.drawing) return 'Waiting for the strategy';
    const ended = endedAt(currentPath(), app.replay.cursor, solvedCode(wordLength()), maxGuesses());
    if (ended) return 'This game is over: scrub back to branch from an earlier turn';
    return null;
  }
  const b = app.game.board;
  if (!b) return 'Starting a game';
  if (b.status !== 'playing') return 'This game is over: start a new game';
  return null;
}

// ---------------------------------------------------------------------------
// Messages and announcements

/** Show a short message that clears itself. */
export function flash(text: string, ms = 2000): void {
  if (!text) return;
  app.game.message = text;
  announce(text);
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => {
    if (app.game.message === text) app.game.message = '';
  }, ms);
}

/** Show a message that stays until the next game. */
function setMessage(text: string): void {
  clearTimeout(messageTimer);
  app.game.message = text;
}

export function announce(text: string): void {
  view.announcement = '';
  setTimeout(() => (view.announcement = text), 30);
}

function shake(row: number): void {
  view.shakeRow = row;
  view.shakeKey++;
}

/** Flip a row's tiles; input waits until the flip ends. */
function reveal(row: number): void {
  view.revealRow = row;
  view.revealKey++;
  const ms = revealDuration();
  if (ms > 0) {
    view.animating = true;
    clearTimeout(animTimer);
    animTimer = setTimeout(() => (view.animating = false), ms);
  }
}

export function revealDuration(): number {
  if (app.reducedMotion) return 0;
  return (wordLength() - 1) * FLIP_STAGGER_MS + FLIP_MS;
}

/** Cancel pending end-of-game steps and animations (new game, new replay). */
function resetTransient(): void {
  endToken++;
  clearTimeout(animTimer);
  view.animating = false;
  view.revealRow = -1;
  view.shakeRow = -1;
  view.listRow = -1;
}

// ---------------------------------------------------------------------------
// Input

export function inputContext(): InputContext {
  return {
    lexicon: app.words ?? { wordLength: 5, index: new Map() },
    hardMode: hardMode(),
    history: playedRows(),
    blocked: blockedReason(),
  };
}

/** Handle one key from the physical or on-screen keyboard. */
export function press(key: KeyInput): void {
  const ctx = inputContext();
  if (ctx.blocked === '') return; // mid-animation: ignore quietly
  const { input, effect } = handleKey(app.game.input, key, ctx);
  switch (effect.kind) {
    case 'edit':
      app.game.input = input;
      if (view.shakeRow >= 0) view.shakeRow = -1;
      return;
    case 'blocked':
      if (key.kind === 'enter') flash(effect.message);
      return;
    case 'empty-enter':
      if (inReplay()) void next();
      else {
        shake(inputRow());
        flash('Not enough letters');
      }
      return;
    case 'invalid':
      shake(inputRow());
      flash(effect.message);
      return;
    case 'submit':
      if (inReplay()) {
        if (replayPlay(effect.word, effect.id, { source: 'player', pChosen: null, phase: 'player' })) app.game.input = '';
      } else if (playSubmit(effect.word, effect.id)) {
        app.game.input = '';
      }
      return;
  }
}

/** Submit a guess in a normal game. Returns false if it could not be scored. */
function playSubmit(word: string, id: number): boolean {
  const board = app.game.board;
  const target = board ? answerWord(board.target) : null;
  if (!board || !target) return false;
  const pattern = feedbackOrNull(word, target);
  if (pattern === null) {
    flash('Feedback is not available yet');
    return false;
  }
  board.guesses.push(id);
  board.patterns.push(pattern);
  const n = board.guesses.length;
  board.status = statusAfter(pattern, n, wordLength(), maxGuesses());
  reveal(n - 1);
  announce(rowAnnouncement(n, { word, pattern }));
  if (board.status !== 'playing') void endGame(board.status === 'won', n, target, 'game');
  return true;
}

/**
 * End of a game: once the row has flipped, show the message and record the
 * game. For the player's own game finishGame() records it and, after 800 ms,
 * zooms out to the Tree unless "Zoom out after a game" is off. A replay
 * branch is recorded as a player path and stays on the board.
 */
async function endGame(won: boolean, n: number, target: string, record: 'game' | 'branch' | 'none'): Promise<void> {
  const token = ++endToken;
  await sleep(revealDuration());
  if (token !== endToken) return;
  const msg = endMessage(won, n, target);
  setMessage(msg);
  announce(msg);
  if (record === 'game') attempt(() => finishGame(), undefined);
  else if (record === 'branch') recordBranch(won ? 'won' : 'lost');
}

/** Record the current replay branch as a player path (once per branch state). */
export function recordBranch(status: 'playing' | 'won' | 'lost' = 'playing'): void {
  if (!inReplay() || view.branchAt < 0 || app.replay.guesses.length === 0) return;
  const key = pathKey();
  if (view.recordedKey === key) return;
  view.recordedKey = key;
  attempt(
    () =>
      recordPlayerPath({
        target: app.replay.target,
        guesses: [...app.replay.guesses],
        patterns: [...app.replay.patterns],
        status,
      }),
    undefined,
  );
}

/** Start a new game (leaves replay mode). */
export function startNewGame(): void {
  resetTransient();
  app.replay.active = false;
  app.game.input = '';
  app.game.message = '';
  view.hint = null;
  attempt(() => newGame(), undefined);
}

/**
 * Make sure there is a board once the word list is loaded. The platform's
 * init normally does this; if it has not, draw a random target here.
 */
export function ensureBoard(): void {
  const w = app.words;
  if (!w || app.game.board || w.answers.length === 0) return;
  attempt(() => newGame(), undefined);
  if (!app.game.board) {
    app.game.board = { target: Math.floor(Math.random() * w.answers.length), guesses: [], patterns: [], status: 'playing' };
  }
}

// ---------------------------------------------------------------------------
// Replay

/** Reset the replay extras when a new path is opened from a higher level. */
export function syncReplay(): void {
  if (!inReplay()) return;
  const key = pathKey();
  if (key === view.pathKey) return;
  resetTransient();
  view.pathKey = key;
  view.meta = resolvePathMeta(app.replay.target, app.replay.guesses);
  view.branchAt = -1;
  view.recordedKey = '';
  view.hint = null;
  app.game.input = '';
  app.game.message = '';
  const n = app.replay.guesses.length;
  if (!(app.replay.cursor >= 0 && app.replay.cursor <= n)) app.replay.cursor = n;
}

/**
 * Per-turn metadata for a path opened from the tree: the probability and
 * phase of each turn, taken from a strategy game in the focused tree that
 * shares the longest prefix with the path.
 */
export function resolvePathMeta(target: number, guesses: number[]): TurnMeta[] {
  const meta: TurnMeta[] = guesses.map(() => ({ source: 'path', pChosen: null, phase: null }));
  const tree = focusData.tree;
  const run = focusData.treeRun;
  if (!tree || tree.target !== target) return meta;
  if (app.replay.config && run && !sameStrategy(app.replay.config, run.config)) return meta;
  let best = null as (typeof tree.games)[number] | null;
  let bestLen = 0;
  for (const g of tree.games) {
    if (g.isPlayer || g.target !== target) continue;
    let m = 0;
    while (m < guesses.length && m < g.turns.length && g.turns[m].guess === guesses[m]) m++;
    if (m > bestLen) {
      best = g;
      bestLen = m;
      if (m === guesses.length) break;
    }
  }
  for (let i = 0; i < bestLen && best; i++) {
    const t = best.turns[i];
    meta[i] = { source: 'path', pChosen: t.pChosen, phase: phaseLabel(t.phase, run?.phases) };
  }
  return meta;
}

function sameStrategy(a: { strategy: unknown; opener: unknown }, b: { strategy: unknown; opener: unknown }): boolean {
  return JSON.stringify(a.strategy) === JSON.stringify(b.strategy) && a.opener === b.opener;
}

function writePath(p: ReplayPath): void {
  app.replay.guesses = p.guesses;
  app.replay.patterns = p.patterns;
  app.replay.cursor = p.cursor;
  view.meta = p.meta;
  view.branchAt = p.branchAt;
  view.pathKey = pathKey();
}

/** Move the replay cursor to a stop (scrubber). */
export function scrub(cursor: number): void {
  if (!inReplay()) return;
  const before = app.replay.cursor;
  const p = scrubTo(currentPath(), cursor);
  if (p.cursor === before) return;
  resetTransient();
  app.game.input = '';
  app.game.message = '';
  writePath(p);
  announceCursor();
}

/** Move the cursor by one stop (← / →). */
export function step(delta: number): void {
  if (!inReplay()) return;
  scrub(stepCursor(currentPath(), delta).cursor);
}

function announceCursor(): void {
  const c = app.replay.cursor;
  const n = app.replay.guesses.length;
  if (c === 0) return announce(`Start of the game, before guess 1 of ${n}.`);
  const row = boardRows()[c - 1];
  announce(`After guess ${c} of ${n}. ${rowAnnouncement(c, row)}`);
}

/**
 * Play a word at the replay cursor: the path's own next guess advances the
 * cursor; anything else branches a player path. Returns false if the word
 * could not be scored.
 */
function replayPlay(word: string, id: number, meta: TurnMeta, knownPattern?: number): boolean {
  const target = answerWord(app.replay.target);
  if (!target) return false;
  const pattern = knownPattern ?? feedbackOrNull(word, target);
  if (pattern === null) {
    flash('Feedback is not available yet');
    return false;
  }
  const path = currentPath();
  if (meta.source !== 'strategy' && startsNewBranch(path, id)) view.branchSerial++;
  const next = playAtCursor(path, id, pattern, meta);
  resetTransient();
  app.game.message = '';
  writePath(next);
  reveal(next.cursor - 1);
  announce(rowAnnouncement(next.cursor, { word, pattern }));
  afterReplayMove(next, target);
  return true;
}

function afterReplayMove(p: ReplayPath, target: string): void {
  const ended = endedAt(p, p.cursor, solvedCode(wordLength()), maxGuesses());
  if (!ended) return;
  const branchEnd = p.branchAt >= 0 && p.cursor === p.guesses.length;
  void endGame(ended === 'won', p.cursor, target, branchEnd ? 'branch' : 'none');
}

/** Next: the path's own next guess, or a fresh seeded draw from the strategy. */
export async function next(): Promise<void> {
  if (!inReplay() || view.drawing || view.animating) return;
  const path = currentPath();
  const act = nextAction(path, solvedCode(wordLength()), maxGuesses());
  if (act.kind === 'none') {
    flash(act.reason);
    return;
  }
  if (act.kind === 'advance') {
    const p = stepCursor(path, 1);
    resetTransient();
    app.game.input = '';
    app.game.message = '';
    writePath(p);
    reveal(p.cursor - 1);
    const row = boardRows()[p.cursor - 1];
    announce(rowAnnouncement(p.cursor, row));
    const target = answerWord(app.replay.target);
    const ended = endedAt(p, p.cursor, solvedCode(wordLength()), maxGuesses());
    if (ended && target) void endGame(ended === 'won', p.cursor, target, 'none');
    return;
  }
  const config = replayConfig();
  view.drawing = true;
  try {
    const backend = await getBackend();
    if (!backend?.continueGame || !config) {
      flash('The strategy is not available yet');
      return;
    }
    const key = pathKey();
    const cursor = app.replay.cursor;
    const game = await backend.continueGame({
      config,
      target: app.replay.target,
      history: act.history,
      replicate: drawReplicate(config.replicates, view.branchSerial),
      oneStep: true,
    });
    if (!inReplay() || pathKey() !== key || app.replay.cursor !== cursor) return;
    const turn = game.turns[act.history.length];
    if (!turn) {
      flash('The strategy has no move here');
      return;
    }
    view.drawing = false;
    const meta: TurnMeta = { source: 'strategy', pChosen: turn.pChosen, phase: phaseLabel(turn.phase, phaseLabels()) };
    replayPlay(wordOf(turn.guess), turn.guess, meta, turn.pattern);
  } catch {
    flash("Could not draw the strategy's move");
  } finally {
    view.drawing = false;
  }
}

/** Phase labels of the replay configuration's strategy, if the focused tree run has them. */
function phaseLabels(): string[] | undefined {
  const run = focusData.treeRun;
  const cfg = replayConfig();
  if (run && cfg && sameStrategy(run.config, cfg)) return run.phases;
  return undefined;
}

/** Scores for the state after the first `upTo` rows of the path. */
export async function stateScores(upTo: number, topK: number, signal?: AbortSignal): Promise<ScoresResult | null> {
  const config = replayConfig();
  const backend = await getBackend();
  if (!backend?.scores || !config) return null;
  const history = app.replay.guesses.slice(0, upTo).map((g, i) => ({ guess: g, pattern: app.replay.patterns[i] }));
  return backend.scores({ config, history, topK }, signal);
}

/** Fetch the hint chip for the state at the cursor. */
export async function loadHint(signal: AbortSignal): Promise<void> {
  if (!inReplay()) return;
  const key = `${pathKey()}@${app.replay.cursor}`;
  if (view.hint?.key === key) return;
  if (endedAt(currentPath(), app.replay.cursor, solvedCode(wordLength()), maxGuesses())) {
    view.hint = null;
    view.hintState = 'idle';
    return;
  }
  view.hintState = 'loading';
  try {
    const res = await stateScores(app.replay.cursor, 3, signal);
    if (signal.aborted) return;
    const top = res?.entries[0];
    if (!res || !top) {
      view.hint = null;
      view.hintState = 'unavailable';
      return;
    }
    view.hint = { word: top.word, p: res.deterministic ? 1 : top.p, phase: res.phase, deterministic: res.deterministic, key };
    view.hintState = 'idle';
  } catch {
    if (signal.aborted) return;
    view.hint = null;
    view.hintState = 'unavailable';
  }
}

/** Tap on the hint chip: play the strategy's suggested word. */
export function playHint(): void {
  const h = view.hint;
  if (!h || !inReplay() || blockedReason() !== null) return;
  if (h.key !== `${pathKey()}@${app.replay.cursor}`) return;
  app.game.input = '';
  replayPlay(wordOf(h.word), h.word, { source: 'hint', pChosen: h.p, phase: h.phase });
}

/**
 * Fill in the strategy's probability and phase for turns that lack them
 * (player moves), for the annotation column.
 */
export async function fillTurnScores(signal: AbortSignal): Promise<void> {
  const key = pathKey();
  for (let i = 0; i < view.meta.length; i++) {
    if (signal.aborted || pathKey() !== key) return;
    const m = view.meta[i];
    if (!m || m.pChosen !== null) continue;
    try {
      const res = await stateScores(i, 200, signal);
      if (!res || signal.aborted || pathKey() !== key) return;
      const word = app.replay.guesses[i];
      let p: number | null;
      if (res.deterministic) p = res.entries[0]?.word === word ? 1 : 0;
      else {
        const entry = res.entries.find((e) => e.word === word);
        const covered = res.entries.reduce((s, e) => s + e.p, 0) > 0.999;
        p = entry ? entry.p : covered ? 0 : null;
      }
      if (view.meta[i]) view.meta[i] = { ...view.meta[i], pChosen: p, phase: view.meta[i].phase ?? res.phase };
    } catch {
      return;
    }
  }
}
