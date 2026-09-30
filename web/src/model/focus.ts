// The runs, tree and card for the configuration in focus. Owned by the platform agent.
// Updated when app.focus, app.result or the word list change: app/effects.svelte.ts
// calls syncFocus() from an $effect, and actions call it directly where they
// need the result at once.
import { localConfigKey, makeConfig } from '../app/config';
import { app } from '../app/store.svelte';
import type { Config } from '../backend/types';
import { CardAccumulator } from './card';
import { playerGame } from './player';
import { runs } from './runs';
import { TargetTrie } from './trie';
import type { Run, TargetTree } from './types';
import { targetWeights } from './wordlists';

export interface FocusData {
  /** Tree run for (focused strategy, opener, target) at the Tree view replicate count. */
  treeRun: Run | null;
  tree: TargetTree | null;
  /** Card run for (focused strategy, opener) over every target at the card replicate count. */
  cardRun: Run | null;
  card: CardAccumulator | null;
  /** Increments whenever any of the above is replaced. */
  version: number;
}

export const focusData: FocusData = { treeRun: null, tree: null, cardRun: null, card: null, version: 0 };

/** Configurations currently in focus (null when nothing is focused). */
export const focusConfigs: { tree: Config | null; card: Config | null } = { tree: null, card: null };

let cardKey = '';
let treeKey = '';
let unsubCard: (() => void) | null = null;
let unsubTree: (() => void) | null = null;
let cardIngested = 0;
let treeIngested = 0;
/** History entries already inserted into the current tree. */
let playersInserted = 0;
/** A path to select once the tree for its target has it. */
let pending: { target: number; guesses: number[] } | null = null;
const changeListeners = new Set<() => void>();

/** Called whenever focusData changes (a run replaced, or games ingested). */
export function onFocusChange(cb: () => void): () => void {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

function notify(): void {
  for (const cb of [...changeListeners]) {
    try {
      cb();
    } catch (e) {
      console.error(e);
    }
  }
}

/** Select the path with these guesses (word ids) against `target` once the focused tree has it. */
export function requestSelectPath(target: number, guesses: number[]): void {
  pending = { target, guesses: [...guesses] };
  syncFocus();
  resolvePending();
}

/** Guesses (word ids) of the selected path in the focused tree, or null. */
export function selectedPathGuesses(): number[] | null {
  const tree = focusData.tree as TargetTrie | null;
  const id = app.focus.node;
  if (!tree || id < 0 || id >= tree.nodes.length) return null;
  return tree.guessesTo(tree.nodes[id]);
}

function resolvePending(): void {
  const tree = focusData.tree as TargetTrie | null;
  if (!pending || !tree) return;
  if (pending.target !== tree.target) {
    if (pending.target !== app.focus.target) pending = null;
    return;
  }
  const node = tree.find(pending.guesses);
  if (node) {
    app.focus.node = node.id;
    pending = null;
  }
}

function ingestCard(): void {
  const run = focusData.cardRun;
  const card = focusData.card;
  if (!run || !card) return;
  if (run.games.length > cardIngested) {
    card.ingest(run.games.slice(cardIngested));
    cardIngested = run.games.length;
  }
  if (run.progress) card.progress(run.progress);
  if (run.status === 'done') card.markComplete();
}

function insertPlayers(): void {
  const tree = focusData.tree as TargetTrie | null;
  const words = app.words;
  if (!tree || !words) return;
  const hist = app.game.history;
  for (; playersInserted < hist.length; playersInserted++) {
    const h = hist[playersInserted];
    if (h.target !== tree.target || !h.guesses.length) continue;
    tree.addPlayer(playerGame(words, h.target, h.guesses, playersInserted + 1));
  }
}

function ingestTree(): void {
  const run = focusData.treeRun;
  const tree = focusData.tree;
  if (!run || !tree) return;
  if (run.games.length > treeIngested) {
    tree.ingest(run.games.slice(treeIngested));
    treeIngested = run.games.length;
  }
  resolvePending();
}

function clearCard(): void {
  unsubCard?.();
  unsubCard = null;
  if (focusData.cardRun && focusData.cardRun.status !== 'done') focusData.cardRun.setPriority('background');
  focusData.cardRun = null;
  focusData.card = null;
  focusConfigs.card = null;
  cardKey = '';
}

function clearTree(): void {
  unsubTree?.();
  unsubTree = null;
  if (focusData.treeRun && focusData.treeRun.status !== 'done') focusData.treeRun.setPriority('background');
  focusData.treeRun = null;
  focusData.tree = null;
  focusConfigs.tree = null;
  treeKey = '';
}

/** Bring focusData up to date with the store (cheap when nothing changed). */
export function syncFocus(): void {
  const words = app.words;
  const strategy = app.focus.strategy;
  let changed = false;
  if (!words || !strategy) {
    if (focusData.cardRun || focusData.treeRun) {
      clearCard();
      clearTree();
      focusData.version++;
      notify();
    }
    return;
  }
  const maxGuesses = app.result.maxGuesses;
  const nTargets = words.answers.length;

  // Card: every target at the card replicate count.
  const cardConfig = makeConfig({ strategy: strategy.spec, opener: app.focus.opener, kind: 'card' });
  const ck = `${localConfigKey(cardConfig)}|${nTargets}`;
  if (ck !== cardKey) {
    clearCard();
    cardKey = ck;
    focusConfigs.card = cardConfig;
    const run = runs.request(cardConfig, { targets: 'all' }, 'focused');
    focusData.cardRun = run;
    focusData.card = new CardAccumulator(
      maxGuesses,
      nTargets,
      run.deterministic,
      cardConfig.replicates,
      targetWeights(words, cardConfig.weighting),
    );
    cardIngested = 0;
    ingestCard();
    unsubCard = run.onChange(() => {
      if (focusData.cardRun !== run) return;
      ingestCard();
      notify();
    });
    changed = true;
  } else if (focusData.cardRun && focusData.cardRun.priority !== 'focused') {
    focusData.cardRun.setPriority('focused');
  }

  // Tree: the focused target at the Tree replicate count.
  const target = app.focus.target;
  if (target >= 0 && target < nTargets) {
    const treeConfig = makeConfig({ strategy: strategy.spec, opener: app.focus.opener, kind: 'tree' });
    const tk = `${localConfigKey(treeConfig)}|${target}|${nTargets}`;
    if (tk !== treeKey) {
      // Keep the selected path across a rebuild for the same target.
      const old = focusData.tree as TargetTrie | null;
      if (!pending && old && old.target === target && app.focus.node >= 0 && app.focus.node < old.nodes.length) {
        pending = { target, guesses: old.guessesTo(old.nodes[app.focus.node]) };
      }
      clearTree();
      if (app.focus.node !== -1) app.focus.node = -1;
      treeKey = tk;
      focusConfigs.tree = treeConfig;
      const run = runs.request(treeConfig, { targets: [target] }, 'focused');
      focusData.treeRun = run;
      focusData.tree = new TargetTrie(target, maxGuesses);
      treeIngested = 0;
      playersInserted = 0;
      insertPlayers();
      ingestTree();
      // On arrival the player's own latest game against this target is the trunk.
      if (!pending && app.focus.node < 0) {
        const hist = app.game.history;
        for (let i = hist.length - 1; i >= 0; i--) {
          if (hist[i].target === target && hist[i].guesses.length) {
            pending = { target, guesses: [...hist[i].guesses] };
            break;
          }
        }
      }
      resolvePending();
      unsubTree = run.onChange(() => {
        if (focusData.treeRun !== run) return;
        ingestTree();
        notify();
      });
      changed = true;
    } else {
      if (focusData.treeRun && focusData.treeRun.priority !== 'focused') focusData.treeRun.setPriority('focused');
      const before = playersInserted;
      insertPlayers();
      if (playersInserted !== before) {
        resolvePending();
        notify();
      }
    }
  } else if (focusData.treeRun) {
    clearTree();
    changed = true;
  }
  if (changed) {
    focusData.version++;
    notify();
  }
}

/** Forget the focused runs (e.g. when the word list changes). */
export function resetFocus(): void {
  clearCard();
  clearTree();
  pending = null;
  focusData.version++;
  notify();
}
