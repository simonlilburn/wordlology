// A card face: canvas + texture for the face, a persistent density-ghost
// texture, and springs easing the displayed numbers. One per Cell; layers
// create their own meshes that show these textures.

import * as THREE from 'three';
import { app } from '../../app/store.svelte';
import type { Cell } from '../atlas/cells';
import { CARD_H, CARD_W, resolutionBucket, type Lod } from '../atlas/layout';
import { packDisplay, unpackDisplay, vectorLength, type CardDisplay } from './display';
import { drawFace, FACE, type FaceInfo } from './draw';
import { DensityGrid, pathXs } from './ghost';
import { cardTheme, prefersDark, type CardTheme } from './ramp';
import { SpringArray } from './spring';

const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const MONO = "ui-monospace, 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace";

export const GHOST_COLS = 150;
export const GHOST_ROWS_PX = 240;
const FLASH_MS = 900;

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** A global per-frame budget for ghost ingestion shared by every face. */
export const ghostBudget = { frame: -1, left: 0 };
const GHOST_GAMES_PER_FRAME = 3500;

export interface FaceRequest {
  now: number;
  dt: number;
  lod: Lod;
  /** Device pixels the card is drawn tall. */
  devicePx: number;
  /** Whether the ghost should keep accumulating (full LOD, visible). */
  ghost: boolean;
  /** Max redraws per second. */
  fps: number;
  reduced: boolean;
  selected: boolean;
}

export class CardFace {
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D | null;
  texture: THREE.CanvasTexture;
  ghostCanvas: HTMLCanvasElement;
  ghostG: CanvasRenderingContext2D | null;
  ghostTexture: THREE.CanvasTexture;
  grid: DensityGrid;
  private ghostImage: ImageData | null = null;
  private ghostRun: unknown = null;
  private ghostIngested = 0;
  private ghostUploaded = -1;
  private ghostUploadAt = 0;
  private springs: SpringArray;
  private latest: CardDisplay;
  private seenCellVersion = -1;
  private dirty = true;
  private lastDraw = -Infinity;
  private lastInfo = '';
  private lod: Lod = 'full';
  private res = 0;
  private resDownAt = 0;
  private theme: CardTheme;
  private snapNext = true;
  private selected = false;
  lastUsed = 0;
  /** Current eased display (for DOM overlays that mirror a card). */
  shown: CardDisplay;

  constructor(public cell: Cell) {
    this.latest = cell.display;
    this.shown = cell.display;
    this.springs = new SpringArray(vectorLength(cell.display.n));
    this.canvas = makeCanvas(CARD_W, CARD_H);
    this.g = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.ghostCanvas = makeCanvas(GHOST_COLS, GHOST_ROWS_PX);
    this.ghostG = this.ghostCanvas.getContext('2d');
    this.ghostTexture = new THREE.CanvasTexture(this.ghostCanvas);
    this.ghostTexture.colorSpace = THREE.SRGBColorSpace;
    this.ghostTexture.generateMipmaps = false;
    this.ghostTexture.minFilter = THREE.LinearFilter;
    this.ghostTexture.magFilter = THREE.LinearFilter;
    this.grid = new DensityGrid(GHOST_COLS, GHOST_ROWS_PX, cell.display.n);
    this.theme = cardTheme(prefersDark());
  }

  info(): FaceInfo {
    const c = this.cell;
    const cfg = c.config;
    const R = cfg?.replicates ?? app.result.replicatesCard;
    return {
      label: c.strategy.label,
      colour: c.strategy.colour,
      opener: c.opener,
      listName: app.words?.manifest.name ?? 'word list',
      hardMode: cfg?.rules.hard_mode ?? app.result.hardMode,
      sampling: c.deterministic ? 'exact' : `sampled, R = ${R}`,
      error: c.error,
    };
  }

  /** Update from the cell and redraw if needed; returns true while animating. */
  update(req: FaceRequest): boolean {
    this.lastUsed = req.now;
    const c = this.cell;
    c.poll(req.now);
    let animating = false;

    // Theme (dark mode can change at runtime).
    const dark = prefersDark();
    if (dark !== this.theme.dark) {
      this.theme = cardTheme(dark);
      this.dirty = true;
      this.ghostUploaded = -1;
    }

    if (c.version !== this.seenCellVersion) {
      this.seenCellVersion = c.version;
      const d = c.display;
      if (d.n !== this.latest.n) {
        this.springs = new SpringArray(vectorLength(d.n));
        this.snapNext = true;
        this.grid = new DensityGrid(GHOST_COLS, GHOST_ROWS_PX, d.n);
        this.resetGhost();
      }
      this.latest = d;
      this.springs.set(packDisplay(d), this.snapNext || req.reduced);
      this.snapNext = false;
      this.dirty = true;
    }
    if (this.springs.step(req.dt / 1000)) {
      this.dirty = true;
      animating = true;
    }
    const flashT = (req.now - c.completedAt) / FLASH_MS;
    const flash = flashT >= 0 && flashT < 1 ? Math.sin(Math.PI * Math.min(1, flashT * 1.6)) * (1 - flashT) : 0;
    if (flash > 0 || (flashT >= 1 && flashT < 1.2)) {
      this.dirty = true;
      animating = flashT < 1.2;
    }
    if (req.lod !== this.lod) {
      this.lod = req.lod;
      this.dirty = true;
    }
    if (req.selected !== this.selected) {
      this.selected = req.selected;
      this.dirty = true;
    }
    const info = this.info();
    const infoKey = JSON.stringify(info) + app.display.rowBars;
    if (infoKey !== this.lastInfo) {
      this.lastInfo = infoKey;
      this.dirty = true;
    }

    // Resolution: grow at once, shrink only after staying small for a while.
    const want = resolutionBucket(req.devicePx);
    if (want > this.res) {
      this.res = want;
      this.resize();
      this.resDownAt = 0;
    } else if (want < this.res) {
      if (this.resDownAt === 0) this.resDownAt = req.now + 800;
      else if (req.now >= this.resDownAt) {
        this.res = want;
        this.resize();
        this.resDownAt = 0;
      } else animating = true;
    } else this.resDownAt = 0;

    if (this.dirty) {
      const minGap = 1000 / Math.max(1, req.fps);
      if (req.now - this.lastDraw >= minGap) this.draw(flash);
      else animating = true;
    }

    if (req.ghost) animating = this.ingestGhost(req) || animating;
    return animating;
  }

  private resize(): void {
    const h = this.res;
    const w = Math.round((h * CARD_W) / CARD_H);
    if (this.canvas.width === w && this.canvas.height === h) return;
    // A new canvas: three.js textures cannot change size in place.
    this.canvas = makeCanvas(w, h);
    this.g = this.canvas.getContext('2d');
    const old = this.texture;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    old.dispose();
    this.dirty = true;
  }

  private draw(flash: number): void {
    const g = this.g;
    if (!g) return;
    this.shown = unpackDisplay(this.springs.x, this.latest);
    const k = this.canvas.height / CARD_H;
    try {
      drawFace(g, k, this.shown, this.info(), {
        lod: this.lod,
        theme: this.theme,
        rowBars: app.display.rowBars,
        flash,
        selected: this.selected,
        sans: SANS,
        mono: MONO,
      });
    } catch {
      /* canvas unavailable (tests) */
    }
    this.texture.needsUpdate = true;
    this.dirty = flash > 0;
    this.lastDraw = performance.now();
  }

  private resetGhost(): void {
    this.grid.clear();
    this.ghostIngested = 0;
    this.ghostUploaded = -1;
  }

  /** Draw newly arrived games onto the persistent density grid. */
  private ingestGhost(req: FaceRequest): boolean {
    const run = this.cell.run;
    if (!run) return false;
    if (run !== this.ghostRun) {
      this.ghostRun = run;
      this.resetGhost();
    }
    if (ghostBudget.frame !== req.now) {
      ghostBudget.frame = req.now;
      ghostBudget.left = GHOST_GAMES_PER_FRAME;
    }
    const games = run.games;
    const maxG = this.cell.maxGuesses;
    const L = app.words?.wordLength ?? 5;
    let pending = false;
    if (this.ghostIngested < games.length) {
      const end = Math.min(games.length, this.ghostIngested + Math.max(0, ghostBudget.left));
      for (let i = this.ghostIngested; i < end; i++) {
        const gm = games[i];
        if (gm.isPlayer) continue;
        this.grid.addPath(pathXs(gm.turns, gm.solved, maxG, L));
      }
      ghostBudget.left -= end - this.ghostIngested;
      this.ghostIngested = end;
      pending = end < games.length;
    }
    if (this.grid.version !== this.ghostUploaded && (req.now - this.ghostUploadAt > 90 || !pending)) {
      this.uploadGhost();
      this.ghostUploadAt = req.now;
    }
    return pending || this.grid.version !== this.ghostUploaded;
  }

  private uploadGhost(): void {
    const g = this.ghostG;
    if (!g) return;
    if (!this.ghostImage) this.ghostImage = g.createImageData(GHOST_COLS, GHOST_ROWS_PX);
    this.grid.toRgba(this.theme.ghost, this.theme.dark ? 0.4 : 0.34, this.ghostImage.data);
    g.putImageData(this.ghostImage, 0, 0);
    this.ghostTexture.needsUpdate = true;
    this.ghostUploaded = this.grid.version;
  }

  dispose(): void {
    this.texture.dispose();
    this.ghostTexture.dispose();
  }
}

/** Ghost region on the face, in card-local layout units. */
export const GHOST_RECT = {
  x: FACE.plotLeft - 8,
  y: FACE.rowsTop,
  w: FACE.plotRight - FACE.plotLeft + 16,
  h: FACE.rowsBottom - FACE.rowsTop,
};

/** Faces by cell, shared by the card and atlas layers. */
class FaceRegistry {
  private map = new Map<Cell, CardFace>();
  get(cell: Cell): CardFace {
    let f = this.map.get(cell);
    if (!f) {
      f = new CardFace(cell);
      this.map.set(cell, f);
    }
    return f;
  }
  prune(now: number, ageMs = 30_000): void {
    for (const [c, f] of this.map) {
      if (now - f.lastUsed > ageMs) {
        f.dispose();
        this.map.delete(c);
      }
    }
  }
  /** The face for a cell, if one exists (for overlays). */
  peek(cell: Cell): CardFace | undefined {
    return this.map.get(cell);
  }
}

export const faces = new FaceRegistry();
