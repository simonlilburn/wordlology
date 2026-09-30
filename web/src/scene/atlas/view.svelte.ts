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
});

export const cardUi = $state({
  menu: null as MenuState | null,
  /** Compare selection mode: plain clicks select cells. */
  compareMode: false,
  /** Show row/column mean margins in the atlas headers. */
  margins: false,
});

/** Assign only when changed (avoids needless Svelte updates from the render loop). */
export function publish<K extends keyof typeof sceneView>(key: K, value: (typeof sceneView)[K]): void {
  const cur = sceneView[key];
  if (typeof value === 'number' && typeof cur === 'number') {
    if (Math.abs(value - cur) < 1e-3) return;
  } else if (Array.isArray(value) && Array.isArray(cur)) {
    if (value.length === cur.length && value.every((v, i) => v === (cur as unknown[])[i])) return;
  } else if (value === cur) return;
  sceneView[key] = value;
}
