// Label geometry (shared by drawing and hit testing) and hit tests. Pure.

import { ribbonXAt } from '../core/ribbons';
import type { LNode } from './layout';
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
}

/** Slot width of a layout node in world units. */
export function slotWidth(l: LNode): number {
  return Math.max(0, l.right - l.left);
}

export function ellipsisLines(l: LNode, fmtInt: (n: number) => string = String): string[] {
  const n = l.hidden?.length ?? 0;
  return [`… ${fmtInt(n)} more`, `${fmtInt(Math.round(l.hiddenMass))} game${l.hiddenMass === 1 ? '' : 's'}`];
}

/**
 * Size a node's label at camera scale `s`: words shrink with their slot (a
 * word and its padding take at most 90% of it) up to WORD_PX; below the label
 * threshold the node is drawn as a tick.
 */
export function labelGeom(l: LNode, word: string, s: number, threshold: number, advance: number, fmtInt?: (n: number) => string): LabelGeom {
  const slotPx = slotWidth(l) * s;
  if (l.kind === 'ellipsis') {
    const lines = ellipsisLines(l, fmtInt);
    const chars = Math.max(...lines.map((x) => [...x].length));
    const px = Math.min(ELLIPSIS_PX, (slotPx * 0.9 - 6) / (chars * advance));
    const mode = px >= Math.min(threshold, ELLIPSIS_PX) ? 'label' : 'tick';
    const font = Math.max(px, 1) / s;
    return { mode, font, w: (chars * advance * Math.max(px, 1) + 10) / s, h: (Math.max(px, 1) * 2.3 + 8) / s, stripH: 0, lines };
  }
  if (l.kind === 'out') {
    const px = Math.min(WORD_PX, slotPx * 0.25);
    const mode = px >= threshold ? 'label' : 'tick';
    const font = Math.max(px, 1) / s;
    return { mode, font, w: (Math.max(px, 1) * 1.6 + 4) / s, h: (Math.max(px, 1) * 1.6 + 4) / s, stripH: 0, lines: ['✗'] };
  }
  const len = Math.max(1, [...word].length);
  const px = Math.min(WORD_PX, (slotPx * 0.9 - 8) / (len * advance));
  const mode = px >= threshold ? 'label' : 'tick';
  const p = Math.max(px, 1);
  const stripH = Math.max(2, p * 0.3);
  return { mode, font: p / s, w: (len * advance * p + 8) / s, h: (p * 1.05 + stripH + 8) / s, stripH: stripH / s, lines: [word] };
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
export function hitTest(nodes: readonly DNode[], wx: number, wy: number, s: number, minPx: number, geom: (d: DNode) => { w: number; h: number } | null): Hit | null {
  let best: DNode | null = null;
  let bestD = Infinity;
  const minW = minPx / s;
  for (const d of nodes) {
    if (d.dying || d.alpha < 0.3 || d.l.kind === 'root') continue;
    const g = geom(d);
    if (!g) continue;
    const hw = Math.max(g.w, minW) / 2;
    const hh = Math.max(g.h, minW) / 2;
    const dx = Math.abs(wx - d.x);
    const dy = Math.abs(wy - d.y);
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
