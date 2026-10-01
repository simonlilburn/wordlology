// The director: one per-frame controller shared by the card and atlas layers.
// It owns the camera for z > 1 (ortho, switching to perspective during the
// Tree → Card tilt), places the grid in world space so the focused card starts
// where the tree layer draws the focused tree, and publishes the layout →
// screen transform for the DOM overlays. Everything derives from the
// continuous z, so transitions reverse and can be interrupted.

import { app } from '../../app/store.svelte';
import { treeBounds } from '../tree/bounds';
import { DEFAULT_LAYOUT } from '../tree/layout';
import type { FrameInfo, SceneContext } from '../types';
import { atlasNeedsSeed, focusCellIndex, gridAxes, seedAtlas } from '../atlas/cells';
import {
  cardView,
  cellRect,
  fitView,
  gridLayout,
  lerpView,
  screenToLayout,
  viewTransform,
  type GridLayout,
  type Margins,
  type Rect,
  type View,
  type Viewport,
} from '../atlas/layout';
import { cardUi, publish, sceneView } from '../atlas/view.svelte';
import { atlasFrame, dipLevel, dipStep, STACK_PLANES, stackFrame, type AtlasFrame, type DipState, type StackFrame } from './choreo';
import { FACE } from './draw';
import { springStep } from './spring';

/** Screen margins kept free for the DOM headers in the Atlas view. */
export const ATLAS_MARGINS: Margins = { left: 156, right: 28, top: 84, bottom: 64 };
export const PLANE_SPACING = 22;
const PERSP_FOV = 35;

interface TreeCam {
  wx: number;
  wy: number;
  scale: number;
}

class Director {
  private time = -1;
  /** performance.now() at the start of this frame (shared clock with overlays). */
  now = 0;
  frameId = 0;
  z = 0;
  reduced = false;
  /** +1 when world y points up on screen, −1 when down. */
  yUp: 1 | -1 = 1;
  vp: Viewport = { left: 0, top: 0, width: 1, height: 1 };
  width = 1;
  height = 1;
  dpr = 1;
  /** Content for z > 1 is on screen. */
  active = false;
  layout: GridLayout = gridLayout(1, 1);
  focusIdx: [number, number] | null = null;
  focusRect: Rect | null = null;
  grid = false;
  view: View = { cx: 0, cy: 0, scale: 1 };
  stack: StackFrame | null = null;
  atlas: AtlasFrame = atlasFrame(0);
  /** Reduced-motion cross-fades (0..1) for the card and the atlas. */
  rmCard = 0;
  rmAtlas = 0;
  /** Reduced motion: the level whose view is shown and its opacity. */
  dip: DipState = { level: 1, alpha: 0 };
  /** Layout → world: wx = offset.x + x·k, wy = offset.y − y·k·yUp. */
  offset = { x: 0, y: 0 };
  /**
   * World units per layout unit, chosen so the card's rows line up with the
   * tree's row bands (the tree layer draws band k from y = −(k − 1)·bandHeight).
   */
  k = 1;
  /** Extra zoom-out beyond the atlas fit (cards shrink to chips). */
  extra = 1;
  animating = false;
  private offsetKey = '';
  private offsetInit = false;
  private treeCam: TreeCam | null = null;
  private glide = { x: 0, y: 0, vx: 0, vy: 0, init: false };
  private inset = { x: 0, v: 0 };
  private above1 = false;
  ctx: SceneContext | null = null;

  frame(f: FrameInfo, ctx: SceneContext): Director {
    if (f.time === this.time && this.ctx === ctx) return this;
    this.time = f.time;
    this.now = performance.now();
    this.frameId++;
    this.ctx = ctx;
    this.animating = false;
    this.z = Number.isFinite(f.z) ? f.z : app.z;
    this.reduced = f.reducedMotion || app.reducedMotion;
    this.width = Math.max(1, f.width);
    this.height = Math.max(1, f.height);
    this.dpr = f.dpr || 1;
    const vp = ctx.viewport;
    this.vp = vp && vp.width > 10 && vp.height > 10 ? { ...vp } : { left: 0, top: 0, width: this.width, height: this.height };
    // A side panel (compare) at the left: the view slides over to stay beside it.
    const wantInset = f.z > 1 && this.vp.width - cardUi.insetLeft >= 360 ? Math.max(0, cardUi.insetLeft) : 0;
    const I = this.inset;
    if (this.reduced || f.z <= 1) {
      I.x = wantInset;
      I.v = 0;
    } else {
      [I.x, I.v] = springStep(I.x, I.v, wantInset, f.dt / 1000, 14);
      if (Math.abs(I.x - wantInset) < 0.5) {
        I.x = wantInset;
        I.v = 0;
      } else this.animating = true;
    }
    if (I.x > 0) {
      this.vp.left += I.x;
      this.vp.width -= I.x;
    }
    this.yUp = ctx.ortho.top >= ctx.ortho.bottom ? 1 : -1;
    const z = this.z;

    // Reduced motion: a dip cross-fade (≤ 200 ms) toward the nearest level;
    // the view switches only while the content is invisible.
    if (this.reduced) {
      const next = dipStep(this.dip, dipLevel(z), f.dt);
      if (next.level !== this.dip.level || next.alpha !== this.dip.alpha) this.animating = true;
      this.dip = next;
    } else {
      this.dip = { level: dipLevel(z), alpha: 1 };
    }
    this.rmCard = this.dip.level >= 2 ? this.dip.alpha : 0;
    this.rmAtlas = this.dip.level === 3 ? this.dip.alpha : 0;

    if (z <= 1) {
      this.captureTreeCam(ctx);
      if (this.above1) {
        this.above1 = false;
        ctx.camera = 'ortho';
      }
    }

    // Keep the focused card in the grid once the atlas exists; seed it when first shown.
    if (z > 1.5 && app.focus.strategy && atlasNeedsSeed()) {
      const hasAtlas = app.atlas.columns.length > 0 || app.atlas.rows.length > 0;
      if (hasAtlas || z >= 2.5) seedAtlas();
    }

    const { columns, rows } = gridAxes();
    this.layout = gridLayout(columns.length, rows.length);
    this.grid = columns.length * rows.length >= 2;
    this.k = rowsScale(app.result.maxGuesses);
    this.focusIdx = focusCellIndex() ?? (app.focus.strategy ? [0, 0] : null);
    this.focusRect = this.focusIdx ? cellRect(this.layout, this.focusIdx[0], this.focusIdx[1]) : null;
    const fadeActive = this.reduced ? this.rmCard > 0 : z > 1.001;
    this.active = !!this.focusRect && (z > 1.001 || fadeActive) && !!app.focus.strategy;

    this.updateOffset(z);
    if (!this.active || !this.focusRect) {
      this.stack = null;
      this.publishView(false);
      return this;
    }
    this.above1 = true;

    // Glide the camera between cells when the focus changes at card/atlas zoom.
    const fr = this.focusRect;
    const gx = fr.x + fr.w / 2, gy = fr.y + fr.h / 2;
    const G = this.glide;
    if (!G.init || z < 1.95 || this.reduced) {
      G.x = gx;
      G.y = gy;
      G.vx = G.vy = 0;
      G.init = true;
    } else {
      [G.x, G.vx] = springStep(G.x, G.vx, gx, f.dt / 1000, 12);
      [G.y, G.vy] = springStep(G.y, G.vy, gy, f.dt / 1000, 12);
      if (Math.abs(G.x - gx) > 0.1 || Math.abs(G.y - gy) > 0.1) this.animating = true;
      else {
        G.x = gx;
        G.y = gy;
      }
    }
    const cardV = cardView({ x: G.x - fr.w / 2, y: G.y - fr.h / 2, w: fr.w, h: fr.h }, this.vp);
    let atlasV = fitView(this.layout.bounds, this.vp, ATLAS_MARGINS, cardV.scale);
    if (this.extra < 1) atlasV = { ...atlasV, scale: atlasV.scale * this.extra };
    const treeV = this.treeView() ?? cardV;

    if (this.reduced) {
      this.stack = null;
      const lvl = this.dip.level;
      this.view = lvl === 1 ? treeV : lvl === 2 ? cardV : atlasV;
      this.atlas = { viewT: lvl === 3 ? 1 : 0, neighbourAlpha: this.rmCard, dashedAlpha: this.rmCard, headerAlpha: this.rmAtlas };
    } else if (z < 2) {
      const s = stackFrame(z - 1);
      this.stack = s;
      const v = lerpView(treeV, cardV, s.viewT);
      this.view = { ...v, scale: v.scale * s.pull };
      this.atlas = atlasFrame(z);
    } else {
      this.stack = null;
      this.atlas = atlasFrame(z);
      this.view = lerpView(cardV, atlasV, this.atlas.viewT);
    }
    this.applyCamera(ctx);
    this.publishView(true);
    return this;
  }

  /** Card opacity: the Tree → Card fade (or the reduced-motion cross-fade). */
  get cardAlpha(): number {
    if (this.reduced) return this.rmCard;
    return this.stack ? this.stack.faceAlpha : this.z > 1 ? 1 : 0;
  }

  get ghostAlpha(): number {
    if (this.reduced) return this.rmCard;
    return this.stack ? this.stack.ghostAlpha : this.z > 1 ? 1 : 0;
  }

  layoutToWorld(x: number, y: number): { x: number; y: number } {
    return { x: this.offset.x + x * this.k, y: this.offset.y - y * this.k * this.yUp };
  }

  worldToLayout(x: number, y: number): { x: number; y: number } {
    return { x: (x - this.offset.x) / this.k, y: ((this.offset.y - y) * this.yUp) / this.k };
  }

  screenToLayout(sx: number, sy: number): { x: number; y: number } {
    return screenToLayout(this.view, this.vp, sx, sy);
  }

  /** CSS px per layout unit on screen. */
  get scale(): number {
    return this.view.scale;
  }

  private captureTreeCam(ctx: SceneContext): void {
    if (ctx.camera !== 'ortho') return;
    const o = ctx.ortho;
    const W = this.width, H = this.height;
    const span = o.right - o.left;
    if (!(span !== 0 && o.zoom > 0)) return;
    const scale = (o.zoom * W) / Math.abs(span);
    const dx = (o.right - o.left) / (2 * o.zoom), dy = (o.top - o.bottom) / (2 * o.zoom);
    const cxF = (o.left + o.right) / 2, cyF = (o.top + o.bottom) / 2;
    const vx = this.vp.left + this.vp.width / 2, vy = this.vp.top + this.vp.height / 2;
    this.treeCam = {
      wx: o.position.x + cxF + dx * ((2 * vx) / W - 1),
      wy: o.position.y + cyF + dy * (1 - (2 * vy) / H),
      scale,
    };
  }

  private treeView(): View | null {
    const t = this.treeCam;
    if (!t) return null;
    const l = this.worldToLayout(t.wx, t.wy);
    return { cx: l.x, cy: l.y, scale: t.scale * this.k };
  }

  /**
   * Where the focused card goes in world space: its centre on the tree's trunk
   * (x = 0 in the tree layout, or the centre of treeBounds() when the tree is
   * drawn elsewhere) and its first row on the tree's first guess band (y = 0).
   */
  private treeAnchor(): { x: number; top: number | null; cy: number } {
    let b: ReturnType<typeof treeBounds> = null;
    try {
      b = treeBounds();
    } catch {
      b = null;
    }
    if (b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width > 0 && b.height > 0) {
      const containsX = b.x <= 0 && b.x + b.width >= 0;
      const containsY = b.y <= 0 && b.y + b.height >= 0;
      if (containsX && containsY) return { x: 0, top: 0, cy: 0 };
      return { x: b.x + b.width / 2, top: null, cy: b.y + b.height / 2 };
    }
    return { x: 0, top: 0, cy: 0 };
  }

  /**
   * Place the grid so the focused cell sits on the focused tree. The camera
   * follows layout coordinates, so moving the grid in world space changes
   * nothing on screen while the tree is invisible (z ≥ 1.8): the offset then
   * tracks the focus (a cell focused in the atlas zooms back into its tree).
   * While the tree shows (1.02 < z < 1.8) it stays put, so nothing jumps.
   */
  private updateOffset(z: number): void {
    const fr = this.focusRect;
    if (!fr) return;
    const key = `${this.focusIdx?.join(',')}|${this.layout.cols}x${this.layout.rows}|${this.k}`;
    const treeHidden = z >= 1.8 || (this.reduced && this.dip.level >= 2);
    if (!this.offsetInit || z <= 1.02 || treeHidden) {
      const T = this.treeAnchor();
      const k = this.k;
      const x = T.x - (fr.x + fr.w / 2) * k;
      const y =
        T.top !== null
          ? T.top + (fr.y + FACE.rowsTop) * k * this.yUp
          : T.cy + (fr.y + fr.h / 2) * k * this.yUp;
      this.offset = { x, y };
      this.offsetKey = key;
      this.offsetInit = true;
    }
  }

  private applyCamera(ctx: SceneContext): void {
    const v = this.view;
    const W = this.width, H = this.height;
    const vx = this.vp.left + this.vp.width / 2, vy = this.vp.top + this.vp.height / 2;
    const s = this.stack;
    /** CSS px per world unit. */
    const ws = v.scale / this.k;
    if (s && s.persp) {
      const p = ctx.persp;
      const fovRad = (PERSP_FOV * Math.PI) / 180;
      const D = H / (ws * 2 * Math.tan(fovRad / 2));
      // The layout point at the canvas centre (the perspective camera looks at the canvas centre).
      const lx = v.cx + (W / 2 - vx) / v.scale, ly = v.cy + (H / 2 - vy) / v.scale;
      const T = this.layoutToWorld(lx, ly);
      const zMid = s.spread * STACK_PLANES * PLANE_SPACING * 0.45;
      const yaw = s.tilt, pitch = s.tilt * 0.35;
      const r = D + zMid;
      p.fov = PERSP_FOV;
      p.aspect = W / H;
      p.near = Math.max(0.5, D * 0.02);
      p.far = D + zMid * 2 + STACK_PLANES * PLANE_SPACING * 4 + 4000;
      p.up.set(0, this.yUp, 0);
      p.position.set(
        T.x + r * Math.sin(yaw) * Math.cos(pitch),
        T.y + r * Math.sin(pitch) * this.yUp,
        -zMid + r * Math.cos(yaw) * Math.cos(pitch),
      );
      p.lookAt(T.x, T.y, -zMid);
      p.updateProjectionMatrix();
      p.updateMatrixWorld();
      ctx.camera = 'persp';
      return;
    }
    const o = ctx.ortho;
    const span = o.right - o.left;
    if (span === 0) return;
    const zoom = (ws * Math.abs(span)) / W;
    const c = this.layoutToWorld(v.cx, v.cy);
    const cxF = (o.left + o.right) / 2, cyF = (o.top + o.bottom) / 2;
    const dx = (o.right - o.left) / (2 * zoom), dy = (o.top - o.bottom) / (2 * zoom);
    o.zoom = zoom;
    o.position.x = c.x - cxF - dx * ((2 * vx) / W - 1);
    o.position.y = c.y - cyF - dy * (1 - (2 * vy) / H);
    o.rotation.set(0, 0, 0);
    o.updateProjectionMatrix();
    o.updateMatrixWorld();
    ctx.camera = 'ortho';
  }

  private publishView(visible: boolean): void {
    publish('visible', visible);
    publish('z', Math.round(this.z * 1000) / 1000);
    const vp = this.vp;
    publish('vp', { left: Math.round(vp.left), top: Math.round(vp.top), width: Math.round(vp.width), height: Math.round(vp.height) });
    if (!visible) {
      publish('cardAlpha', 0);
      publish('headerAlpha', 0);
      publish('dashedAlpha', 0);
      return;
    }
    const t = viewTransform(this.view, this.vp);
    publish('tx', t.tx);
    publish('ty', t.ty);
    publish('s', t.s);
    publish('cols', this.layout.cols);
    publish('rows', this.layout.rows);
    publish('grid', this.grid);
    publish('focus', this.focusIdx);
    publish('cardAlpha', this.cardAlpha);
    publish('headerAlpha', this.reduced ? this.rmAtlas : this.atlas.headerAlpha);
    publish('dashedAlpha', this.atlas.dashedAlpha);
    const settled = [2, 3].some((l) => Math.abs(this.z - l) < 0.01);
    publish('transitioning', !settled);
    void sceneView;
  }
}

/** World units per layout unit that make the card's rows as tall as the tree's bands. */
export function rowsScale(maxGuesses: number): number {
  const band = DEFAULT_LAYOUT?.bandHeight ?? 72;
  const rows = Math.max(1, maxGuesses) + 1;
  return (rows * band) / (FACE.rowsBottom - FACE.rowsTop);
}

export const director = new Director();

// Dev builds: a read-only handle for end-to-end checks of the transitions.
if (import.meta.env?.DEV && typeof window !== 'undefined') {
  (window as unknown as { __wordlologyDirector?: Director }).__wordlologyDirector = director;
}
