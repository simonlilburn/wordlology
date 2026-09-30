// The atlas layer (Level 3): every cell of the strategy × opener grid except
// the focused one (the card layer draws that), shrinking to chips as the grid
// zooms out. Cells request their runs with a priority from what is on screen,
// and keep polling off screen (throttled) so margins, tables and sorting stay
// current. Zooming out past the atlas fit shrinks the grid further.

import * as THREE from 'three';
import { app } from '../../app/store.svelte';
import { director } from '../card/director';
import { faces } from '../card/face';
import { CardMeshes } from '../card/meshes';
import type { FrameInfo, SceneContext, SceneLayer } from '../types';
import { cells, gridAxes, type Cell } from './cells';
import { cellRect, lodFor, rectVisible, type Lod } from './layout';
import { flushTick, watchVersion } from './view.svelte';
import { RunWaker } from './waker';

/** How far the grid may shrink beyond the atlas fit (wheel/pinch past z = 3). */
export const MIN_EXTRA = 0.4;
/** Off-screen cells poll their runs this often. */
const OFFSCREEN_POLL_MS = 250;
/** Meshes of cells off screen this long are released. */
const RELEASE_MS = 5000;

interface Slot {
  meshes: CardMeshes;
  lod: Lod;
  lastSeen: number;
}

/** Next extra-zoom factor for a wheel step at the atlas (null = let the zoom controller have it). */
export function extraZoomStep(extra: number, deltaY: number): number | null {
  if (deltaY > 0) return Math.max(MIN_EXTRA, extra * Math.exp(-deltaY * 0.0015));
  if (deltaY < 0 && extra < 1) return Math.min(1, extra * Math.exp(-deltaY * 0.0015));
  return null;
}

export function createAtlasLayer(): SceneLayer {
  const root = new THREE.Group();
  root.name = 'atlas-layer';
  root.visible = false;
  const slots = new Map<Cell, Slot>();
  const lastPoll = new WeakMap<Cell, number>();
  let scene: THREE.Scene | null = null;
  let lastPrune = 0;
  const waker = new RunWaker();

  function release(cell: Cell, slot: Slot): void {
    root.remove(slot.meshes.group);
    slot.meshes.dispose();
    slots.delete(cell);
  }

  return {
    name: 'atlas',

    update(f: FrameInfo, ctx: SceneContext): boolean {
      if (scene !== ctx.scene) {
        scene?.remove(root);
        scene = ctx.scene;
        scene.add(root);
      }
      const d = director.frame(f, ctx);
      let animating = d.animating;
      const now = d.now;
      if (d.z < 2.9 && d.extra !== 1) d.extra = 1;
      waker.wake = () => ctx.requestRender();
      waker.begin();

      const focusCell = cells.focus();
      if (!d.active) {
        // Out of the card/atlas levels: runs keep computing in the background.
        for (const c of cells.all()) if (c !== focusCell) c.setPriority('background');
        for (const s of slots.values()) s.meshes.setAlpha(0, 0);
        root.visible = false;
        waker.end();
        return animating;
      }

      const { columns, rows } = gridAxes();
      const alpha = d.reduced ? d.rmCard : d.atlas.neighbourAlpha;
      const inGrid = new Set<Cell>();
      const keep = new Set<string>();
      if (focusCell) keep.add(focusCell.key);
      const fi = d.focusIdx;
      const sel = app.atlas.selected;
      let any = false;
      for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < columns.length; c++) {
          const cell = cells.get(columns[c], rows[r]);
          keep.add(cell.key);
          if (fi && fi[0] === c && fi[1] === r) continue;
          inGrid.add(cell);
          const rect = cellRect(d.layout, c, r);
          const onScreen = rectVisible(rect, d.view, d.vp, 24);
          const visible = onScreen && alpha > 0.003;
          cell.setPriority(onScreen && d.z > 1.85 ? 'visible' : 'background');
          let slot = slots.get(cell);
          if (visible) {
            if (!slot) {
              slot = { meshes: new CardMeshes(10), lod: 'full', lastSeen: now };
              slots.set(cell, slot);
              root.add(slot.meshes.group);
            }
            slot.lastSeen = now;
            const screenH = rect.h * d.scale;
            slot.lod = lodFor(screenH, slot.lod);
            const face = faces.get(cell);
            const selected = sel.some(([a, b]) => a === c && b === r);
            if (
              face.update({
                now,
                dt: f.dt,
                lod: slot.lod,
                devicePx: screenH * d.dpr,
                ghost: slot.lod === 'full',
                fps: slot.lod === 'full' ? 30 : 15,
                reduced: d.reduced,
                selected,
              })
            )
              animating = true;
            slot.meshes.bind(face);
            slot.meshes.place(d, rect, 0);
            slot.meshes.setAlpha(alpha, slot.lod === 'full' ? alpha : 0);
            any = true;
          } else {
            slot?.meshes.setAlpha(0, 0);
            const last = lastPoll.get(cell) ?? -Infinity;
            if (now - last >= OFFSCREEN_POLL_MS) {
              lastPoll.set(cell, now);
              cell.poll(now);
            }
          }
          watchVersion(cell, cell.version);
          // New games arrive → wake the scene; a throttled poll still owed → keep rendering.
          waker.watch(cell.run);
          if (cell.run && cell.run.version !== cell.seenRunVersion) animating = true;
        }
      }
      for (const [cell, slot] of slots) {
        if (!inGrid.has(cell) || now - slot.lastSeen > RELEASE_MS) release(cell, slot);
      }
      waker.end();
      root.visible = any;
      if (now - lastPrune > 2000) {
        lastPrune = now;
        cells.prune(keep, now);
        faces.prune(now);
      }
      if (flushTick(now)) animating = true;
      return animating;
    },

    wheel(e, ctx): boolean {
      const d = director;
      if (!d.active || app.z < 2.98) return false;
      const next = extraZoomStep(d.extra, e.deltaY);
      if (next === null) return false;
      if (next !== d.extra) {
        d.extra = next;
        ctx.requestRender();
      }
      return true;
    },

    dispose(): void {
      waker.dispose();
      for (const [cell, slot] of [...slots]) release(cell, slot);
      scene?.remove(root);
      scene = null;
    },
  };
}
