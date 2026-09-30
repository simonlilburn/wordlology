// Choreography of the Tree → Card and Card → Atlas transitions as pure
// functions of the zoom value, so they run in reverse and can be interrupted.

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
export function smootherstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export const STACK_PLANES = 24;
export const MAX_TILT = (30 * Math.PI) / 180;

export interface StackFrame {
  /** 0..1 progress of the camera from the tree view to the card view. */
  viewT: number;
  /** Extra pull-back: the view scale is multiplied by this (< 1 while pulled back). */
  pull: number;
  /** Camera tilt in radians (0 face-on). */
  tilt: number;
  /** Depth spread of the stacked planes (0 superimposed, 1 fully spread). */
  spread: number;
  /** Opacity multiplier shared by the planes (fades out as the ghost fades in). */
  planesAlpha: number;
  paperAlpha: number;
  faceAlpha: number;
  ghostAlpha: number;
  frameAlpha: number;
  /** Whether the perspective camera is needed this frame. */
  persp: boolean;
}

/** Tree → Card, u = z − 1 in [0, 1]. */
export function stackFrame(u: number): StackFrame {
  const x = clamp01(u);
  const tiltIn = smoothstep(0.04, 0.32, x);
  const tiltOut = 1 - smoothstep(0.52, 0.84, x);
  const tilt = MAX_TILT * tiltIn * tiltOut;
  const spread = smoothstep(0.06, 0.36, x) * (1 - smoothstep(0.5, 0.82, x));
  const persp = tilt > 1e-4 || spread > 1e-4;
  return {
    viewT: smootherstep(0.0, 0.92, x),
    pull: 1 - 0.32 * Math.sin(Math.PI * smoothstep(0.0, 0.9, x)),
    tilt,
    spread,
    planesAlpha: smoothstep(0.03, 0.2, x) * (1 - smoothstep(0.68, 0.94, x)),
    paperAlpha: smoothstep(0.42, 0.86, x),
    faceAlpha: smoothstep(0.55, 0.96, x),
    ghostAlpha: smoothstep(0.6, 0.95, x),
    frameAlpha: smoothstep(0.74, 1.0, x),
    persp,
  };
}

/** How far plane i (0 nearest) has slid in behind the current tree, 0..1. */
export function planeSlide(u: number, i: number, n = STACK_PLANES): number {
  const lag = (i / Math.max(1, n)) * 0.16;
  return smootherstep(0.04 + lag, 0.3 + lag, u);
}

export interface AtlasFrame {
  /** 0..1 progress of the camera from the card view to the atlas view. */
  viewT: number;
  /** Opacity of the other cells of the grid. */
  neighbourAlpha: number;
  /** Opacity of the dashed cards. */
  dashedAlpha: number;
  /** Opacity of the headers (DOM). */
  headerAlpha: number;
}

/** Card → Atlas from the continuous z (valid for any z). */
export function atlasFrame(z: number): AtlasFrame {
  return {
    viewT: smootherstep(2, 3, z),
    neighbourAlpha: smoothstep(1.86, 2.0, z),
    dashedAlpha: smoothstep(1.88, 2.02, z),
    headerAlpha: smoothstep(1.9, 2.1, z),
  };
}

/**
 * Reduced motion: every transition becomes a cross-fade of at most 200 ms.
 * Moves `current` toward `target` at a constant rate.
 */
export function fadeToward(current: number, target: number, dtMs: number, durationMs = 180): number {
  const step = durationMs > 0 ? dtMs / durationMs : 1;
  if (current < target) return Math.min(target, current + step);
  if (current > target) return Math.max(target, current - step);
  return current;
}
