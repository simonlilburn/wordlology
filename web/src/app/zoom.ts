// The level zoom value z (0 Game, 1 Tree, 2 Card, 3 Atlas). Owned by the platform agent.
// Input handlers call zoomBy during a gesture and endZoomGesture on release;
// z then snaps to the nearest level with ±0.15 hysteresis.
//
// z follows zTarget on a critically damped spring driven by
// requestAnimationFrame. With reduced motion z moves linearly and reaches its
// target within 200 ms (level renderers turn that into a cross-fade).

import { app, type Level } from './store.svelte';

export const Z_MIN = 0;
export const Z_MAX = 3;
/** Past the midpoint between levels by this much before a release snaps to the next level. */
export const HYSTERESIS = 0.15;
/** Spring stiffness (rad/s): a one-level move settles in about 1.2 s. */
const OMEGA = 5.5;
/**
 * Stiffness between the Tree and Card levels, where the sampled trees stack
 * up behind the current one: about 2.5 times slower, so the stack can be
 * followed (95% of the way in about 2.2 s).
 */
export const OMEGA_STACK = 2.2;
/** Reduced motion: full-level move time. */
const REDUCED_MS = 200;

let velocity = 0;
let raf = 0;
let lastTime = 0;
/** Level at the start of the current gesture (for hysteresis). */
let gestureBase: number | null = null;
let wheelTimer: ReturnType<typeof setTimeout> | null = null;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function clamp(z: number): number {
  return Math.min(Z_MAX, Math.max(Z_MIN, z));
}

/** The level nearest the current target (the level "we are at"). */
export function currentLevel(): Level {
  return Math.round(clamp(app.zTarget)) as Level;
}

/** Spring stiffness for a move from z toward target: slower while both lie between Tree (1) and Card (2). */
export function stiffness(z: number, target: number): number {
  const lo = Math.min(z, target), hi = Math.max(z, target);
  return lo >= 1 - 1e-3 && hi <= 2 + 1e-3 ? OMEGA_STACK : OMEGA;
}

/** Advance the animation by dt ms. Exported for tests; the rAF loop calls it. Returns true while moving. */
export function stepZoom(dtMs: number): boolean {
  if (app.zDragging) return false;
  const target = clamp(app.zTarget);
  const z = app.z;
  const dt = Math.min(dtMs, 64) / 1000;
  if (app.reducedMotion) {
    const step = (dt * 1000) / REDUCED_MS;
    const d = target - z;
    velocity = 0;
    if (Math.abs(d) <= step) {
      app.z = target;
      return false;
    }
    app.z = z + Math.sign(d) * step;
    return true;
  }
  // Critically damped spring: x'' = -w^2 (x - target) - 2 w x', integrated exactly over dt.
  const w = stiffness(z, target);
  const x0 = z - target;
  const v0 = velocity;
  const e = Math.exp(-w * dt);
  const a = x0;
  const b = v0 + w * x0;
  const x = (a + b * dt) * e;
  velocity = (b - w * (a + b * dt)) * e;
  if (Math.abs(x) < 5e-4 && Math.abs(velocity) < 5e-3) {
    app.z = target;
    velocity = 0;
    return false;
  }
  app.z = clamp(target + x);
  return true;
}

function frame(t: number): void {
  raf = 0;
  const dt = lastTime ? t - lastTime : 16;
  lastTime = t;
  if (stepZoom(dt)) schedule();
  else lastTime = 0;
}

function schedule(): void {
  if (raf || typeof requestAnimationFrame === 'undefined') return;
  raf = requestAnimationFrame(frame);
}

/** Make sure the spring is running toward zTarget (call after changing app.zTarget directly). */
export function kick(): void {
  if (app.z !== app.zTarget) schedule();
}

/** Move z continuously by dz (positive = zoom out) during a pinch/scroll gesture. */
export function zoomBy(dz: number): void {
  if (!Number.isFinite(dz) || dz === 0) return;
  if (gestureBase === null) gestureBase = currentLevel();
  app.zDragging = true;
  velocity = 0;
  const z = clamp(app.z + dz);
  app.z = z;
  app.zTarget = z;
}

/**
 * Wheel input: like zoomBy, but the gesture ends by itself after `idleMs`
 * without further wheel events (wheels have no release event).
 */
export function zoomByWheel(dz: number, idleMs = 180): void {
  zoomBy(dz);
  if (wheelTimer) clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => {
    wheelTimer = null;
    endZoomGesture();
  }, idleMs);
}

/** The level a release at z snaps to, starting from level `base`, with hysteresis. */
export function snapLevel(z: number, base: number): Level {
  let lvl = Math.round(clamp(base));
  const zz = clamp(z);
  while (lvl < Z_MAX && zz > lvl + 0.5 + HYSTERESIS) lvl++;
  while (lvl > Z_MIN && zz < lvl - 0.5 - HYSTERESIS) lvl--;
  return lvl as Level;
}

/** Gesture ended: snap to a level. */
export function endZoomGesture(): void {
  if (wheelTimer) {
    clearTimeout(wheelTimer);
    wheelTimer = null;
  }
  const base = gestureBase ?? Math.round(app.z);
  gestureBase = null;
  app.zDragging = false;
  animateTo(snapLevel(app.z, base));
}

/** Animate z to a level. */
export function animateTo(level: number): void {
  const lvl = Math.round(clamp(level));
  app.zDragging = false;
  gestureBase = null;
  app.zTarget = lvl;
  kick();
}

/** Jump to a level without animation (used when restoring a link). */
export function jumpTo(level: number): void {
  const lvl = Math.round(clamp(level));
  velocity = 0;
  app.zDragging = false;
  app.zTarget = lvl;
  app.z = lvl;
}
