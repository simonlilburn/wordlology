// Drawing a card face with Canvas2D. Pure drawing from a CardDisplay (already
// eased) and header info; the caller owns the canvas and the texture.

import { CARD_H, CARD_W, type Lod } from '../atlas/layout';
import type { CardDisplay } from './display';
import { fmtCount, fmtInt, fmtMean, fmtPercent, fmtQuantile, progressText, rowName } from './format';
import { hexToRgb, mixOklab, rampPositions, rgbCss, rowFill, rowLabel, type CardTheme, type RGB } from './ramp';

/** Face geometry in layout units (the card is CARD_W × CARD_H). */
export const FACE = {
  pad: 16,
  rowsTop: 84,
  rowsBottom: CARD_H - 64,
  plotLeft: 40,
  plotRight: CARD_W - 104,
  radius: 14,
};

/** Chip geometry: shaded rows and the mean only. */
export const CHIP = {
  rowsTop: 22,
  rowsBottom: CARD_H - 118,
};

export interface FaceInfo {
  label: string;
  colour: string;
  opener: string | null;
  listName: string;
  hardMode: boolean;
  /** "exact" or "sampled, R = 20". */
  sampling: string;
  error: string | null;
}

export interface DrawOptions {
  lod: Lod;
  theme: CardTheme;
  rowBars: boolean;
  /** 0..1 completion flash (border brightens). */
  flash: number;
  /** Selected for compare. */
  selected: boolean;
  /** Font family stacks. */
  sans: string;
  mono: string;
}

/** Rows region for a LOD, in layout units: [top, bottom]. */
export function rowsRegion(lod: Lod): [number, number] {
  if (lod === 'full') return [FACE.rowsTop, FACE.rowsBottom];
  if (lod === 'chip') return [CHIP.rowsTop, CHIP.rowsBottom];
  return [0, CARD_H];
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

function fitText(g: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (g.measureText(text).width <= maxW) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + '…';
}

/**
 * Draw a face into `g`, whose canvas is `k` device pixels per layout unit.
 * The canvas must be CARD_W·k × CARD_H·k.
 */
export function drawFace(g: CanvasRenderingContext2D, k: number, d: CardDisplay, info: FaceInfo, o: DrawOptions): void {
  const { theme } = o;
  const W = CARD_W, H = CARD_H;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, g.canvas.width, g.canvas.height);
  g.setTransform(k, 0, 0, k, 0, 0);
  const provisional = !d.complete;
  const inset = 1;

  // Paper and clip.
  g.save();
  roundRect(g, inset, inset, W - 2 * inset, H - 2 * inset, FACE.radius);
  g.fillStyle = rgbCss(theme.paper);
  g.fill();
  g.clip();

  const [top, bottom] = rowsRegion(o.lod);
  const n = d.n;
  const rowH = (bottom - top) / n;
  const ramp = rampPositions(d.shares);
  const bandTopY = top + Math.min(n, Math.max(0, d.bandTop)) * rowH;

  // Row shading (transparent → full ink for the largest row).
  for (let i = 0; i < n; i++) {
    const y = top + i * rowH;
    if (ramp[i] > 0.002) {
      g.fillStyle = rgbCss(rowFill(theme, ramp[i]));
      g.fillRect(0, y, W, rowH + 0.5);
    }
  }
  // Row rules.
  g.fillStyle = rgbCss(theme.rule);
  for (let i = 0; i <= n; i++) g.fillRect(0, top + i * rowH - 0.35, W, 0.7);

  // Deterministic runs: unresolved games in a hatched band below the settled rows.
  if (d.deterministic && !d.complete && d.unresolvedFrac > 0.0005 && bandTopY < bottom - 0.5) {
    g.save();
    g.beginPath();
    g.rect(0, bandTopY, W, bottom - bandTopY);
    g.clip();
    g.fillStyle = rgbCss(theme.paper);
    g.fillRect(0, bandTopY, W, bottom - bandTopY);
    g.strokeStyle = rgbCss(theme.hatch, 0.55);
    g.lineWidth = 1.1;
    g.beginPath();
    const span = bottom - bandTopY;
    for (let x = -span; x < W + span; x += 9) {
      g.moveTo(x, bottom);
      g.lineTo(x + span, bandTopY);
    }
    g.stroke();
    g.restore();
    g.fillStyle = rgbCss(theme.ink);
    g.fillRect(0, bandTopY - 0.6, W, 1.2);
    if (o.lod === 'full' && bottom - bandTopY > 16) {
      const label = `${fmtInt(d.unresolved)} unresolved`;
      g.font = `600 12px ${o.sans}`;
      const tw = g.measureText(label).width;
      const cx = (FACE.plotLeft + FACE.plotRight) / 2;
      const cy = Math.min(bandTopY + 18, (bandTopY + bottom) / 2);
      g.fillStyle = rgbCss(theme.paper);
      roundRect(g, cx - tw / 2 - 8, cy - 10, tw + 16, 20, 10);
      g.fill();
      g.strokeStyle = rgbCss(theme.hatch);
      g.lineWidth = 1;
      g.stroke();
      g.fillStyle = rgbCss(theme.ink);
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(label, cx, cy + 0.5);
    }
  }

  if (o.lod === 'full') drawFullRows(g, d, o, top, rowH, ramp, provisional, bandTopY);
  else drawChipRows(g, d, o, top, rowH, ramp);

  if (o.lod === 'full') drawHeaderFooter(g, d, info, o, provisional);
  else drawChipFooter(g, d, info, o, provisional);

  // Progress line along the lower edge.
  if (!d.complete) {
    const frac = d.deterministic
      ? d.nTargets > 0 ? 1 - d.unresolvedFrac : 0
      : d.expectedGames > 0 ? Math.min(1, d.nGames / d.expectedGames) : 0;
    g.fillStyle = rgbCss(theme.rule);
    g.fillRect(0, H - 4, W, 4);
    g.fillStyle = rgbCss(theme.accent);
    g.fillRect(0, H - 4, W * frac, 4);
  }
  g.restore();

  // Border: brightens briefly on completion; accent when selected for compare.
  roundRect(g, inset, inset, W - 2 * inset, H - 2 * inset, FACE.radius);
  const base: RGB = o.selected ? theme.accent : theme.rule;
  const col = o.flash > 0 ? mixOklab(base, theme.accent, o.flash) : base;
  g.strokeStyle = rgbCss(col);
  g.lineWidth = o.selected ? 4 : 1.5 + 2.5 * o.flash;
  g.stroke();
  if (info.error && o.lod !== 'micro') {
    g.fillStyle = rgbCss(theme.muted);
    g.font = `500 12px ${o.sans}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(info.error, W / 2, (top + bottom) / 2);
  }
}

function drawFullRows(
  g: CanvasRenderingContext2D,
  d: CardDisplay,
  o: DrawOptions,
  top: number,
  rowH: number,
  ramp: number[],
  provisional: boolean,
  bandTopY: number,
): void {
  const { theme } = o;
  const plotW = FACE.plotRight - FACE.plotLeft;
  for (let i = 0; i < d.n; i++) {
    const y = top + i * rowH;
    if (d.deterministic && !d.complete && y >= bandTopY - 0.5) {
      // Hidden by the unresolved band; still name the row.
      g.fillStyle = rgbCss(theme.muted);
      g.font = `500 11px ${o.sans}`;
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.fillText(rowName(i, d.maxGuesses), FACE.pad, y + rowH / 2);
      continue;
    }
    const lab = rowLabel(theme, ramp[i]);
    const cy = y + rowH / 2;
    // Row name.
    g.fillStyle = rgbCss(lab);
    g.font = `500 11px ${o.sans}`;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(rowName(i, d.maxGuesses), FACE.pad, cy);
    // Bar with its 95% band.
    if (o.rowBars) {
      const lo = Math.min(d.lo[i], d.shares[i]), hi = Math.max(d.hi[i], d.shares[i]);
      if (!d.complete && hi - lo > 0.0005) {
        g.fillStyle = rgbCss(lab, 0.3);
        g.fillRect(FACE.plotLeft + lo * plotW, cy - 5.5, Math.max(0.8, (hi - lo) * plotW), 11);
      }
      const bw = d.shares[i] * plotW;
      if (bw > 0.2) {
        g.fillStyle = rgbCss(lab, 0.92);
        g.fillRect(FACE.plotLeft, cy - 2, bw, 4);
      }
    }
    // Count and percentage at the right edge.
    g.textAlign = 'right';
    g.fillStyle = rgbCss(lab);
    g.font = `650 14px ${o.sans}`;
    g.fillText(fmtPercent(d.shares[i], provisional), CARD_W - FACE.pad, cy - 6);
    g.font = `400 10.5px ${o.sans}`;
    g.fillStyle = rgbCss(lab, 0.86);
    g.fillText(fmtCount(d.counts[i], provisional), CARD_W - FACE.pad, cy + 9);
  }
}

function drawChipRows(g: CanvasRenderingContext2D, d: CardDisplay, o: DrawOptions, top: number, rowH: number, ramp: number[]): void {
  if (o.lod !== 'chip') return;
  const { theme } = o;
  for (let i = 0; i < d.n; i++) {
    const lab = rowLabel(theme, ramp[i]);
    g.fillStyle = rgbCss(lab, 0.9);
    g.font = `600 22px ${o.sans}`;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(rowName(i, d.maxGuesses) === 'Out' ? 'X' : rowName(i, d.maxGuesses), 18, top + (i + 0.5) * rowH);
  }
}

function drawHeaderFooter(g: CanvasRenderingContext2D, d: CardDisplay, info: FaceInfo, o: DrawOptions, provisional: boolean): void {
  const { theme } = o;
  const W = CARD_W, P = FACE.pad;
  // Header: strategy (colour), hard-mode badge, opener, list, sampling.
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.fillStyle = rgbCss(hexToRgb(info.colour || '#888888'));
  g.beginPath();
  g.arc(P + 6, 25, 6, 0, Math.PI * 2);
  g.fill();
  let badgeW = 0;
  if (info.hardMode) {
    g.font = `700 10px ${o.sans}`;
    const tw = g.measureText('HARD').width;
    badgeW = tw + 14;
    const bx = W - P - badgeW;
    roundRect(g, bx, 16, badgeW, 18, 9);
    g.fillStyle = rgbCss(theme.ink);
    g.fill();
    g.fillStyle = rgbCss(theme.paper);
    g.textAlign = 'center';
    g.fillText('HARD', bx + badgeW / 2, 25.5);
    g.textAlign = 'left';
  }
  g.fillStyle = rgbCss(theme.ink);
  g.font = `650 16px ${o.sans}`;
  g.fillText(fitText(g, info.label, W - 2 * P - 18 - badgeW - 6), P + 18, 25);
  g.font = `500 12.5px ${o.mono}`;
  const opener = info.opener ? info.opener.toUpperCase() : "strategy's choice";
  g.fillStyle = rgbCss(theme.ink);
  const openerText = info.opener ? `opener ${opener}` : opener;
  g.fillText(fitText(g, openerText, W - 2 * P), P, 48);
  g.font = `400 11px ${o.sans}`;
  g.fillStyle = rgbCss(theme.muted);
  g.fillText(fitText(g, `${info.listName} · ${info.sampling}`, W - 2 * P), P, 67);

  // Footer: mean (± SE), solved, p95; progress text.
  const fy = FACE.rowsBottom + 22;
  const mean = fmtMean(d.mean, d.deterministic ? null : d.meanSe, provisional);
  g.fillStyle = rgbCss(theme.ink);
  g.font = `650 14px ${o.sans}`;
  g.textAlign = 'left';
  g.fillText(`mean ${mean}`, P, fy);
  g.textAlign = 'right';
  g.font = `500 12.5px ${o.sans}`;
  const solved = `${fmtPercent(d.solveRate, provisional)} solved · p95 ${fmtQuantile(d.p95, d.maxGuesses, provisional)}`;
  g.fillText(solved, W - P, fy);
  g.textAlign = 'left';
  g.font = `400 10.5px ${o.sans}`;
  g.fillStyle = rgbCss(theme.muted);
  const status = d.complete
    ? `${d.deterministic ? 'exact' : 'complete'} · ${fmtInt(d.nTargets)} targets · ${fmtInt(d.nGames)} games`
    : progressText(d);
  g.fillText(fitText(g, status, W - 2 * P), P, fy + 21);
}

function drawChipFooter(g: CanvasRenderingContext2D, d: CardDisplay, info: FaceInfo, o: DrawOptions, provisional: boolean): void {
  const { theme } = o;
  // Strategy colour strip on top.
  g.fillStyle = rgbCss(hexToRgb(info.colour || '#888888'));
  g.fillRect(0, 0, CARD_W, o.lod === 'chip' ? 12 : 16);
  if (o.lod !== 'chip') return;
  g.fillStyle = rgbCss(theme.ink);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `700 64px ${o.sans}`;
  g.fillText(Number.isFinite(d.mean) ? fmtMean(d.mean, null, provisional) : '…', CARD_W / 2, CHIP.rowsBottom + 60);
}
