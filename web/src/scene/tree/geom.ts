// Label geometry (shared by drawing and hit testing) and hit tests. Pure.

import { ribbonXAt } from '../core/ribbons';
import { ellipsisMinPx, ellipsisText, type LNode } from './layout';
import type { DNode } from './morph';

/** Word label size cap (screen px). */
export const WORD_PX = 13;
export const ELLIPSIS_PX = 11;

export interface LabelGeom {
  mode: 'label' | 'tick';
  /** Em size in world units. */
  font: number;
  /** Plate size in world units. */
  w: number;
  h: number;
  /** Feedback strip cell height (world). */
  stripH: number;
  /** Lines of text (ellipsis: two). */
  lines: string[];
  /** Solved leaves: the check tile's size and its centre's offset below the node (world); 0 otherwise. */
  tile: number;
  tileDy: number;
  /** Hit box (label plus tile), centred on the node horizontally; `hitDy` shifts it down. */
  hitW: number;
  hitH: number;
  hitDy: number;
}

/** Slot width of a layout node in world units. */
export function slotWidth(l: LNode): number {
  return Math.max(0, l.right - l.left);
}

export function ellipsisLines(l: LNode, fmtInt?: (n: number) => string): string[] {
  return ellipsisText(l.hidden?.length ?? 0, l.hiddenMass, fmtInt);
}

/** Screen px an ellipsis label needs at the label threshold (the layout reserves it). */
export function ellipsisSlotPx(count: number, games: number, advance: number, threshold: number, fmtInt?: (n: number) => string): number {
  return ellipsisMinPx(count, games, advance, Math.max(threshold, 1) + 0.5, fmtInt) + ELLIPSIS_GAP;
}

/** Screen px left free between an ellipsis plate and its slot's edges (both sides together). */
const ELLIPSIS_GAP = 8;

/** Terminal check tile beside a solved leaf, as a multiple of the word's em size. */
const TILE_EM = 1.25;

/**
 * Size a node's label at camera scale `s`: words shrink with their slot (a
 * word and its padding take at most 90% of it) up to WORD_PX; below the label
 * threshold the node is drawn as a tick. A solved leaf ends in a check tile
 * centred below its label, so it takes no width from its neighbours.
 */
export function labelGeom(l: LNode, word: string, s: number, threshold: number, advance: number, fmtInt?: (n: number) => string, solvedLeaf = false): LabelGeom {
  const slotPx = slotWidth(l) * s;
  if (l.kind === 'ellipsis') {
    const lines = ellipsisLines(l, fmtInt);
    const chars = Math.max(...lines.map((x) => [...x].length));
    const px = Math.min(ELLIPSIS_PX, (slotPx - 7 - ELLIPSIS_GAP) / (chars * advance));
    const mode = px >= Math.min(threshold, ELLIPSIS_PX) ? 'label' : 'tick';
    const p = Math.max(px, 1);
    const w = (chars * advance * p + 6) / s;
    const h = (p * 2.3 + 6) / s;
    return { mode, font: p / s, w, h, stripH: 0, lines, tile: 0, tileDy: 0, hitW: w, hitH: h, hitDy: 0 };
  }
  if (l.kind === 'out') {
    const px = Math.min(WORD_PX, slotPx * 0.25);
    const mode = px >= threshold ? 'label' : 'tick';
    const p = Math.max(px, 1);
    const w = (p * 1.6 + 4) / s;
    return { mode, font: p / s, w, h: w, stripH: 0, lines: ['✗'], tile: 0, tileDy: 0, hitW: w, hitH: w, hitDy: 0 };
  }
  const len = Math.max(1, [...word].length);
  const px = Math.min(WORD_PX, (slotPx * 0.9 - 8) / (len * advance));
  const mode = px >= threshold ? 'label' : 'tick';
  const p = Math.max(px, 1);
  const stripH = Math.max(2, p * 0.3);
  const w = (len * advance * p + 8) / s;
  const h = (p * 1.05 + stripH + 8) / s;
  let tile = 0;
  let tileDy = 0;
  if (solvedLeaf) {
    tile = mode === 'label' ? (p * TILE_EM) / s : Math.max(3, Math.min(6, slotPx * 0.3)) / s;
    tileDy = mode === 'label' ? h / 2 + 3 / s + tile / 2 : 5 / s + tile / 2;
  }
  const hitH = tile ? Math.max(h, h / 2 + tileDy + tile / 2) : h;
  const hitDy = tile ? (hitH - h) / 2 : 0;
  return { mode, font: p / s, w, h, stripH: stripH / s, lines: [word], tile, tileDy, hitW: w, hitH, hitDy };
}

export interface Hit {
  d: DNode;
  /** Hit on the node's label or on the river into it. */
  on: 'node' | 'river';
}

/**
 * The node under a world point: labels first (their box, at least `minPx`
 * screen px each way), then rivers (at least 10 px wide). `geom` sizes a
 * node's box.
 */
export function hitTest(
  nodes: readonly DNode[],
  wx: number,
  wy: number,
  s: number,
  minPx: number,
  geom: (d: DNode) => { w: number; h: number; hitW?: number; hitH?: number; hitDy?: number } | null,
): Hit | null {
  let best: DNode | null = null;
  let bestD = Infinity;
  const minW = minPx / s;
  for (const d of nodes) {
    if (d.dying || d.alpha < 0.3 || d.l.kind === 'root') continue;
    const g = geom(d);
    if (!g) continue;
    const hw = Math.max(g.hitW ?? g.w, minW) / 2;
    const hh = Math.max(g.hitH ?? g.h, minW) / 2;
    const dx = Math.abs(wx - d.x);
    const dy = Math.abs(wy - (d.y - (g.hitDy ?? 0)));
    if (dx <= hw && dy <= hh) {
      const dist = dx / hw + dy / hh;
      if (dist < bestD) {
        bestD = dist;
        best = d;
      }
    }
  }
  if (best) return { d: best, on: 'node' };
  const tol = 5 / s;
  for (const d of nodes) {
    if (d.dying || d.alpha < 0.3 || !d.parent) continue;
    const p = d.parent;
    const cx = ribbonXAt(p.x + d.ro, p.y, d.x, d.y, wy);
    if (cx === null) continue;
    const dist = Math.abs(wx - cx);
    const half = Math.max(d.rw / 2, tol);
    if (dist <= half && dist / half < bestD) {
      bestD = dist / half;
      best = d;
    }
  }
  return best ? { d: best, on: 'river' } : null;
}
