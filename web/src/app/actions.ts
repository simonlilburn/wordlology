// Shared actions on the store. Owned by the platform agent.
import type { Config } from '../backend/types';
import { requestSelectPath, selectedPathGuesses } from '../model/focus';
import { isDeterministicSpec, specLabel } from './config';
import { app, type BoardGame, type Level, type StrategyEntry } from './store.svelte';
import { animateTo, currentLevel } from './zoom';

/** Delay before the board zooms out into the Tree view after a game ends. */
export const ZOOM_OUT_DELAY_MS = 800;
const RECENT_OPENERS = 8;
const TOAST_MS = 4000;

let zoomOutTimer: ReturnType<typeof setTimeout> | null = null;
let toastId = 0;
/** Target order for , and . (answer indices), set by the target browser; null = alphabetical. */
let targetOrder: number[] | null = null;

function cancelZoomOut(): void {
  if (zoomOutTimer) {
    clearTimeout(zoomOutTimer);
    zoomOutTimer = null;
  }
}

/** Animate to a level (buttons, keys). */
export function setLevel(level: Level): void {
  cancelZoomOut();
  animateTo(level);
}

/** Zoom out (+1) or in (−1) one level. */
export function stepLevel(delta: 1 | -1): void {
  const next = Math.min(3, Math.max(0, currentLevel() + delta)) as Level;
  setLevel(next);
}

/**
 * Focus a target (answer index) in the Tree view. Animates to the Tree unless
 * `show` is false (e.g. flipping covers while already at the Tree).
 */
export function focusTarget(target: number, show = true): void {
  const n = app.words?.answers.length ?? 0;
  if (!Number.isInteger(target) || target < 0 || (n > 0 && target >= n)) return;
  if (app.focus.target !== target) {
    app.focus.target = target;
    app.focus.node = -1;
    app.focus.hoverNode = -1;
  }
  if (show && currentLevel() !== 1) setLevel(1);
}

/** Set the order , and . step through (the target browser's sort); null = answer order (alphabetical). */
export function setTargetOrder(order: number[] | null): void {
  targetOrder = order && order.length ? [...order] : null;
}

/** The current target order for , and . */
export function getTargetOrder(): number[] {
  if (targetOrder) return targetOrder;
  const n = app.words?.answers.length ?? 0;
  return Array.from({ length: n }, (_, i) => i);
}

/** Previous (−1) or next (+1) target in the card's target order. */
export function stepTarget(delta: number): void {
  const order = getTargetOrder();
  if (!order.length) return;
  let i = order.indexOf(app.focus.target);
  if (i < 0) i = delta > 0 ? -1 : 0;
  const j = (((i + delta) % order.length) + order.length) % order.length;
  focusTarget(order[j], false);
}

/** Select a trie node (end of a path) in the focused tree; -1 clears. */
export function selectNode(nodeId: number): void {
  app.focus.node = Number.isInteger(nodeId) && nodeId >= 0 ? nodeId : -1;
}

/** Open a path in replay mode on the board. */
export function openReplay(path: { target: number; guesses: number[]; patterns: number[]; config: Config | null }): void {
  cancelZoomOut();
  app.replay.active = true;
  app.replay.target = path.target;
  app.replay.guesses = [...path.guesses];
  app.replay.patterns = [...path.patterns];
  app.replay.cursor = path.guesses.length;
  app.replay.config = path.config ? plainCopy(path.config) : null;
  if (path.target !== app.focus.target && path.target >= 0) app.focus.target = path.target;
  animateTo(0);
}

/** Plain copy of a possibly-proxied object. */
function plainCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Leave replay mode (back to the player's own board). */
export function closeReplay(): void {
  app.replay.active = false;
}

/** Change the focused strategy / opener. */
export function setStrategy(entry: StrategyEntry): void {
  app.focus.strategy = { ...entry, spec: plainCopy(entry.spec) };
  app.focus.node = -1;
  app.focus.hoverNode = -1;
  app.arrived = true;
}

export function setOpener(opener: string | null): void {
  const o = opener ? opener.trim().toLowerCase() : null;
  app.focus.opener = o || null;
  app.focus.node = -1;
  app.focus.hoverNode = -1;
  if (o) {
    const recent = app.focus.recentOpeners.filter((w) => w !== o);
    recent.unshift(o);
    app.focus.recentOpeners = recent.slice(0, RECENT_OPENERS);
  }
}

/** A random answer index, avoiding `avoid` when possible. */
export function randomTarget(avoid = -1): number {
  const n = app.words?.answers.length ?? 0;
  if (n <= 0) return -1;
  if (n === 1) return 0;
  let t = Math.floor(Math.random() * n);
  if (t === avoid) t = (t + 1 + Math.floor(Math.random() * (n - 1))) % n;
  return t;
}

/** Start a new game with a random (or given) target. */
export function newGame(target?: number): void {
  cancelZoomOut();
  const n = app.words?.answers.length ?? 0;
  const prev = app.game.board?.target ?? -1;
  const t = target !== undefined && Number.isInteger(target) && target >= 0 && target < n ? target : randomTarget(prev);
  app.game.board = { target: t, guesses: [], patterns: [], status: 'playing' };
  app.game.input = '';
  app.game.message = '';
  app.replay.active = false;
  if (app.focus.target < 0) app.focus.target = t;
  if (currentLevel() !== 0) animateTo(0);
}

/** The arrival strategy entry: the matching preset if there is one. */
export function arrivalEntry(): StrategyEntry {
  const spec = plainCopy(app.result.arrivalStrategy);
  const key = JSON.stringify(spec);
  const preset = app.catalogue.presets.find((p) => JSON.stringify(p.spec) === key);
  if (preset) return { id: preset.id, label: preset.label, colour: preset.colour, spec };
  const saved = app.saved.find((s) => JSON.stringify(s.spec) === key);
  if (saved) return { ...saved, spec };
  return { id: 'arrival', label: specLabel(spec), colour: '#7c5cff', spec };
}

/** Record a player path (a finished game, or a branch made in replay) for trees and exports. */
export function recordPlayerPath(game: BoardGame): void {
  if (!game.guesses.length) return;
  const copy: BoardGame = {
    target: game.target,
    guesses: [...game.guesses],
    patterns: [...game.patterns],
    status: game.status,
  };
  const dup = app.game.history.some(
    (h) => h.target === copy.target && h.guesses.length === copy.guesses.length && h.guesses.every((g, i) => g === copy.guesses[i]),
  );
  if (!dup) app.game.history.push(copy);
}

/**
 * Record a finished player game: adds a player path, sets the configuration on
 * first arrival (the arrival strategy with the player's first guess as the
 * opener), focuses the game's target with the player's path selected as the
 * trunk, and after 800 ms zooms out into the Tree view unless the "Zoom out
 * after a game" setting is off. The Game view calls this once per game.
 */
export function finishGame(): void {
  const board = app.game.board;
  if (!board || !board.guesses.length) return;
  recordPlayerPath(board);
  const words = app.words;
  if (!app.arrived) {
    app.arrived = true;
    app.focus.strategy = arrivalEntry();
    const first = words ? words.guesses[board.guesses[0]] : null;
    if (first) setOpener(first);
    if (!app.atlas.columns.length && app.focus.strategy) app.atlas.columns = [app.focus.strategy];
    if (!app.atlas.rows.length) app.atlas.rows = [app.focus.opener];
  } else if (!app.focus.strategy) {
    app.focus.strategy = arrivalEntry();
  }
  app.focus.target = board.target;
  app.focus.node = -1;
  requestSelectPath(board.target, board.guesses);
  cancelZoomOut();
  if (app.display.zoomOutAfterGame) {
    const b = board;
    zoomOutTimer = setTimeout(() => {
      zoomOutTimer = null;
      if (app.game.board === b && !app.replay.active && currentLevel() === 0) animateTo(1);
    }, ZOOM_OUT_DELAY_MS);
  }
}

/** Guesses (word ids) of the selected path in the focused tree, or null. */
export function selectedPath(): number[] | null {
  return selectedPathGuesses();
}

/** Whether the focused strategy is deterministic. */
export function focusDeterministic(): boolean {
  return app.focus.strategy ? isDeterministicSpec(app.focus.strategy.spec) : false;
}

export function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  const id = ++toastId;
  app.ui.toasts.push({ id, text, kind });
  if (app.ui.toasts.length > 4) app.ui.toasts.splice(0, app.ui.toasts.length - 4);
  setTimeout(() => dismissToast(id), kind === 'error' ? TOAST_MS * 2 : TOAST_MS);
}

export function dismissToast(id: number): void {
  const i = app.ui.toasts.findIndex((t) => t.id === id);
  if (i >= 0) app.ui.toasts.splice(i, 1);
}
