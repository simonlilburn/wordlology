// Cover thumbnails for the target browser, drawn lazily with Canvas2D and cached.
// A thumbnail shows the target tree's silhouette (rivers sized by games), its
// most likely path as a straight trunk, and its outcome distribution as a
// shaded strip down the right edge (rows Guess 1..max and X, darker = more
// games ending there), leaving the tree itself on clear paper.
import { MONO } from '../../app/fonts';
import type { ThumbLayout } from './stats';

export const THUMB_W = 96;
export const THUMB_H = 128;
/** Width of the shaded outcome strip at the right edge. */
const STRIP_W = 12;
/** The root (the lead-in above the opener) is drawn as a thin line, and rivers are capped, so the top of the tree stays light. */
const ROOT_W = 1.4;
const MAX_RIVER = 4.5;

export interface ThumbColours {
  fg: string;
  muted: string;
  correct: string;
  absent: string;
  bg: string;
}

const cache = new Map<string, HTMLCanvasElement>();
const MAX_CACHE = 400;

/** Theme colours as the canvas's element sees them (follows dark mode and the high-contrast palette). */
export function readColours(el: Element): ThumbColours {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    fg: v('--fg', '#1a1a1b'),
    muted: v('--muted', '#6b6b70'),
    correct: v('--correct', '#6aaa64'),
    absent: v('--absent', '#787c7e'),
    bg: v('--bg', '#ffffff'),
  };
}


/** Draw a layout into a 2D context of size w × h (CSS px, already scaled for DPR). */
export function paintThumb(ctx: CanvasRenderingContext2D, layout: ThumbLayout, maxGuesses: number, w: number, h: number, c: ThumbColours): void {
  ctx.clearRect(0, 0, w, h);
  const rows = maxGuesses + 1;
  const top = 6;
  const rowH = (h - top) / rows;
  const maxShare = Math.max(1e-9, ...layout.shares);
  // Outcome strip at the right edge and thin row rules.
  for (let r = 0; r < rows; r++) {
    const s = layout.shares[r] ?? 0;
    const y = top + r * rowH;
    if (s > 0) {
      ctx.globalAlpha = 0.08 + 0.5 * (s / maxShare);
      ctx.fillStyle = r === maxGuesses ? '#c0392b' : c.fg;
      ctx.fillRect(w - STRIP_W, y, STRIP_W, rowH);
    }
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = c.muted;
    ctx.fillRect(0, y, w, 0.5);
    ctx.globalAlpha = 1;
  }
  if (!layout.games) {
    ctx.fillStyle = c.muted;
    ctx.font = `9px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.fillText('computing…', w / 2, h / 2);
    return;
  }
  const yOf = (d: number) => (d <= 0 ? top : top + (d - 0.5) * rowH);
  // The tree keeps clear of the strip.
  const xOf = (x: number) => 4 + Math.min(1, Math.max(0, x)) * (w - 10 - STRIP_W);
  const maxRiver = w * 0.08;
  const drawEdges = (trunk: boolean) => {
    for (const e of layout.edges) {
      if (e.trunk !== trunk) continue;
      const x0 = xOf(e.x0);
      const x1 = xOf(e.x1);
      const y0 = yOf(e.d0);
      const y1 = yOf(e.d1);
      ctx.lineWidth = e.d0 <= 0 ? ROOT_W : Math.max(0.75, Math.min(MAX_RIVER, e.share * maxRiver));
      ctx.strokeStyle = c.fg;
      ctx.globalAlpha = trunk ? 1 : 0.45;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      const my = (y0 + y1) / 2;
      ctx.bezierCurveTo(x0, my, x1, my, x1, y1);
      ctx.stroke();
    }
  };
  ctx.lineCap = 'round';
  drawEdges(false);
  drawEdges(true);
  ctx.globalAlpha = 1;
  // Ends: solved as filled squares, failures as crosses in the X row.
  for (const e of layout.ends) {
    const x = xOf(e.x);
    const y = e.solved ? yOf(e.d) : top + (maxGuesses + 0.5) * rowH;
    const s = 2 + Math.min(3, Math.sqrt(e.share) * 4);
    if (e.solved) {
      ctx.fillStyle = c.correct;
      ctx.fillRect(x - s / 2, y - s / 2, s, s);
    } else {
      ctx.strokeStyle = '#c0392b';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x - s / 2, y - s / 2);
      ctx.lineTo(x + s / 2, y + s / 2);
      ctx.moveTo(x + s / 2, y - s / 2);
      ctx.lineTo(x - s / 2, y + s / 2);
      ctx.stroke();
    }
  }
}

/**
 * Draw a thumbnail onto `canvas`, from the cache when `key` was drawn before.
 * `build` computes the layout only on a cache miss.
 */
export function drawThumb(canvas: HTMLCanvasElement, key: string, maxGuesses: number, build: () => ThumbLayout): void {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const colours = readColours(canvas);
  const fullKey = `${key}|${dpr}|${colours.fg}|${colours.correct}`;
  let img = cache.get(fullKey);
  if (img) {
    cache.delete(fullKey); // refresh LRU position
    cache.set(fullKey, img);
  } else {
    img = document.createElement('canvas');
    img.width = Math.round(THUMB_W * dpr);
    img.height = Math.round(THUMB_H * dpr);
    const ctx = img.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    paintThumb(ctx, build(), maxGuesses, THUMB_W, THUMB_H, colours);
    cache.set(fullKey, img);
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
  }
  if (canvas.width !== img.width || canvas.height !== img.height) {
    canvas.width = img.width;
    canvas.height = img.height;
  }
  const out = canvas.getContext('2d');
  if (!out) return;
  out.clearRect(0, 0, canvas.width, canvas.height);
  out.drawImage(img, 0, 0);
}

export function clearThumbCache(): void {
  cache.clear();
}
