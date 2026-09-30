// Guarded access to the platform: feedback, configs and the solver backend.
// Everything here degrades to null while a piece is not ready (or throws), so
// the Game view renders without it.

import type { Config, SolverBackend } from '../../backend/types';
import { backend } from '../../backend/index';
import { feedback as modelFeedback } from '../../model/feedback';
import { makeConfig, specLabel } from '../../app/config';
import { app } from '../../app/store.svelte';

/** Run fn, returning fallback if it throws (unimplemented platform stubs). */
export function attempt<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Feedback code of guess against target, or null if unavailable. */
export function feedbackOrNull(guess: string, target: string): number | null {
  return attempt<number | null>(() => modelFeedback(guess, target), null);
}

/** The app's solver backend once the solver has loaded the word list, else null. */
export function getBackend(): Promise<SolverBackend | null> {
  return Promise.resolve(app.solverReady ? backend : null);
}

/** The configuration the replayed path came from, or the focused tree configuration. */
export function replayConfig(): Config | null {
  if (app.replay.config) return app.replay.config;
  return focusedConfig();
}

/** The Tree view configuration of the focused strategy and opener. */
export function focusedConfig(): Config | null {
  const strategy = app.focus.strategy?.spec ?? app.result.arrivalStrategy;
  return attempt<Config | null>(() => makeConfig({ strategy, opener: app.focus.opener, kind: 'tree' }), null);
}

/** A short label for a configuration's strategy. */
export function strategyLabel(config: Config | null): string {
  if (!config) return app.focus.strategy?.label ?? '';
  if (app.focus.strategy && JSON.stringify(app.focus.strategy.spec) === JSON.stringify(config.strategy)) return app.focus.strategy.label;
  return attempt(() => specLabel(config.strategy), config.strategy.kind.replace(/_/g, ' '));
}
