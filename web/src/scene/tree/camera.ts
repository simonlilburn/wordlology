// The Tree view camera: the world point at the centre of the uncovered
// viewport and a scale (CSS px per world unit). Pure; the layer applies it to
// the shared orthographic camera.

export interface CamState {
  cx: number;
  cy: number;
  s: number;
}

export interface Viewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Bounds {
  minX: number;
  maxX: number;
  top: number;
  bottom: number;
}

export const MAX_SCALE = 16;
/** Screen margin kept around a fitted tree (px). */
export const FIT_MARGIN = 16;

export function vpCentre(vp: Viewport): { x: number; y: number } {
  return { x: vp.left + vp.width / 2, y: vp.top + vp.height / 2 };
}

export function screenToWorld(c: CamState, vp: Viewport, sx: number, sy: number): { x: number; y: number } {
  const v = vpCentre(vp);
  return { x: c.cx + (sx - v.x) / c.s, y: c.cy - (sy - v.y) / c.s };
}

export function worldToScreen(c: CamState, vp: Viewport, wx: number, wy: number): { x: number; y: number } {
  const v = vpCentre(vp);
  return { x: v.x + (wx - c.cx) * c.s, y: v.y - (wy - c.cy) * c.s };
}

/** Scale at which the whole tree fits with the trunk (x = 0) centred; never above 1. */
export function fitScale(b: Bounds, vp: Viewport): number {
  const halfW = Math.max(-b.minX, b.maxX, 1);
  const h = Math.max(1, b.top - b.bottom);
  const sw = (vp.width / 2 - FIT_MARGIN) / halfW;
  const sh = (vp.height - 2 * FIT_MARGIN) / h;
  return Math.max(0.02, Math.min(1, sw, sh));
}

/** The fitted camera: trunk centred, tree centred vertically (or top-aligned when it is shorter than the view). */
export function fitCamera(b: Bounds, vp: Viewport): CamState {
  const s = fitScale(b, vp);
  const h = (b.top - b.bottom) * s;
  const cy = h <= vp.height - 2 * FIT_MARGIN ? b.top - (vp.height / 2 - FIT_MARGIN) / s : (b.top + b.bottom) / 2;
  return { cx: 0, cy, s };
}

/** The arrival camera: scale 1 (or the fit scale if smaller vertically), trunk centred, header at the top. */
export function homeCamera(b: Bounds, vp: Viewport): CamState {
  const h = Math.max(1, b.top - b.bottom);
  const s = Math.max(0.02, Math.min(1, (vp.height - 2 * FIT_MARGIN) / h));
  return { cx: 0, cy: b.top - (vp.height / 2 - FIT_MARGIN) / s, s };
}

/**
 * Zoom by `factor` about a screen point, clamped to [minS, MAX_SCALE].
 * Returns the new state and the part of the factor that was not applied
 * (< 1 when zooming out past the minimum).
 */
export function zoomAt(c: CamState, vp: Viewport, factor: number, sx: number, sy: number, minS: number): { cam: CamState; rest: number } {
  const s1 = Math.min(MAX_SCALE, Math.max(minS, c.s * factor));
  const w = screenToWorld(c, vp, sx, sy);
  const v = vpCentre(vp);
  const cam = { cx: w.x - (sx - v.x) / s1, cy: w.y + (sy - v.y) / s1, s: s1 };
  return { cam, rest: factor / (s1 / c.s) };
}

/** Keep the view centre over the tree. */
export function clampToBounds(c: CamState, b: Bounds): CamState {
  return { cx: Math.min(b.maxX, Math.max(b.minX, c.cx)), cy: Math.min(b.top, Math.max(b.bottom, c.cy)), s: c.s };
}

/** Exponential approach toward a target (log space for scale). Returns true when it arrived. */
export function approach(c: CamState, t: CamState, dtMs: number, tauMs = 110): boolean {
  const k = 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
  c.cx += (t.cx - c.cx) * k;
  c.cy += (t.cy - c.cy) * k;
  c.s = Math.exp(Math.log(c.s) + (Math.log(t.s) - Math.log(c.s)) * k);
  const done = Math.abs(t.cx - c.cx) * c.s < 0.3 && Math.abs(t.cy - c.cy) * c.s < 0.3 && Math.abs(Math.log(t.s / c.s)) < 1e-3;
  if (done) {
    c.cx = t.cx;
    c.cy = t.cy;
    c.s = t.s;
  }
  return done;
}

/** Quantised layout scale: half-octave steps, at least 1. */
export function layoutScale(s: number): number {
  if (!(s > 1)) return 1;
  return Math.min(MAX_SCALE, Math.pow(2, Math.floor(Math.log2(s) * 2 + 1e-6) / 2));
}
