// The three.js scene: one WebGL canvas, an orthographic camera (1 world unit
// = 1 CSS px at scale 1) and a perspective camera for transitions, with the
// level renderers plugged in as layers (tree, card, atlas). Plain TypeScript,
// mounted once by SceneCanvas.svelte. It reads the shared store on each
// animation frame and renders on demand: a frame is drawn only when the
// store changed, input arrived, the canvas resized or a layer is animating;
// idle, the requestAnimationFrame loop stops.

import * as THREE from 'three';
import { app } from '../app/store.svelte';
import { onFocusChange } from '../model/focus';
import { paneState } from '../panes/state.svelte';
import { createAtlasLayer } from './atlas/index';
import { createCardLayer } from './card/index';
import { attachInput } from './core/input';
import { invalidatePalette, palette, setPaletteProbe } from './core/palette';
import { watchStore } from './core/watch.svelte';
import { createTreeLayer } from './tree/layer';
import type { FrameInfo, SceneApi, SceneContext, SceneLayer } from './types';

const MAX_DPR = 2;

let current: SceneApi | null = null;

/** The mounted scene, if any (for code outside the scene that needs to request a frame). */
export function sceneApi(): SceneApi | null {
  return current;
}

function coveredViewport(W: number, H: number, sidePane: Element | null): SceneContext['viewport'] {
  const occ = paneState.occluded;
  let top = Math.max(0, occ.top || 0);
  let right = Math.max(0, occ.right || 0);
  let bottom = Math.max(0, occ.bottom || 0);
  if (!right && !bottom && sidePane) {
    const covers = sidePane.getAttribute('data-covers');
    if (covers === 'right' || covers === 'bottom') {
      const r = sidePane.getBoundingClientRect();
      if (covers === 'right') right = Math.max(0, W - r.left);
      else bottom = Math.max(0, H - r.top);
    }
  }
  top = Math.min(top, H * 0.5);
  right = Math.min(right, W * 0.7);
  bottom = Math.min(bottom, H * 0.8);
  return { left: 0, top, width: Math.max(1, W - right), height: Math.max(1, H - top - bottom) };
}

export function createScene(canvas: HTMLCanvasElement): SceneApi {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  const scene = new THREE.Scene();
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -2000, 2000);
  ortho.position.set(0, 0, 100);
  const persp = new THREE.PerspectiveCamera(35, 1, 1, 20000);
  persp.position.set(0, 0, 1000);
  setPaletteProbe(canvas);

  let W = 1;
  let H = 1;
  let dpr = 1;
  const layers: SceneLayer[] = [];
  let raf = 0;
  let disposed = false;
  let startTime = -1;
  let lastTime = -1;
  let idle = true;
  const errors = new WeakSet<SceneLayer>();
  const v = new THREE.Vector3();
  const clear = new THREE.Color();
  let sidePane: Element | null = null;

  const ctx: SceneContext = {
    renderer,
    scene,
    ortho,
    persp,
    camera: 'ortho',
    viewport: { left: 0, top: 0, width: 1, height: 1 },
    requestRender,
    screenToWorld(x: number, y: number) {
      v.set((x / W) * 2 - 1, 1 - (y / H) * 2, 0).unproject(ortho);
      return { x: v.x, y: v.y };
    },
    worldToScreen(x: number, y: number) {
      v.set(x, y, 0).project(ortho);
      return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H };
    },
  };

  function info(t: number, dt: number): FrameInfo {
    return { time: t, dt, z: app.z, width: W, height: H, dpr, reducedMotion: app.reducedMotion };
  }

  function resize(): boolean {
    const w = Math.max(1, canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, canvas.clientHeight || window.innerHeight);
    const d = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    if (w === W && h === H && d === dpr) return false;
    W = w;
    H = h;
    dpr = d;
    renderer.setPixelRatio(dpr);
    renderer.setSize(W, H, false);
    ortho.left = -W / 2;
    ortho.right = W / 2;
    ortho.top = H / 2;
    ortho.bottom = -H / 2;
    ortho.updateProjectionMatrix();
    persp.aspect = W / H;
    persp.updateProjectionMatrix();
    return true;
  }

  function frame(now: number): void {
    raf = 0;
    if (disposed) return;
    if (startTime < 0) startTime = now;
    const t = now - startTime;
    const dt = idle || lastTime < 0 ? 16 : Math.min(100, Math.max(0, t - lastTime));
    lastTime = t;
    idle = false;
    const resized = resize();
    if (!sidePane || !sidePane.isConnected) sidePane = document.querySelector('[data-side-pane]');
    ctx.viewport = coveredViewport(W, H, sidePane);
    const f = info(t, dt);
    if (resized) for (const l of layers) if (l.resize) guard(l, () => l.resize!(f, ctx));
    let animating = false;
    for (const l of layers) {
      guard(l, () => {
        if (l.update(f, ctx)) animating = true;
      });
    }
    const pal = palette();
    // Palette colours are sRGB (CSS); three.js colours are linear unless told otherwise.
    renderer.setClearColor(clear.setRGB(pal.bg[0], pal.bg[1], pal.bg[2], THREE.SRGBColorSpace), 1);
    renderer.render(scene, ctx.camera === 'persp' ? persp : ortho);
    if (animating) schedule();
    else idle = true;
  }

  function guard(l: SceneLayer, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      if (!errors.has(l)) {
        errors.add(l);
        console.error(`[scene] layer "${l.name}" failed`, e);
      }
    }
  }

  function schedule(): void {
    if (raf || disposed) return;
    raf = requestAnimationFrame(frame);
  }

  function requestRender(): void {
    schedule();
  }

  function addLayer(l: SceneLayer): void {
    if (!layers.includes(l)) layers.push(l);
    requestRender();
  }

  function removeLayer(l: SceneLayer): void {
    const i = layers.indexOf(l);
    if (i >= 0) layers.splice(i, 1);
    guard(l, () => l.dispose());
    requestRender();
  }

  // Wake-ups: store changes, focus data, resize, colour scheme, input.
  const unwatch = watchStore(requestRender);
  const unfocus = onFocusChange(requestRender);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => requestRender()) : null;
  ro?.observe(canvas);
  const onResize = () => requestRender();
  window.addEventListener('resize', onResize);
  const mq = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null;
  const onScheme = () => {
    invalidatePalette();
    requestRender();
  };
  mq?.addEventListener?.('change', onScheme);
  const detach = attachInput(canvas, { layers: () => layers, ctx, wake: requestRender });
  const onLost = (e: Event) => e.preventDefault();
  const onRestored = () => requestRender();
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  resize();
  addLayer(createTreeLayer());
  for (const make of [createCardLayer, createAtlasLayer]) {
    try {
      addLayer(make());
    } catch (e) {
      console.error('[scene] could not create a layer', e);
    }
  }

  const api: SceneApi = {
    addLayer,
    removeLayer,
    requestRender,
    ctx,
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      unwatch();
      unfocus();
      ro?.disconnect();
      window.removeEventListener('resize', onResize);
      mq?.removeEventListener?.('change', onScheme);
      detach();
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      for (const l of [...layers]) guard(l, () => l.dispose());
      layers.length = 0;
      renderer.dispose();
      if (current === api) current = null;
    },
  };
  current = api;
  requestRender();
  return api;
}
