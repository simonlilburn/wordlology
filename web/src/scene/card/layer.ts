// The card layer (Level 2): the focused card's face and density ghost, the
// Tree → Card stack of sampled target trees, and pointer input on cards. The
// atlas layer draws the other cells of the grid; the director (shared) owns
// the camera for z > 1.

import * as THREE from 'three';
import { app } from '../../app/store.svelte';
import { cells } from '../atlas/cells';
import { ensureTreeTarget, handleCardPointer } from '../atlas/interact';
import { lodFor, type Lod } from '../atlas/layout';
import { flushTick, watchVersion } from '../atlas/view.svelte';
import { RunWaker } from '../atlas/waker';
import type { FrameInfo, SceneContext, SceneLayer, ScenePointerEvent } from '../types';
import { director } from './director';
import { faces } from './face';
import { CardMeshes } from './meshes';
import { StackPlanes } from './stack';

export function createCardLayer(): SceneLayer {
  const root = new THREE.Group();
  root.name = 'card-layer';
  const meshes = new CardMeshes(20);
  const stack = new StackPlanes();
  root.add(stack.group, meshes.group);
  root.visible = false;
  let scene: THREE.Scene | null = null;
  let lod: Lod = 'full';
  let lastZ = NaN;
  const waker = new RunWaker();

  function hide(): void {
    root.visible = false;
    meshes.setAlpha(0, 0);
    stack.update(null);
  }

  return {
    name: 'card',

    update(f: FrameInfo, ctx: SceneContext): boolean {
      if (scene !== ctx.scene) {
        scene?.remove(root);
        scene = ctx.scene;
        scene.add(root);
      }
      const d = director.frame(f, ctx);
      let animating = d.animating;

      // Zooming in from the card with no focused target: the median-difficulty target.
      const z = d.z;
      const headingIn = app.zTarget < z || (Number.isFinite(lastZ) && z < lastZ);
      if (z > 1 && z < 1.97 && headingIn && app.focus.target < 0) ensureTreeTarget();
      lastZ = z;

      const cell = d.active ? cells.focus() : null;
      waker.wake = () => ctx.requestRender();
      waker.begin();
      if (!cell || !d.focusRect) {
        waker.end();
        hide();
        return flushTick(d.now) || animating;
      }
      cell.setPriority('focused');
      const rect = d.focusRect;
      const screenH = rect.h * d.scale;
      lod = lodFor(screenH, lod);
      const face = faces.get(cell);
      const fi = d.focusIdx;
      const selected = !!fi && app.atlas.selected.some(([c, r]) => c === fi[0] && r === fi[1]);
      const cardAlpha = d.cardAlpha;
      if (
        face.update({
          now: d.now,
          dt: f.dt,
          lod,
          devicePx: screenH * d.dpr,
          ghost: lod === 'full' && d.ghostAlpha > 0.01,
          fps: 60,
          reduced: d.reduced,
          selected,
          priority: true,
        })
      )
        animating = true;
      watchVersion(cell, cell.version);
      waker.watch(cell.run);
      waker.end();
      if (cell.run && cell.run.version !== cell.seenRunVersion) animating = true;
      meshes.bind(face);
      meshes.place(d, rect, 0);
      meshes.setAlpha(cardAlpha, lod === 'full' ? d.ghostAlpha : 0);
      stack.update(cell);
      root.visible = true;
      if (flushTick(d.now)) animating = true;
      return animating;
    },

    pointer(e: ScenePointerEvent): boolean {
      try {
        return handleCardPointer(e);
      } catch (err) {
        console.warn('[card]', err);
        return false;
      }
    },

    resize(): void {
      lod = 'full';
    },

    dispose(): void {
      waker.dispose();
      scene?.remove(root);
      scene = null;
      meshes.dispose();
      stack.dispose();
    },
  };
}
