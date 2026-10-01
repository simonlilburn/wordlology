// Per-target statistics of the focused card run, shared by the target browser
// and target search. Synced from focusData.cardRun whenever the live card tick
// changes (a few times a second at most).
import { focusData } from '../../model/focus';
import { app } from '../../app/store.svelte';
import { TargetIndex } from './stats';

export const targetIndex = new TargetIndex(6);

/** Reactive version of targetIndex (bumped after each sync that changed something). */
export const targets = $state({ version: 0 });

/**
 * Bring the index up to date with the focused card run (call from an $effect
 * that depends on live.card, not from a $derived: it writes state).
 */
export function syncTargets(): TargetIndex {
  let changed = false;
  try {
    changed = targetIndex.sync(focusData.cardRun);
  } catch {
    changed = false;
  }
  if (changed) targets.version = targetIndex.version;
  return targetIndex;
}

/** All answer indices of the loaded word list. */
export function allTargets(): number[] {
  const n = app.words?.answers.length ?? 0;
  return Array.from({ length: n }, (_, i) => i);
}
