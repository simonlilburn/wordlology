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

/**
 * The arrival camera: trunk centred, header at the top, scale 1 or smaller
 * to fit the tree's height, but not below `minScale` (on a short phone
 * viewport the lower rows then start below the fold rather than every label
 * shrinking into a tick).
 */
export function homeCamera(b: Bounds, vp: Viewport, minScale = 0.8): CamState {
  const h = Math.max(1, b.top - b.bottom);
  const s = Math.max(0.02, Math.min(1, Math.max(minScale, (vp.height - 2 * FIT_MARGIN) / h)));
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

/** How far panes cover each edge of the canvas (CSS px). */
export interface Occlusion {
  top: number;
  right: number;
  bottom: number;
}

export function occlusionOf(vp: Viewport, width: number, height: number): Occlusion {
  return { top: vp.top, right: Math.max(0, width - vp.left - vp.width), bottom: Math.max(0, height - vp.top - vp.height) };
}

/**
 * The viewport the tree lays itself out in. Between the Game and the Tree the
 * panes that cover the tree at the Tree level (the target strip, the side
 * pane) are still arriving, so the larger of the current cover and the cover
 * expected at the Tree level is used: the tiles fly to where the labels will
 * stay instead of the tree jumping when the panes appear.
 */
export function expectedViewport(cur: Viewport, width: number, height: number, arrival: Occlusion | null): Viewport {
  if (!arrival) return { ...cur };
  const o = occlusionOf(cur, width, height);
  const top = Math.max(o.top, Math.min(arrival.top, height * 0.5));
  const right = Math.max(o.right, Math.min(arrival.right, width * 0.7));
  const bottom = Math.max(o.bottom, Math.min(arrival.bottom, height * 0.8));
  return { left: cur.left, top, width: Math.max(1, width - cur.left - right), height: Math.max(1, height - top - bottom) };
}

/** Ease a viewport toward a target (exponential, `tauMs`); returns true once it has arrived. */
export function approachViewport(v: Viewport, t: Viewport, dtMs: number, tauMs = 90): boolean {
  const k = 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
  let done = true;
  for (const key of ['left', 'top', 'width', 'height'] as const) {
    const d = t[key] - v[key];
    if (Math.abs(d) < 0.5) v[key] = t[key];
    else {
      v[key] += d * k;
      done = false;
    }
  }
  return done;
}

/**
 * Scale factor of the Tree ↔ Tree flip at `t` ms into a flip of `dur` ms:
 * the tree shrinks toward the target strip and grows back (1 outside the flip).
 */
export function flipPulse(t: number, dur: number, depth = 0.16): number {
  if (!(t >= 0) || t >= dur || dur <= 0) return 1;
  return 1 - depth * Math.sin((Math.PI * t) / dur);
}
