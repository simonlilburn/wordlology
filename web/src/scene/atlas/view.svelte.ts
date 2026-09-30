// Reactive view state shared by the card/atlas scene layers and their DOM
// overlays. The scene writes it (only when values change); overlays read it.

export interface MenuState {
  /** Screen position (CSS px) of the menu. */
  x: number;
  y: number;
  col: number;
  row: number;
}

export const sceneView = $state({
  /** Card/atlas content is on screen (z > 1). */
  visible: false,
  z: 0,
  /** Layout → screen transform: sx = tx + x·s, sy = ty + y·s. */
  tx: 0,
  ty: 0,
  s: 1,
  cols: 1,
  rows: 1,
  /** Two or more cells (the Atlas layout, even at card zoom). */
  grid: false,
  focus: null as [number, number] | null,
  /** Opacity of the focused card (fades in during Tree → Card). */
  cardAlpha: 0,
  headerAlpha: 0,
  dashedAlpha: 0,
  /** Camera is between levels. */
  transitioning: false,
  /** The scene viewport not covered by panes (CSS px). */
  vp: { left: 0, top: 0, width: 0, height: 0 },
  /** Increments (at most 4 times a second) when any card's data changes; overlays recompute on it. */
  tick: 0,
});

export const cardUi = $state({
  menu: null as MenuState | null,
  /** Compare selection mode: plain clicks select cells. */
  compareMode: false,
  /** Show row/column mean margins in the atlas headers. */
  margins: false,
  /** Show the text-alternative table (card distribution / atlas means) visibly. */
  table: false,
});

const seenVersions = new WeakMap<object, number>();
let pendingTick = false;
let lastTick = -Infinity;
const TICK_MS = 250;

/** Note a card's data version; a change schedules a data tick for the overlays. */
export function watchVersion(owner: object, version: number): void {
  if (seenVersions.get(owner) !== version) {
    seenVersions.set(owner, version);
    pendingTick = true;
  }
}

/** Publish a pending data tick (throttled). Returns true while one is still waiting (keep rendering). */
export function flushTick(now: number): boolean {
  if (!pendingTick) return false;
  if (now - lastTick < TICK_MS) return true;
  lastTick = now;
  pendingTick = false;
  sceneView.tick++;
  return false;
}

/** Assign only when changed (avoids needless Svelte updates from the render loop). */
export function publish<K extends keyof typeof sceneView>(key: K, value: (typeof sceneView)[K]): void {
  const cur = sceneView[key];
  if (typeof value === 'number' && typeof cur === 'number') {
    if (Math.abs(value - cur) < 1e-3) return;
  } else if (Array.isArray(value) && Array.isArray(cur)) {
    if (value.length === cur.length && value.every((v, i) => v === (cur as unknown[])[i])) return;
  } else if (value && cur && typeof value === 'object' && typeof cur === 'object') {
    const a = value as Record<string, unknown>, b = cur as Record<string, unknown>;
    const keys = Object.keys(a);
    if (keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])) return;
  } else if (value === cur) return;
  sceneView[key] = value;
}
