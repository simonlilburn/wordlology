// Build the tree's batched geometry from the display nodes: rivers (one
// ribbon buffer), plates, feedback strips, ticks and tiles (one quad batch),
// words (one glyph batch), plus the rules and the sticky band labels.

import { patternCells } from '../../model/feedback';
import type { TrieNode } from '../../model/types';
import type { TextBatch } from '../core/glyphs';
import type { Palette, RGB } from '../core/palette';
import type { QuadBatch } from '../core/quads';
import type { RibbonBuilder } from '../core/ribbons';
import type { TreeFilter } from './filtering';
import { onMatchedPath } from './filtering';
import { labelGeom, type LabelGeom } from './geom';
import { bandTop, bandY, type LayoutParams } from './layout';
import type { DNode } from './morph';
import type { RevealState } from './reveal';

export interface DrawInput {
  nodes: readonly DNode[];
  /** The focused tree's nodes by id: display nodes whose trie node is not among them belong to the tree being morphed away from. */
  treeNodes?: readonly TrieNode[];
  s: number;
  /** Visible world rectangle (null: draw everything). */
  view: { x0: number; x1: number; y0: number; y1: number } | null;
  /** World x for the sticky band labels (the viewport's left edge). */
  bandLabelX: number;
  pal: Palette;
  words: readonly string[];
  wordLength: number;
  threshold: number;
  advance: number;
  params: LayoutParams;
  filter: TreeFilter | null;
  /** Trie ids on the hovered path (the path to the hovered node). */
  hover: ReadonlySet<number>;
  /** Hovered ellipsis key (its river highlights). */
  hoverKey: string | null;
  reveal: RevealState | null;
  now: number;
  /** Whole tree opacity (level fades). */
  alpha: number;
  /** Word labels opacity (fade out by z = 1.4). */
  labelAlpha: number;
  /** Non-trunk content opacity (Game → Tree transition). */
  branchAlpha: number;
  /** Trunk labels opacity (hand-over from the transition tiles). */
  trunkLabelAlpha: number;
  /** Trunk draw-down progress 0..1 (transition). */
  trunkProgress: number;
  rulesProgress: number;
  bandLabelAlpha: number;
  caption: string;
  fmtInt: (n: number) => string;
  /** Band label size (screen px). */
  bandFontPx?: number;
}

export interface DrawOutput {
  rules: QuadBatch;
  ribbons: RibbonBuilder;
  quads: QuadBatch;
  text: TextBatch;
  bandQuads: QuadBatch;
  bandText: TextBatch;
}

/** Geometry of each drawn label, keyed by display node (used for hit testing). */
export type GeomCache = Map<DNode, LabelGeom>;

function wordOf(d: DNode, words: readonly string[]): string {
  const t = d.l.trie;
  if (!t || t.guess < 0) return '';
  return (words[t.guess] ?? '?????').toUpperCase();
}

/** A solved game's last guess (strategy games end here, or the player's path does). */
export function isSolvedLeaf(t: TrieNode, solvedCode: number): boolean {
  return t.pattern === solvedCode && (t.endSolved > 0 || t.player);
}

export function nodeGeom(d: DNode, inp: Pick<DrawInput, 's' | 'threshold' | 'advance' | 'words' | 'fmtInt' | 'params'>): LabelGeom {
  const t = d.l.trie;
  const solved = d.l.kind === 'node' && !!t && isSolvedLeaf(t, inp.params.solvedCode);
  return labelGeom(d.l, wordOf(d, inp.words), inp.s, inp.threshold, inp.advance, inp.fmtInt, solved);
}

export function drawTree(inp: DrawInput, out: DrawOutput, geomCache: GeomCache): void {
  const { nodes, s, pal, params: p, filter, reveal, now } = inp;
  const { rules, ribbons, quads, text, bandQuads, bandText } = out;
  rules.clear();
  ribbons.clear();
  quads.clear();
  text.clear();
  bandQuads.clear();
  bandText.clear();
  geomCache.clear();
  const A = inp.alpha;
  if (A <= 0.003) return;
  const px = 1 / s;
  const N = p.maxGuesses;
  const view = inp.view;
  const highlight = filter && filter.mode === 'highlight';

  // Rules and band labels.
  if (view && inp.rulesProgress > 0) {
    const x0 = view.x0;
    const x1 = view.x0 + (view.x1 - view.x0) * inp.rulesProgress;
    const [r, g, b] = pal.line;
    for (let k = 1; k <= N + 2; k++) {
      const y = bandTop(k, p);
      if (y < view.y0 - 2 || y > view.y1 + 2) continue;
      rules.add((x0 + x1) / 2, y, x1 - x0, px, r, g, b, A);
    }
    // Faint Out band.
    const outTop = bandTop(N + 1, p);
    const outBot = bandTop(N + 2, p);
    rules.add((x0 + x1) / 2, (outTop + outBot) / 2, x1 - x0, outTop - outBot, pal.fail[0], pal.fail[1], pal.fail[2], A * (pal.dark ? 0.06 : 0.035));
  }
  if (view && inp.bandLabelAlpha > 0) {
    const la = A * inp.bandLabelAlpha;
    const font = (inp.bandFontPx ?? 10.5) * px;
    const [mr, mg, mb] = pal.muted;
    const [br, bg, bb] = pal.bg;
    for (let k = 1; k <= N + 1; k++) {
      const label = k <= N ? `GUESS ${k}` : 'OUT';
      const y = bandTop(k, p) - 10 * px;
      if (y < view.y0 - 20 * px || y > view.y1 + 20 * px) continue;
      const w = bandText.width(label, font);
      bandQuads.add(inp.bandLabelX + w / 2, y, w + 8 * px, font * 1.6, br, bg, bb, la * 0.82, 3 * px);
      bandText.add(label, inp.bandLabelX, y, font, mr, mg, mb, la, 'left');
    }
  }

  // Rivers.
  const riverA = pal.dark ? 0.42 : 0.34;
  let trunkLeaf: DNode | null = null;
  for (const d of nodes) {
    const t = d.l.trie;
    if (d.l.trunk && (!trunkLeaf || d.l.band > trunkLeaf.l.band)) trunkLeaf = d;
    if (!d.parent || d.alpha <= 0.003) continue;
    const par = d.parent;
    // The trunk starts at the opener: no river from the caption to a fixed
    // opener; several first guesses fan out from the top rule.
    if (par.l.kind === 'root' && par.l.children.length <= 1) continue;
    const x0 = par.x + d.ro;
    const y0 = par.l.kind === 'root' ? bandTop(1, p) : par.y;
    if (view) {
      const lo = Math.min(x0, d.x) - d.rw;
      const hi = Math.max(x0, d.x) + d.rw;
      if (hi < view.x0 || lo > view.x1 || Math.min(y0, d.y) > view.y1 || Math.max(y0, d.y) < view.y0) continue;
    }
    let a = d.alpha * A;
    if (!d.l.trunk) a *= inp.branchAlpha;
    // A node of the previous target's tree: no per-id lookups (ids differ between trees).
    const foreign = !!t && !!inp.treeNodes && inp.treeNodes[t.id] !== t;
    let prog = 1;
    if (reveal && t && !foreign && d.l.kind !== 'ellipsis') prog = reveal.progress(t.id, now);
    if (d.l.trunk && inp.trunkProgress < 1) prog = Math.min(prog, Math.min(1, Math.max(0, inp.trunkProgress * (N + 1) - (d.l.band - 1))));
    if (prog <= 0) continue;
    const onHover = (t && !foreign && inp.hover.has(t.id) && d.l.kind !== 'ellipsis') || (inp.hoverKey !== null && d.key === inp.hoverKey);
    let dim = false;
    if (highlight && filter) {
      if (d.l.kind === 'ellipsis') dim = d.l.hiddenMatches === 0;
      else if (t && !foreign) dim = !onMatchedPath(filter, t);
    }
    if (dim) a *= 0.25;
    let col: RGB = pal.river;
    let ca = riverA;
    if (d.l.kind === 'ellipsis') ca = riverA * 0.6;
    if (d.l.trunk) ca = riverA * 1.25;
    if (onHover) {
      col = pal.accent;
      ca = 0.5;
    }
    if (d.rw <= 0) {
      // A massless player path: a hairline.
      const c = onHover ? pal.accent : pal.fg;
      ribbons.ribbon(x0, y0, d.x, d.y, 1.4 * px, 1.4 * px, c[0], c[1], c[2], a * 0.7, prog);
    } else {
      const w = Math.max(d.rw, px);
      ribbons.ribbon(x0, y0, d.x, d.y, w, w, col[0], col[1], col[2], a * ca, prog);
    }
  }
  // The trunk: a straight line down the centre.
  if (trunkLeaf) {
    const chain: DNode[] = [];
    for (let d: DNode | null = trunkLeaf; d; d = d.parent) chain.push(d);
    chain.reverse();
    const [r, g, b] = pal.fg;
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1];
      const c = chain[i];
      if (c.l.kind === 'root') continue;
      let prog = 1;
      if (inp.trunkProgress < 1) prog = Math.min(1, Math.max(0, inp.trunkProgress * (N + 1) - (c.l.band - 1)));
      if (a.l.kind === 'root') continue; // the trunk starts at the opener
      if (prog <= 0) break;
      const ya = a.y;
      const yc = a.y + (c.y - a.y) * prog;
      const xc = a.x + (c.x - a.x) * prog;
      ribbons.segment(a.x, ya, xc, yc, 1.5 * px, r, g, b, A * 0.45 * Math.min(a.alpha, c.alpha));
    }
  }

  // Nodes.
  const fgC = pal.fg;
  const bgC = pal.bg;
  const len = inp.wordLength;
  for (const d of nodes) {
    const t = d.l.trie;
    if (d.l.kind === 'root') {
      if (inp.caption && d.alpha > 0.01) {
        const font = 10.5 * px;
        const [r, g, b] = pal.muted;
        text.add(inp.caption, d.x, d.y, font, r, g, b, A * inp.bandLabelAlpha * d.alpha, 'center');
      }
      continue;
    }
    if (d.alpha <= 0.01) continue;
    const foreign = !!t && !!inp.treeNodes && inp.treeNodes[t.id] !== t;
    const pt = d.l.kind === 'ellipsis' ? (d.parent?.l.trie ?? null) : null;
    const parentForeign = !!pt && !!inp.treeNodes && inp.treeNodes[pt.id] !== pt;
    let prog = 1;
    if (reveal && t && !foreign && d.l.kind !== 'ellipsis') prog = reveal.progress(t.id, now);
    if (reveal && pt && !parentForeign) prog = reveal.progress(pt.id, now);
    let a = d.alpha * A * Math.min(1, Math.max(0, (prog - 0.55) / 0.45));
    if (d.l.trunk) a *= inp.trunkLabelAlpha;
    else a *= inp.branchAlpha;
    if (a <= 0.01) continue;
    const g = nodeGeom(d, inp);
    geomCache.set(d, g);
    if (view && (d.x + g.w < view.x0 || d.x - g.w > view.x1 || d.y - g.h > view.y1 || d.y + g.h < view.y0)) continue;
    let dim = false;
    let match = false;
    if (highlight && filter) {
      if (d.l.kind === 'ellipsis') dim = d.l.hiddenMatches === 0;
      else if (t && !foreign) {
        dim = !onMatchedPath(filter, t);
        match = d.l.kind === 'node' && filter.match[t.id] === 1;
      }
    }
    if (dim) a *= 0.25;
    const onHover = t !== null && !foreign && inp.hover.has(t.id) && d.l.kind !== 'ellipsis';
    const la = a * inp.labelAlpha;
    if (g.mode === 'tick') {
      const tw = Math.min(10 * px, (d.l.right - d.l.left) * 0.6);
      if (d.l.kind === 'out') quads.add(d.x, d.y, Math.max(tw, 2 * px), 2 * px, pal.fail[0], pal.fail[1], pal.fail[2], a * 0.8);
      else if (d.l.kind === 'ellipsis') quads.add(d.x, d.y, Math.max(tw, 2 * px), 2 * px, pal.muted[0], pal.muted[1], pal.muted[2], a * 0.6, px);
      else {
        const c = onHover || match ? pal.accent : fgC;
        quads.add(d.x, d.y, Math.max(tw, 2 * px), 2 * px, c[0], c[1], c[2], a * 0.75);
        if (g.tile > 0) quads.add(d.x, d.y - g.tileDy, g.tile, g.tile, pal.correct[0], pal.correct[1], pal.correct[2], a, g.tile * 0.25);
      }
      continue;
    }
    if (la <= 0.01) continue;
    // Label mode.
    const radius = 3 * px;
    if (d.l.kind === 'ellipsis') {
      const [pr, pg, pb] = pal.panel;
      quads.add(d.x, d.y, g.w, g.h, pr, pg, pb, la * 0.95, radius);
      const oc = inp.hoverKey === d.key ? pal.accent : pal.line;
      quads.add(d.x, d.y, g.w, g.h, oc[0], oc[1], oc[2], la, radius, 1 * px);
      const [mr, mg, mb] = pal.muted;
      text.add(g.lines[0], d.x, d.y + g.font * 0.62, g.font, mr, mg, mb, la);
      text.add(g.lines[1], d.x, d.y - g.font * 0.62, g.font, mr, mg, mb, la);
      if (highlight && d.l.hiddenMatches > 0) {
        const label = `${inp.fmtInt(d.l.hiddenMatches)} match${d.l.hiddenMatches === 1 ? '' : 'es'}`;
        const bf = 9.5 * px;
        const bw = text.width(label, bf) + 10 * px;
        const bx = d.x + g.w / 2 - bw / 2 + 6 * px;
        const by = d.y + g.h / 2 + 5 * px;
        quads.add(bx, by, bw, bf * 1.7, pal.accent[0], pal.accent[1], pal.accent[2], a, bf * 0.85);
        text.add(label, bx, by, bf, 1, 1, 1, a);
      }
      continue;
    }
    if (d.l.kind === 'out') {
      quads.add(d.x, d.y, g.w, g.h, bgC[0], bgC[1], bgC[2], la * 0.92, radius);
      quads.add(d.x, d.y, g.w, g.h, pal.fail[0], pal.fail[1], pal.fail[2], la, radius, 1.2 * px);
      text.add('✗', d.x, d.y, g.font * 1.1, pal.fail[0], pal.fail[1], pal.fail[2], la);
      continue;
    }
    // A guess.
    const word = g.lines[0];
    quads.add(d.x, d.y, g.w, g.h, bgC[0], bgC[1], bgC[2], la * 0.9, radius);
    if (match) quads.add(d.x, d.y, g.w + 3 * px, g.h + 3 * px, pal.accent[0], pal.accent[1], pal.accent[2], la, radius + px, 2 * px);
    else if (onHover) quads.add(d.x, d.y, g.w, g.h, pal.accent[0], pal.accent[1], pal.accent[2], la, radius, 1.5 * px);
    else if (t && t.player && t.mass === 0) quads.add(d.x, d.y, g.w, g.h, fgC[0], fgC[1], fgC[2], la * 0.5, radius, px);
    const contentH = g.font * 1.05 + 2 * px + g.stripH;
    const top = d.y + contentH / 2;
    text.add(word, d.x, top - g.font * 0.52, g.font, fgC[0], fgC[1], fgC[2], la);
    if (t) {
      const cells = patternCells(t.pattern, len);
      const adv = inp.advance * g.font;
      const x0 = d.x - (len * adv) / 2;
      const sy = top - g.font * 1.05 - 2 * px - g.stripH / 2;
      for (let j = 0; j < len; j++) {
        const c = pal.cells[cells[j] ?? 0];
        quads.add(x0 + (j + 0.5) * adv, sy, Math.max(px, adv - 1.5 * px), g.stripH, c[0], c[1], c[2], la, 0.5 * px);
      }
      if (g.tile > 0) {
        const ty = d.y - g.tileDy;
        quads.add(d.x, ty, g.tile, g.tile, pal.correct[0], pal.correct[1], pal.correct[2], la, 2 * px);
        text.add('✓', d.x, ty, g.tile * 0.72, pal.tileText[0], pal.tileText[1], pal.tileText[2], la);
      }
    }
  }
}

/** Band centre y (re-exported for the transition). */
export { bandY };
