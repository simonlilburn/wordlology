// Effects that keep derived state in step with the store. Owned by the platform agent.
//
// - focusData (model/focus.ts) follows the focused strategy, opener, target,
//   result settings, word list and player history;
// - the URL hash follows the view (debounced, replaceState);
// - display settings, recent openers, saved strategies and player branches
//   are written to this browser's storage;
// - reduced motion follows the Motion setting;
// - a pasted answer list always carries its sha256, and a changed answer
//   list reloads the word data.

import { untrack } from 'svelte';
import { syncFocus } from '../model/focus';
import { answersSha256 } from '../model/sha256';
import { selectionKey } from '../model/wordlists';
import { answerSelection } from './config';
import { saveDisplaySettings, savePlayerBranches, saveRecentOpeners, saveSavedStrategies } from './settings';
import { app } from './store.svelte';
import { encodeState, currentState, writeUrl } from './url';

export interface EffectHooks {
  reloadWords(): Promise<void>;
  resolveReducedMotion(): boolean;
}

const URL_DEBOUNCE_MS = 150;

let stop: (() => void) | null = null;

/** Start the app's effects (idempotent); returns a function that stops them. */
export function startEffects(hooks: EffectHooks): () => void {
  if (stop) return stop;
  let urlTimer: ReturnType<typeof setTimeout> | null = null;
  let savedLoaded = false;
  const cleanup = $effect.root(() => {
    // Focus: tree and card runs for the configuration in focus.
    $effect(() => {
      void app.words;
      void app.focus.strategy?.id;
      void JSON.stringify(app.focus.strategy?.spec ?? null);
      void app.focus.opener;
      void app.focus.target;
      void JSON.stringify(app.result);
      void app.game.history.length;
      untrack(() => syncFocus());
    });

    // Shareable state in the address bar.
    $effect(() => {
      void app.focus.node;
      const h = encodeState(currentState());
      untrack(() => {
        if (urlTimer) clearTimeout(urlTimer);
        urlTimer = setTimeout(() => {
          urlTimer = null;
          writeUrl();
        }, URL_DEBOUNCE_MS);
      });
      return () => void h;
    });

    // Display settings are kept per browser; motion follows them.
    $effect(() => {
      void JSON.stringify(app.display);
      untrack(() => {
        saveDisplaySettings();
        hooks.resolveReducedMotion();
      });
    });

    $effect(() => {
      void app.focus.recentOpeners.join(',');
      untrack(() => saveRecentOpeners());
    });

    $effect(() => {
      const s = JSON.stringify(app.saved);
      untrack(() => {
        // Skip the first run so an empty list never overwrites the Lab's stored strategies.
        if (savedLoaded) saveSavedStrategies();
        savedLoaded = true;
      });
      return () => void s;
    });

    // Player branches, per the "Player branches" setting.
    $effect(() => {
      void app.game.history.length;
      void app.display.keepPlayerBranches;
      void app.words;
      untrack(() => savePlayerBranches());
    });

    // Pasted answer lists carry their sha256; a changed answer list reloads the word data.
    $effect(() => {
      const a = app.result.answers;
      if (a.kind === 'pasted' && !a.sha256) {
        const sha = answersSha256(a.words);
        untrack(() => {
          if (app.result.answers.kind === 'pasted') app.result.answers.sha256 = sha;
        });
        return;
      }
      const key = selectionKey(answerSelection(app.result));
      const words = app.words;
      untrack(() => {
        if (words && selectionKey(words.selection) !== key) void hooks.reloadWords();
      });
    });
  });
  stop = () => {
    cleanup();
    if (urlTimer) clearTimeout(urlTimer);
    stop = null;
  };
  return stop;
}
