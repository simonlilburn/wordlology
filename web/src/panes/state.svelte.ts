// Pane-local state (side pane, bottom sheet, filter builder, target browser,
// opener picker). Owned by the panes agent. Nothing here is part of the
// configuration; the shared filter lives in app.filter.
//
// Contracts other areas may read (plain property reads, safe from requestAnimationFrame):
//
// - `paneState.revealRequest` (number): incremented each time the user presses
//   "Reveal matches" in the filter builder. The tree layer keeps the last value
//   it handled and, when it changes, expands just enough collapsed streams to
//   show the filter's matches (up to 50). `paneState.revealTarget` and
//   `paneState.revealFilter` record the target and filter text the request was
//   made for, so a stale request can be ignored.
//
// - `paneState.occluded` ({ top, right, bottom } in CSS px): how much of the
//   window the panes currently cover (side pane on the right on desktop, the
//   bottom sheet on phones, the target browser strip at the top). The scene may
//   use it to compute `SceneContext.viewport`.
//
// - `paneState.targetOrder` (answer indices): the target browser's current sort
//   order; `neighbourTarget(delta)` returns the previous/next target in it, so
//   the , and . shortcuts can follow the browser's order.
//
// - `paneState.riverGamesPerPx` (number, 0 = unknown): the tree layer may
//   publish its river width scale here (games per CSS pixel of ribbon width at
//   the current zoom); the legend then reads "1 px = n games".
//
// - Opener picker: `openOpenerPicker(mode)` opens it. `mode` is
//   `'atlas-row'` (the card's dashed "+ Opener" card: the chosen opener is
//   appended to app.atlas.rows, seeding the grid with the current card first)
//   or `'focus'` (the side pane: the chosen opener becomes app.focus.opener via
//   setOpener). Setting `app.ui.openerPicker = true` directly means
//   `'atlas-row'`, because that is what the card view does.

import { app } from '../app/store.svelte';

export type SheetState = 'collapsed' | 'half' | 'full';
export type OpenerPickerMode = 'atlas-row' | 'focus';
export type TargetSort = 'alpha' | 'mean' | 'fail' | 'breadth' | 'random';

export const paneState = $state({
  /** Bottom sheet height state on phones. */
  sheet: 'half' as SheetState,
  /** Whether the layout is the phone layout (bottom sheet). */
  phone: false,
  /** Filter builder expanded in the pane. */
  filterOpen: false,
  /** Reveal-matches request counter (see header). */
  revealRequest: 0,
  revealTarget: -1,
  revealFilter: '',
  /** Area covered by panes, CSS px. */
  occluded: { top: 0, right: 0, bottom: 0 },
  /** Opener picker mode (see header). */
  openerPickerMode: 'atlas-row' as OpenerPickerMode,
  /** Target browser sort order. */
  targetSort: 'alpha' as TargetSort,
  /** Seed for the random sort (changes when the user reshuffles). */
  randomSeed: 1,
  /** Current target browser order (answer indices). */
  targetOrder: [] as number[],
  /** River scale published by the tree layer (games per px), 0 = unknown. */
  riverGamesPerPx: 0,
  /** Filter builder settings kept while the filter is off (app.filter is null then). */
  filterCombine: 'all' as 'all' | 'any',
  filterMode: 'highlight' as 'highlight' | 'isolate',
  filterRows: [] as number[],
  filterIncludeFinal: true,
});

export function requestRevealMatches(): void {
  paneState.revealTarget = app.focus.target;
  paneState.revealFilter = app.filter?.text ?? '';
  paneState.revealRequest++;
}

export function openOpenerPicker(mode: OpenerPickerMode): void {
  paneState.openerPickerMode = mode;
  app.ui.openerPicker = true;
}

/** Close the picker and restore the default mode for the next opening from the card. */
export function closeOpenerPicker(): void {
  app.ui.openerPicker = false;
  paneState.openerPickerMode = 'atlas-row';
}

/** Previous (-1) or next (+1) target in the target browser's order, or null. */
export function neighbourTarget(delta: number): number | null {
  const order = paneState.targetOrder;
  if (!order.length) return null;
  const i = order.indexOf(app.focus.target);
  if (i < 0) return order[0];
  const j = i + delta;
  if (j < 0 || j >= order.length) return null;
  return order[j];
}

/** The level the app is at or heading to (rounded). */
export function currentLevel(): number {
  return Math.round(app.zDragging ? app.z : app.zTarget);
}
