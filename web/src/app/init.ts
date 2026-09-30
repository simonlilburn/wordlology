// App start-up: owned by the platform agent. Loads the word list, starts the
// solver backend, restores settings and URL state, installs keyboard handling.
//
// Order:
//   1. display settings, saved strategies and recent openers from this browser;
//   2. the link's settings preset (it may change the answer list);
//   3. reduced motion from app.display.motion and prefers-reduced-motion;
//   4. the word list, then the solver workers (app.solverReady once the
//      matrices are built) and the catalogue from the backend's capabilities;
//   5. player branches, a new game (the link's target, else a random one),
//      and the link's view (strategy, opener, target, filter, path, level);
//   6. the keyboard and the effects that keep focus, URL and storage in sync.

import { localBackend, backend } from '../backend';
import { runs } from '../model/runs';
import { resetFocus, syncFocus } from '../model/focus';
import type { WordData } from '../model/types';
import { DEFAULT_LIST_ID, loadWordData, selectionKey, answerIndexOf } from '../model/wordlists';
import { openExport } from '../export/index';
import { newGame, stepLevel, stepTarget, toast } from './actions';
import { answerSelection } from './config';
import { startEffects } from './effects.svelte';
import { installDefaultShortcuts, installKeyboardListener } from './keyboard';
import { resolvePendingLinkStrategy } from './linkStrategy';
import { loadPlayerBranches, restoreLocalSettings } from './settings';
import { app, DEFAULT_RESULT } from './store.svelte';
import { applySettingsFromState, applyViewFromState, readUrl, withoutUrlWrites, type UrlState } from './url';
import { currentLevel } from './zoom';

let started: Promise<void> | null = null;
let motionQuery: MediaQueryList | null = null;

/** Resolve app.reducedMotion from the Motion setting and the system preference. */
export function resolveReducedMotion(): boolean {
  const m = app.display.motion;
  let reduced: boolean;
  if (m === 'reduced') reduced = true;
  else if (m === 'full') reduced = false;
  else {
    if (!motionQuery && typeof matchMedia === 'function') {
      try {
        motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
        motionQuery.addEventListener?.('change', () => resolveReducedMotion());
      } catch {
        motionQuery = null;
      }
    }
    reduced = motionQuery?.matches ?? false;
  }
  if (app.reducedMotion !== reduced) app.reducedMotion = reduced;
  return reduced;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Load the solver with a word list: builds the pattern matrices, then fills the catalogue. */
async function startSolver(words: WordData): Promise<void> {
  app.solverReady = false;
  try {
    await localBackend.setWords(words);
    if (app.words !== words) return; // replaced meanwhile
    app.solverReady = true;
  } catch (e) {
    console.error(e);
    toast(`The solver could not start: ${errorText(e)}`, 'error');
    return;
  }
  try {
    const caps = await backend.capabilities();
    app.catalogue.solverVersion = caps.solverVersion;
    app.catalogue.presets = caps.presets;
    app.catalogue.schemas = caps.strategies;
    if (resolvePendingLinkStrategy()) syncFocus();
    // A strategy focused from a fallback preset picks up the catalogue's label and colour.
    const f = app.focus.strategy;
    if (f) {
      const p = caps.presets.find((x) => x.id === f.id);
      if (p && (p.label !== f.label || p.colour !== f.colour)) app.focus.strategy = { ...f, label: p.label, colour: p.colour };
    }
  } catch (e) {
    console.error(e);
  }
}

/** Load the word list for the current answer selection, falling back to the default selection. */
async function loadWords(): Promise<WordData> {
  const sel = answerSelection(app.result);
  try {
    return await loadWordData(DEFAULT_LIST_ID, sel);
  } catch (e) {
    if (sel.kind === 'default') throw e;
    toast(`The answer list setting could not be used (${errorText(e)}); using the default list.`, 'error');
    app.result.answers = structuredClone(DEFAULT_RESULT.answers);
    return loadWordData(DEFAULT_LIST_ID, { kind: 'default' });
  }
}

let reloading: Promise<void> | null = null;

/**
 * Reload the word list after the answer-list setting changed: answer indices
 * change meaning, so runs and focus are reset and targets are carried over by
 * word where the new list has them.
 */
export async function reloadWords(): Promise<void> {
  const old = app.words;
  if (!old) return;
  const want = selectionKey(answerSelection(app.result));
  if (selectionKey(old.selection) === want) return;
  if (reloading) {
    await reloading;
    return reloadWords();
  }
  reloading = (async () => {
    let words: WordData;
    try {
      words = await loadWords();
    } catch (e) {
      toast(`Could not load the answer list: ${errorText(e)}`, 'error');
      return;
    }
    const wordOf = (i: number) => (i >= 0 && i < old.answers.length ? old.guesses[old.answers[i]] : '');
    const boardWord = app.game.board ? wordOf(app.game.board.target) : '';
    const focusWord = wordOf(app.focus.target);
    runs.reset();
    resetFocus();
    app.words = words;
    app.game.history = loadPlayerBranches(words);
    const focus = focusWord ? answerIndexOf(words, focusWord) : -1;
    app.focus.target = focus;
    app.focus.node = -1;
    const board = boardWord ? answerIndexOf(words, boardWord) : -1;
    if (app.game.board && app.game.board.status === 'playing' && board >= 0) app.game.board.target = board;
    else if (app.game.board && app.game.board.status === 'playing') {
      const lvl = currentLevel();
      newGame();
      if (lvl !== 0) app.zTarget = lvl;
    }
    if (app.focus.target < 0 && app.game.board) app.focus.target = app.game.board.target;
    await startSolver(words);
  })();
  try {
    await reloading;
  } finally {
    reloading = null;
  }
}

/** Apply a link opened in this tab after load (hashchange). */
function onHashChange(): void {
  const s: UrlState = readUrl();
  withoutUrlWrites(() => {
    applySettingsFromState(s);
    resolveReducedMotion();
    applyViewFromState(s);
  });
  if (s.target !== undefined && currentLevel() === 0 && app.words && s.target < app.words.answers.length) newGame(s.target);
  syncFocus();
  void reloadWords();
}

/** Start the app (idempotent). */
export function init(): Promise<void> {
  if (!started) started = start();
  return started;
}

async function start(): Promise<void> {
  restoreLocalSettings();
  const link = readUrl();
  applySettingsFromState(link);
  resolveReducedMotion();

  let words: WordData;
  try {
    words = await loadWords();
  } catch (e) {
    app.loadError = `The word list could not be loaded: ${errorText(e)}`;
    console.error(e);
    return;
  }
  app.words = words;
  const solver = startSolver(words);

  app.game.history = loadPlayerBranches(words);
  withoutUrlWrites(() => {
    newGame(link.target !== undefined && link.target < words.answers.length ? link.target : undefined);
    applyViewFromState(link);
  });
  syncFocus();

  installKeyboardListener();
  installDefaultShortcuts({
    stepLevel,
    stepTarget,
    openExport: () => openExport(),
  });
  startEffects({ reloadWords, resolveReducedMotion });
  if (typeof window !== 'undefined') window.addEventListener('hashchange', onHashChange);

  await solver;
}
