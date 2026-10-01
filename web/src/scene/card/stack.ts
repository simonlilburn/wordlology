// The Tree → Card stack: about 24 sampled target trees from the card's run,
// drawn as simplified trees (paths, no words) on translucent planes that slide
// in behind the current tree, spread in depth while the camera tilts, then
// superimpose as the camera returns face-on. They use the ghost's path layout,
// so superimposed they add up to the density ghost that fades in after them.

import * as THREE from 'three';
import type { Game } from '../../backend/types';
import { app } from '../../app/store.svelte';
import type { Cell } from '../atlas/cells';
import { CARD_H, CARD_W } from '../atlas/layout';
import { planeSlide, STACK_PLANES } from './choreo';
import { director, PLANE_SPACING } from './director';
import { FACE } from './draw';
import { GHOST_RECT } from './face';
import { pathXs } from './ghost';
import { cardTheme, prefersDark, rgbCss } from './ramp';

const TEX_W = 180, TEX_H = 240;
const plane = new THREE.PlaneGeometry(1, 1);

interface Plane {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  tex: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  target: number;
}

/** Up to `n` targets (other than `exclude`) with their games, in arrival order. */
export function sampleTargets(games: Game[], n: number, exclude: number, perTarget = 40): Map<number, Game[]> {
  const out = new Map<number, Game[]>();
  for (const g of games) {
    if (g.isPlayer || g.target === exclude) continue;
    let list = out.get(g.target);
    if (!list) {
      if (out.size >= n) continue;
      list = [];
      out.set(g.target, list);
    }
    if (list.length < perTarget) list.push(g);
  }
  return out;
}

export class StackPlanes {
  group = new THREE.Group();
  private planes: Plane[] = [];
  private builtKey = '';

  constructor() {
    this.group.name = 'card-stack';
    this.group.visible = false;
  }

  private ensurePlanes(): void {
    if (this.planes.length) return;
    for (let i = 0; i < STACK_PLANES; i++) {
      const canvas = document.createElement('canvas');
      canvas.width = TEX_W;
      canvas.height = TEX_H;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter;
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        toneMapped: false,
        opacity: 0,
      });
      const mesh = new THREE.Mesh(plane, mat);
      mesh.renderOrder = 2 + (STACK_PLANES - i) * 0.01;
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.group.add(mesh);
      this.planes.push({ mesh, mat, tex, canvas, target: -1 });
    }
  }

  /** Draw the sampled trees for `cell` if needed (only near z = 1 so planes never pop mid-flight). */
  private build(cell: Cell): number {
    const run = cell.run;
    if (!run) return 0;
    const n = this.planes.length;
    const key = `${cell.key}|${cell.configJson.length}|${app.focus.target}|${Math.min(run.games.length, 5000) > 0 ? Math.floor(Math.log2(run.games.length + 1)) : 0}`;
    const canRebuild = director.z < 1.08 || this.builtKey === '';
    if (key === this.builtKey || !canRebuild) return this.planes.filter((p) => p.target >= 0).length;
    this.builtKey = key;
    const sample = sampleTargets(run.games, n, app.focus.target);
    const theme = cardTheme(prefersDark());
    const maxG = cell.maxGuesses;
    const L = app.words?.wordLength ?? 5;
    const nRows = maxG + 1;
    const targets = [...sample.keys()];
    const kx = TEX_W / CARD_W, ky = TEX_H / CARD_H;
    const gx0 = GHOST_RECT.x * kx, gw = GHOST_RECT.w * kx;
    const gy0 = FACE.rowsTop * ky, gh = (FACE.rowsBottom - FACE.rowsTop) * ky;
    for (let i = 0; i < n; i++) {
      const p = this.planes[i];
      const t = targets[i];
      p.target = t ?? -1;
      const g = p.canvas.getContext('2d');
      if (!g) continue;
      g.clearRect(0, 0, TEX_W, TEX_H);
      if (t === undefined) {
        p.tex.needsUpdate = true;
        continue;
      }
      // A transparency: faint sheet, frame and row rules.
      g.fillStyle = rgbCss(theme.paper, 0.2);
      g.fillRect(0, 0, TEX_W, TEX_H);
      g.strokeStyle = rgbCss(theme.ink, 0.35);
      g.lineWidth = 1;
      g.strokeRect(0.5, 0.5, TEX_W - 1, TEX_H - 1);
      g.fillStyle = rgbCss(theme.ink, 0.12);
      for (let r = 0; r <= nRows; r++) g.fillRect(0, gy0 + (r * gh) / nRows, TEX_W, 0.6);
      // The target's games as rivers: overlapping paths build up where games agree.
      const games = sample.get(t)!;
      g.strokeStyle = rgbCss(theme.ink, Math.min(0.85, 0.9 / Math.sqrt(games.length)));
      g.lineWidth = 1.6;
      g.lineCap = 'round';
      for (const gm of games) {
        const xs = pathXs(gm.turns, gm.solved, maxG, L);
        g.beginPath();
        g.moveTo(gx0 + xs[0] * gw, gy0);
        for (let d = 0; d < xs.length; d++) {
          const y = gy0 + ((d + 0.5) * gh) / nRows;
          if (d === 0) g.lineTo(gx0 + xs[0] * gw, y);
          else {
            const yp = gy0 + ((d - 0.5) * gh) / nRows;
            const xp = gx0 + xs[d - 1] * gw, x = gx0 + xs[d] * gw;
            g.bezierCurveTo(xp, (yp + y) / 2, x, (yp + y) / 2, x, y);
          }
        }
        g.stroke();
        const last = xs.length - 1;
        g.fillStyle = rgbCss(gm.solved ? theme.ink : theme.hatch, 0.8);
        g.beginPath();
        g.arc(gx0 + xs[last] * gw, gy0 + ((last + 0.5) * gh) / nRows, 2.2, 0, Math.PI * 2);
        g.fill();
      }
      p.tex.needsUpdate = true;
    }
    return targets.length;
  }

  /** Per frame: place and fade the planes from the director's stack frame. */
  update(cell: Cell | null): void {
    const s = director.stack;
    const r = director.focusRect;
    if (!s || !cell || !r || s.planesAlpha <= 0.002 || director.reduced) {
      this.group.visible = false;
      return;
    }
    this.ensurePlanes();
    const count = this.build(cell);
    this.group.visible = count > 0;
    const u = director.z - 1;
    for (let i = 0; i < this.planes.length; i++) {
      const p = this.planes[i];
      if (p.target < 0 || i >= count) {
        p.mesh.visible = false;
        continue;
      }
      const slide = planeSlide(u, i, count);
      const depth = -(i + 1) * PLANE_SPACING * s.spread - (1 - slide) * 700;
      const dx = (1 - slide) * r.w * 0.5;
      const c = director.layoutToWorld(r.x + r.w / 2 + dx, r.y + r.h / 2);
      p.mesh.position.set(c.x, c.y, depth);
      p.mesh.scale.set(r.w * director.k, r.h * director.k * director.yUp, 1);
      p.mat.opacity = s.planesAlpha * slide * (0.35 + 0.45 * (1 - i / Math.max(1, count)));
      p.mesh.visible = p.mat.opacity > 0.003;
    }
  }

  dispose(): void {
    for (const p of this.planes) {
      p.tex.dispose();
      p.mat.dispose();
    }
    this.planes = [];
  }
}
