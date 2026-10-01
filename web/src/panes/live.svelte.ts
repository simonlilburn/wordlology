// Reactive ticks for data that lives outside the Svelte store (focusData, runs).
// focusData is a plain object that the platform replaces and mutates as games
// stream in; panes poll its version counters a few times a second so readouts
// stay current without doing work on every animation frame.
import { focusData } from '../model/focus';

export const live = $state({
  /** Changes when the focused tree (or its run) changes. */
  tree: 0,
  /** Changes when the focused card run (or card) changes. */
  card: 0,
});

let lastTree = '';
let lastCard = '';

function poll(): void {
  try {
    const t = `${focusData.version}|${focusData.tree?.version ?? -1}|${focusData.tree?.target ?? -1}|${focusData.treeRun?.version ?? -1}`;
    const c = `${focusData.version}|${focusData.cardRun?.key ?? ''}|${focusData.cardRun?.version ?? -1}|${focusData.cardRun?.games.length ?? -1}`;
    if (t !== lastTree) {
      lastTree = t;
      live.tree++;
    }
    if (c !== lastCard) {
      lastCard = c;
      live.card++;
    }
  } catch {
    // focusData not ready yet.
  }
}

let started = false;
/** Start polling (idempotent; browser only). */
export function startLive(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  poll();
  window.setInterval(poll, 250);
}
