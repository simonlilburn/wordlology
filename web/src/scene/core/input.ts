// Pointer, wheel and pinch input on the scene canvas, turned into
// ScenePointerEvents for the layers. The topmost layer (last registered)
// sees events first; a layer that handles 'down' captures the gesture (its
// moves pan). Wheel and pinch go to the layers' wheel handlers, and anything
// no layer takes moves the level zoom (zoomBy / endZoomGesture).

import { app } from '../../app/store.svelte';
import { endZoomGesture, zoomBy, zoomByWheel } from '../../app/zoom';
import type { SceneContext, SceneLayer, ScenePointerEvent } from '../types';

const LONG_PRESS_MS = 550;
const DOUBLE_MS = 350;
const DOUBLE_PX = 24;

export interface InputHost {
  layers(): readonly SceneLayer[];
  ctx: SceneContext;
  wake(): void;
}

interface Press {
  id: number;
  x0: number;
  y0: number;
  moved: boolean;
  long: boolean;
  layer: SceneLayer | null;
  timer: ReturnType<typeof setTimeout> | null;
  type: string;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (e) {
    console.warn('[scene] layer input', e);
    return fallback;
  }
}

export function attachInput(canvas: HTMLCanvasElement, host: InputHost): () => void {
  const pointers = new Map<number, { x: number; y: number }>();
  let press: Press | null = null;
  let lastClick = { t: -Infinity, x: 0, y: 0 };
  let pinch: { d: number; handled: boolean; level: boolean } | null = null;

  const local = (e: PointerEvent | WheelEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const make = (kind: ScenePointerEvent['kind'], x: number, y: number, e: { pointerType?: string; shiftKey: boolean; button: number }): ScenePointerEvent => ({
    kind,
    x,
    y,
    world: host.ctx.screenToWorld(x, y),
    pointerType: e.pointerType ?? 'mouse',
    shiftKey: e.shiftKey,
    button: e.button,
  });

  /** Offer an event to the layers, topmost first; returns the layer that took it. */
  const offer = (ev: ScenePointerEvent): SceneLayer | null => {
    const layers = host.layers();
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      if (l.pointer && safe(() => l.pointer!(ev, host.ctx), false)) return l;
    }
    return null;
  };

  const to = (l: SceneLayer | null, ev: ScenePointerEvent) => {
    if (l?.pointer) safe(() => l.pointer!(ev, host.ctx), false);
  };

  const clearTimer = () => {
    if (press?.timer) {
      clearTimeout(press.timer);
      press.timer = null;
    }
  };

  const onDown = (e: PointerEvent) => {
    const p = local(e);
    pointers.set(e.pointerId, p);
    host.wake();
    if (pointers.size === 2) {
      // Second finger: the drag becomes a pinch.
      if (press) {
        clearTimer();
        to(press.layer, make('up', p.x, p.y, e));
        press = null;
      }
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), handled: false, level: false };
      return;
    }
    if (pointers.size > 2) return;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* not capturable */
    }
    const ev = make('down', p.x, p.y, e);
    press = { id: e.pointerId, x0: p.x, y0: p.y, moved: false, long: false, layer: offer(ev), timer: null, type: e.pointerType };
    const pr = press;
    pr.timer = setTimeout(() => {
      pr.timer = null;
      if (press !== pr || pr.moved) return;
      pr.long = true;
      offer(make('longpress', pr.x0, pr.y0, e));
      host.wake();
    }, LONG_PRESS_MS);
  };

  const onMove = (e: PointerEvent) => {
    const p = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const ratio = d / pinch.d;
      pinch.d = d;
      if (Math.abs(ratio - 1) < 1e-4) return;
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      // As a ctrl-wheel: deltaY·0.01 = −ln(ratio).
      const w = { x: cx, y: cy, deltaY: -Math.log(ratio) / 0.01, ctrlKey: true };
      const layers = host.layers();
      let handled = false;
      for (let i = layers.length - 1; i >= 0 && !handled; i--) {
        const l = layers[i];
        if (l.wheel && safe(() => l.wheel!(w, host.ctx), false)) handled = true;
      }
      if (!handled) {
        pinch.level = true;
        zoomBy(-Math.log2(ratio));
      }
      host.wake();
      return;
    }
    if (press && e.pointerId === press.id) {
      if (!press.moved) {
        const slop = press.type === 'touch' ? 8 : 4;
        if (Math.hypot(p.x - press.x0, p.y - press.y0) <= slop) return;
        press.moved = true;
        clearTimer();
      }
      to(press.layer, make('move', p.x, p.y, e));
      host.wake();
      return;
    }
    if (pointers.size === 0) {
      // Hover.
      if (offer(make('move', p.x, p.y, e)) === null) canvas.style.cursor = '';
      host.wake();
    }
  };

  const onUp = (e: PointerEvent, cancelled = false) => {
    const p = local(e);
    pointers.delete(e.pointerId);
    if (pinch) {
      if (pointers.size < 2) {
        if (app.zDragging) endZoomGesture();
        pinch = null;
      }
      host.wake();
      return;
    }
    if (!press || e.pointerId !== press.id) return;
    const pr = press;
    press = null;
    clearTimer();
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    if (!cancelled && !pr.moved && !pr.long) {
      offer(make('click', p.x, p.y, e));
      const now = performance.now();
      if (now - lastClick.t < DOUBLE_MS && Math.hypot(p.x - lastClick.x, p.y - lastClick.y) < DOUBLE_PX) {
        offer(make('dblclick', p.x, p.y, e));
        lastClick = { t: -Infinity, x: 0, y: 0 };
      } else lastClick = { t: now, x: p.x, y: p.y };
    }
    to(pr.layer, make('up', p.x, p.y, e));
    host.wake();
  };

  const onCancel = (e: PointerEvent) => onUp(e, true);

  const onLeave = (e: PointerEvent) => {
    if (pointers.size) return;
    const p = local(e);
    const ev = make('leave', p.x, p.y, e);
    for (const l of host.layers()) to(l, ev);
    host.wake();
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dy = e.deltaY * unit;
    if (!Number.isFinite(dy) || dy === 0) return;
    const p = local(e);
    const w = { x: p.x, y: p.y, deltaY: dy, ctrlKey: e.ctrlKey };
    const layers = host.layers();
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      if (l.wheel && safe(() => l.wheel!(w, host.ctx), false)) {
        host.wake();
        return;
      }
    }
    if (dy < 0 && app.z <= 0) return;
    zoomByWheel(dy * (e.ctrlKey ? 0.01 : 0.0025));
    host.wake();
  };

  const onContext = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const ev: ScenePointerEvent = { kind: 'contextmenu', x, y, world: host.ctx.screenToWorld(x, y), pointerType: 'mouse', shiftKey: e.shiftKey, button: e.button };
    if (offer(ev)) e.preventDefault();
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContext);
  return () => {
    clearTimer();
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onCancel);
    canvas.removeEventListener('pointerleave', onLeave);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('contextmenu', onContext);
  };
}
