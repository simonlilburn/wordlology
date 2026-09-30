// Scene contracts. The scene is a plain TypeScript module mounted once on a
// single canvas; it reads the shared store every animation frame and renders
// on demand. Level renderers plug in as layers.

import type * as THREE from 'three';

export interface FrameInfo {
  /** ms since scene start. */
  time: number;
  /** ms since the previous frame (clamped to 100). */
  dt: number;
  /** Current continuous zoom value: 0 Game, 1 Tree, 2 Card, 3 Atlas. */
  z: number;
  /** Canvas size in CSS pixels. */
  width: number;
  height: number;
  dpr: number;
  reducedMotion: boolean;
}

export interface SceneContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  /** Main camera: orthographic, 1 world unit = 1 CSS pixel at view scale 1. */
  ortho: THREE.OrthographicCamera;
  /** Used during transitions and in the target browser. */
  persp: THREE.PerspectiveCamera;
  /** Which camera renders this frame; transitions may switch it. */
  camera: 'ortho' | 'persp';
  /** The visible region of the canvas not covered by panes, in CSS pixels. */
  viewport: { left: number; top: number; width: number; height: number };
  /** Ask for another frame (the scene renders on demand). */
  requestRender(): void;
  /** Convert a CSS-pixel point on the canvas to world coordinates of the ortho camera. */
  screenToWorld(x: number, y: number): { x: number; y: number };
  worldToScreen(x: number, y: number): { x: number; y: number };
}

export interface ScenePointerEvent {
  kind: 'down' | 'move' | 'up' | 'click' | 'dblclick' | 'longpress' | 'contextmenu' | 'leave';
  /** CSS pixels relative to the canvas. */
  x: number;
  y: number;
  world: { x: number; y: number };
  pointerType: string;
  shiftKey: boolean;
  button: number;
}

export interface SceneLayer {
  name: string;
  /** Called every frame while the scene is awake. Return true while animating (requests another frame). */
  update(frame: FrameInfo, ctx: SceneContext): boolean;
  /** Pointer input; return true if handled (stops other layers and panning). */
  pointer?(e: ScenePointerEvent, ctx: SceneContext): boolean;
  /** Wheel/pinch handled by the layer instead of the zoom controller (return true if handled). */
  wheel?(e: { x: number; y: number; deltaY: number; ctrlKey: boolean }, ctx: SceneContext): boolean;
  /** Canvas resized. */
  resize?(frame: FrameInfo, ctx: SceneContext): void;
  dispose(): void;
}

export interface SceneApi {
  addLayer(layer: SceneLayer): void;
  removeLayer(layer: SceneLayer): void;
  requestRender(): void;
  ctx: SceneContext;
  dispose(): void;
}
