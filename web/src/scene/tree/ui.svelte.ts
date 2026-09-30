// State the tree layer publishes for its DOM overlays (views/tree): zoom
// controls, Skip, the computing status, the path tooltip and the minimap.
// The layer writes a field only when its value changes, so Svelte does work
// only on real changes.

export interface TooltipInfo {
  /** Trie node id of the path's end (for an ellipsis: its parent). */
  node: number;
  kind: 'node' | 'ellipsis' | 'out';
  /** Anchor in CSS px relative to the canvas: below the node's label (`y`) and above it (`top`). */
  x: number;
  y: number;
  top: number;
  /** Pinned by a tap/click (shows Play); otherwise a hover preview. */
  pinned: boolean;
  /** Ellipsis: hidden paths, their games and filter matches. */
  hidden?: { count: number; games: number; matches: number };
}

export interface MinimapInfo {
  show: boolean;
  /** Tree bounds (world). */
  minX: number;
  maxX: number;
  top: number;
  bottom: number;
  /** Visible world rectangle. */
  vx0: number;
  vx1: number;
  vy0: number;
  vy1: number;
  /** Bumps when the silhouette changes. */
  version: number;
  /** Viewport box (CSS px) the minimap sits in. */
  right: number;
  bottom_px: number;
}

export const treeUi = $state({
  /** The Tree view is on screen and interactive. */
  active: false,
  /** Opacity for the DOM controls (follows z). */
  alpha: 0,
  growing: false,
  /** Games computed / total while the run is behind (null when it is not). */
  computing: null as null | { done: number; total: number },
  /** The growth animation is waiting for compute. */
  stalled: false,
  deterministic: false,
  /** Games in the focused tree and the target word (for the outline's heading). */
  games: 0,
  target: '',
  tooltip: null as TooltipInfo | null,
  minimap: {
    show: false,
    minX: 0,
    maxX: 0,
    top: 0,
    bottom: 0,
    vx0: 0,
    vx1: 0,
    vy0: 0,
    vy1: 0,
    version: 0,
    right: 16,
    bottom_px: 16,
  } as MinimapInfo,
  /** At the fit scale (− then continues to the Card level). */
  atFit: true,
  atMax: false,
  /** Bumps whenever the focused tree's data changes (the outline refreshes). */
  version: 0,
  /** Viewport (uncovered canvas region, CSS px). */
  viewport: { left: 0, top: 0, width: 0, height: 0 },
  /** The text outline panel is open (views/tree). */
  outlineOpen: false,
});

/** Silhouette segments for the minimap: x0, y0, x1, y1, width (world), flat. Not reactive (read on version bumps). */
export const silhouette: { segs: Float32Array; n: number } = { segs: new Float32Array(0), n: 0 };

type UiKey = Exclude<keyof typeof treeUi, 'minimap' | 'tooltip' | 'computing' | 'viewport' | 'outlineOpen'>;

/** Write a scalar field only when it changed. */
export function setUi<K extends UiKey>(key: K, value: (typeof treeUi)[K]): void {
  if (treeUi[key] !== value) treeUi[key] = value;
}

export function setTooltip(t: TooltipInfo | null): void {
  const o = treeUi.tooltip;
  if (t === null) {
    if (o !== null) treeUi.tooltip = null;
    return;
  }
  if (
    o &&
    o.node === t.node &&
    o.kind === t.kind &&
    Math.abs(o.x - t.x) < 0.5 &&
    Math.abs(o.y - t.y) < 0.5 &&
    Math.abs(o.top - t.top) < 0.5 &&
    o.pinned === t.pinned &&
    (o.hidden?.count ?? -1) === (t.hidden?.count ?? -1) &&
    (o.hidden?.matches ?? -1) === (t.hidden?.matches ?? -1)
  )
    return;
  treeUi.tooltip = t;
}

export function setComputing(c: null | { done: number; total: number }): void {
  const o = treeUi.computing;
  if (c === null) {
    if (o !== null) treeUi.computing = null;
    return;
  }
  if (o && o.done === c.done && o.total === c.total) return;
  treeUi.computing = c;
}

export function setMinimap(m: Omit<MinimapInfo, 'version'>, bump: boolean): void {
  const o = treeUi.minimap;
  let changed = bump;
  for (const k of Object.keys(m) as (keyof typeof m)[]) {
    const a = o[k];
    const b = m[k];
    if (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) > 0.01 : a !== b) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  treeUi.minimap = { ...m, version: o.version + (bump ? 1 : 0) };
}

export function setViewport(v: { left: number; top: number; width: number; height: number }): void {
  const o = treeUi.viewport;
  if (o.left === v.left && o.top === v.top && o.width === v.width && o.height === v.height) return;
  treeUi.viewport = { ...v };
}
