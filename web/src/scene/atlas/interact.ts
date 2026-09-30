// Pointer interactions on cards (shared by the card and atlas layers) and the
// store actions behind the card menu, dashed cards and compare selection.

import { app, type StrategyEntry } from '../../app/store.svelte';
import { focusTarget, setLevel, setOpener, setStrategy } from '../../app/actions';
import type { ScenePointerEvent } from '../types';
import { cells, gridAxes, seedAtlas } from './cells';
import { hitCell } from './layout';
import { cardUi } from './view.svelte';
import { director } from '../card/director';
import { medianTarget } from '../card/display';

function safe(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.warn('[card/atlas]', e);
  }
}

/** Near a level (not mid-transition), so taps mean something. */
function settledAt(): 2 | 3 | null {
  const z = director.z;
  if (Math.abs(z - 2) < 0.14) return 2;
  if (z > 2.86) return 3;
  return null;
}

export function cellAt(sx: number, sy: number): [number, number] | null {
  if (!director.active) return null;
  const p = director.screenToLayout(sx, sy);
  const hit = hitCell(director.layout, p.x, p.y);
  if (!hit) return null;
  const { columns, rows } = gridAxes();
  if (hit[0] >= columns.length || hit[1] >= rows.length) return null;
  return hit;
}

export function isFocusCell(c: number, r: number): boolean {
  const f = director.focusIdx;
  return !!f && f[0] === c && f[1] === r;
}

/** Focus the configuration of a cell (the camera glides to it). */
export function focusCell(c: number, r: number): void {
  const { columns, rows } = gridAxes();
  const s = columns[c], o = rows[r];
  if (!s || o === undefined) return;
  safe(() => {
    if (app.focus.strategy?.id !== s.id) setStrategy(s);
    if (app.focus.opener !== o) setOpener(o);
  });
}

/** Toggle a cell in the compare selection; two selected open the compare panel. */
export function toggleSelect(c: number, r: number): void {
  const sel = app.atlas.selected.filter(([a, b]) => !(a === c && b === r));
  if (sel.length === app.atlas.selected.length) sel.push([c, r]);
  while (sel.length > 2) sel.shift();
  app.atlas.selected = sel;
  if (sel.length === 2) app.ui.compare = true;
}

export function openSearch(): void {
  app.ui.search = true;
}

/** "+ Strategy": the Lab adds a strategy beside this card (the atlas is seeded first). */
export function addStrategy(): void {
  seedAtlas();
  app.ui.lab = true;
}

/** "+ Opener" / "Duplicate with another opener": the opener picker. */
export function addOpener(): void {
  seedAtlas();
  app.ui.openerPicker = true;
}

/** Remove a strategy column; the focus moves to a neighbour if it was there. */
export function removeColumn(c: number): void {
  seedAtlas();
  const cols = app.atlas.columns;
  if (cols.length <= 1 || c < 0 || c >= cols.length) return;
  const removed = cols[c];
  const next = cols.filter((_, i) => i !== c);
  app.atlas.columns = next;
  app.atlas.selected = [];
  if (app.focus.strategy?.id === removed.id) safe(() => setStrategy(next[Math.min(c, next.length - 1)]));
}

export function removeRow(r: number): void {
  seedAtlas();
  const rows = app.atlas.rows;
  if (rows.length <= 1 || r < 0 || r >= rows.length) return;
  const removed = rows[r];
  const next = rows.filter((_, i) => i !== r);
  app.atlas.rows = next;
  app.atlas.selected = [];
  if (app.focus.opener === removed) safe(() => setOpener(next[Math.min(r, next.length - 1)]));
}

/** Add a strategy column if missing. */
export function addColumn(entry: StrategyEntry): void {
  seedAtlas();
  if (!app.atlas.columns.some((c) => c.id === entry.id)) app.atlas.columns = [...app.atlas.columns, entry];
}

export function addRow(opener: string | null): void {
  seedAtlas();
  if (!app.atlas.rows.includes(opener)) app.atlas.rows = [...app.atlas.rows, opener];
}

/** Open the Tree view of a target for a configuration. */
export function openTree(strategy: StrategyEntry, opener: string | null, target: number): void {
  safe(() => {
    if (app.focus.strategy?.id !== strategy.id) setStrategy(strategy);
    if (app.focus.opener !== opener) setOpener(opener);
    focusTarget(target);
    setLevel(1);
  });
}

/** Zooming in from the card without a focused target: the median-difficulty target. */
export function ensureTreeTarget(): void {
  if (app.focus.target >= 0) return;
  const cell = cells.focus();
  if (!cell?.acc) return;
  let means: Float64Array;
  try {
    means = cell.acc.targetMeans();
  } catch {
    return;
  }
  const t = medianTarget(means);
  if (t >= 0) safe(() => focusTarget(t));
}

/** Shared pointer handling for cards; returns true if handled. */
export function handleCardPointer(e: ScenePointerEvent): boolean {
  const level = settledAt();
  if (level === null) return false;
  if (e.kind !== 'click' && e.kind !== 'dblclick' && e.kind !== 'contextmenu' && e.kind !== 'longpress') return false;
  const hit = cellAt(e.x, e.y);
  if (!hit) {
    if (e.kind === 'click' && cardUi.menu) {
      cardUi.menu = null;
      return true;
    }
    return false;
  }
  const [c, r] = hit;
  if (e.kind === 'contextmenu' || e.kind === 'longpress') {
    cardUi.menu = { x: e.x, y: e.y, col: c, row: r };
    return true;
  }
  if (cardUi.menu) cardUi.menu = null;
  if (e.kind === 'dblclick') {
    focusCell(c, r);
    if (level === 3) safe(() => setLevel(2));
    return true;
  }
  if (e.shiftKey || cardUi.compareMode) {
    toggleSelect(c, r);
    return true;
  }
  if (isFocusCell(c, r)) {
    if (level === 2) openSearch();
    else safe(() => setLevel(2));
    return true;
  }
  focusCell(c, r);
  return true;
}
