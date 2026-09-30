// Grid layout for cards (pure). Layout units are CSS pixels at view scale 1,
// y pointing down; the scene maps them into world coordinates.

export const CARD_W = 360;
export const CARD_H = 480;
export const GAP = 64;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GridLayout {
  cols: number;
  rows: number;
  pitchX: number;
  pitchY: number;
  /** Dashed "+ Strategy" column at the right of the grid. */
  dashedCol: Rect;
  /** Dashed "+ Opener" row below the grid. */
  dashedRow: Rect;
  /** Cells plus the dashed column and row. */
  bounds: Rect;
}

export function gridLayout(cols: number, rows: number): GridLayout {
  const c = Math.max(1, cols), r = Math.max(1, rows);
  const pitchX = CARD_W + GAP, pitchY = CARD_H + GAP;
  const gridW = c * pitchX - GAP, gridH = r * pitchY - GAP;
  const dashedCol = { x: c * pitchX, y: 0, w: Math.round(CARD_W * 0.62), h: gridH };
  const dashedRow = { x: 0, y: r * pitchY, w: gridW, h: Math.round(CARD_H * 0.42) };
  return {
    cols: c,
    rows: r,
    pitchX,
    pitchY,
    dashedCol,
    dashedRow,
    bounds: { x: 0, y: 0, w: dashedCol.x + dashedCol.w, h: dashedRow.y + dashedRow.h },
  };
}

export function cellRect(layout: GridLayout, col: number, row: number): Rect {
  return { x: col * layout.pitchX, y: row * layout.pitchY, w: CARD_W, h: CARD_H };
}

/** Column/row index under a layout point, or -1 (gaps count as misses). */
export function hitCell(layout: GridLayout, x: number, y: number): [number, number] | null {
  const c = Math.floor(x / layout.pitchX), r = Math.floor(y / layout.pitchY);
  if (c < 0 || r < 0 || c >= layout.cols || r >= layout.rows) return null;
  const rect = cellRect(layout, c, r);
  if (x > rect.x + rect.w || y > rect.y + rect.h) return null;
  return [c, r];
}

export function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;
}

/** A view: the layout point at the viewport centre and CSS px per layout unit. */
export interface View {
  cx: number;
  cy: number;
  scale: number;
}

export interface Viewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Margins {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Fit a rect into the viewport, leaving screen-space margins (for DOM headers). */
export function fitView(r: Rect, vp: Viewport, m: Margins, maxScale = 3): View {
  const aw = Math.max(40, vp.width - m.left - m.right);
  const ah = Math.max(40, vp.height - m.top - m.bottom);
  const scale = Math.min(maxScale, aw / Math.max(1, r.w), ah / Math.max(1, r.h));
  // The centre of the inner region, relative to the viewport centre, in layout units.
  const offX = (m.left - m.right) / 2 / scale;
  const offY = (m.top - m.bottom) / 2 / scale;
  return { cx: r.x + r.w / 2 - offX, cy: r.y + r.h / 2 - offY, scale };
}

/** Screen px kept free below the Card view for the card toolbar. */
export const CARD_TOOLBAR_H = 60;
/** Viewports narrower than this (phones) get a compact Card view with smaller peeks. */
export const COMPACT_VIEWPORT = 600;

/**
 * The Card view of one cell: the card large, with the right and lower
 * neighbours (or the dashed "+ Strategy" / "+ Opener" cards) peeking in, and
 * room below for the toolbar. Narrow viewports peek less, so the card stays
 * legible on a phone.
 */
export function cardView(r: Rect, vp: Viewport, maxScale = 2.4): View {
  const compact = vp.width < COMPACT_VIEWPORT;
  const region = cardRegion(r, compact);
  const reserve = Math.min(CARD_TOOLBAR_H, vp.height * 0.15);
  const h = Math.max(40, vp.height - reserve);
  const scale = Math.max(0.05, Math.min(maxScale, (vp.width * 0.96) / region.w, (h * 0.96) / region.h));
  // Centre the region in the viewport above the toolbar reserve.
  return { cx: region.x + region.w / 2, cy: region.y + region.h / 2 + reserve / 2 / scale, scale };
}

/** The layout region the Card view fits: the card plus a peek at its right and lower neighbours. */
export function cardRegion(r: Rect, compact = false): Rect {
  const pad = compact ? 12 : 20;
  const peekX = Math.round(CARD_W * (compact ? 0.16 : 0.42)), peekY = Math.round(CARD_H * (compact ? 0.1 : 0.3));
  return { x: r.x - pad, y: r.y - pad, w: r.w + pad + GAP + peekX, h: r.h + pad + GAP + peekY };
}

/** Interpolate views: centre linearly, scale geometrically. */
export function lerpView(a: View, b: View, t: number): View {
  const u = Math.max(0, Math.min(1, t));
  return {
    cx: a.cx + (b.cx - a.cx) * u,
    cy: a.cy + (b.cy - a.cy) * u,
    scale: Math.exp(Math.log(a.scale) + (Math.log(b.scale) - Math.log(a.scale)) * u),
  };
}

/** Affine layout → screen map for a view: sx = tx + x·s, sy = ty + y·s. */
export function viewTransform(v: View, vp: Viewport): { tx: number; ty: number; s: number } {
  const vx = vp.left + vp.width / 2, vy = vp.top + vp.height / 2;
  return { tx: vx - v.cx * v.scale, ty: vy - v.cy * v.scale, s: v.scale };
}

export function screenToLayout(v: View, vp: Viewport, sx: number, sy: number): { x: number; y: number } {
  const t = viewTransform(v, vp);
  return { x: (sx - t.tx) / t.s, y: (sy - t.ty) / t.s };
}

/** Whether a layout rect is at least partly on screen. */
export function rectVisible(r: Rect, v: View, vp: Viewport, pad = 0): boolean {
  const t = viewTransform(v, vp);
  const x0 = t.tx + r.x * t.s, y0 = t.ty + r.y * t.s;
  const x1 = x0 + r.w * t.s, y1 = y0 + r.h * t.s;
  return x1 >= vp.left - pad && x0 <= vp.left + vp.width + pad && y1 >= vp.top - pad && y0 <= vp.top + vp.height + pad;
}

export type Lod = 'full' | 'chip' | 'micro';

/** Level of detail for a card drawn `screenH` CSS px tall (hysteresis around the current level). */
export function lodFor(screenH: number, current: Lod | null = null): Lod {
  const FULL = 200, CHIP = 56, H = 12;
  if (current === 'full' && screenH >= FULL - H) return 'full';
  if (current === 'chip' && screenH >= CHIP - H && screenH < FULL + H) return 'chip';
  if (current === 'micro' && screenH < CHIP + H) return 'micro';
  return screenH >= FULL ? 'full' : screenH >= CHIP ? 'chip' : 'micro';
}

const BUCKETS = [96, 128, 192, 256, 384, 512, 768, 1024, 1280, 1536];

/** Texture height (device px) for a card drawn `devicePx` tall: the smallest bucket that covers it. */
export function resolutionBucket(devicePx: number): number {
  for (const b of BUCKETS) if (b >= devicePx) return b;
  return BUCKETS[BUCKETS.length - 1];
}
