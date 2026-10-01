// Colour maths for card faces: a perceptually uniform ramp from the card's
// paper to full ink (interpolated in OKLab, so lightness steps are even), and
// WCAG contrast so labels on shaded rows flip colour to stay readable (AA).

import { isDark } from '../../app/theme.svelte';

export type RGB = [number, number, number]; // 0..255 sRGB

export function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: RGB): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function rgbCss([r, g, b]: RGB, alpha = 1): string {
  const R = Math.round(r), G = Math.round(g), B = Math.round(b);
  return alpha >= 1 ? `rgb(${R},${G},${B})` : `rgba(${R},${G},${B},${Math.max(0, alpha).toFixed(3)})`;
}

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, c * 255));
}

/** sRGB (0..255) to OKLab [L, a, b]. */
export function rgbToOklab([r, g, b]: RGB): [number, number, number] {
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToRgb([L, A, B]: [number, number, number]): RGB {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** Interpolate two colours in OKLab (perceptually uniform lightness steps). */
export function mixOklab(a: RGB, b: RGB, t: number): RGB {
  const A = rgbToOklab(a), B = rgbToOklab(b);
  const u = Math.max(0, Math.min(1, t));
  return oklabToRgb([A[0] + (B[0] - A[0]) * u, A[1] + (B[1] - A[1]) * u, A[2] + (B[2] - A[2]) * u]);
}

/** WCAG 2 relative luminance. */
export function relativeLuminance([r, g, b]: RGB): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** The label colour (of the candidates) with the highest contrast against `bg`. */
export function bestLabel(bg: RGB, candidates: RGB[]): RGB {
  let best = candidates[0];
  let bestC = -1;
  for (const c of candidates) {
    const r = contrastRatio(bg, c);
    if (r > bestC) {
      bestC = r;
      best = c;
    }
  }
  return best;
}

export interface CardTheme {
  dark: boolean;
  paper: RGB;
  ink: RGB;
  /** Label colours tried on shaded rows; one always reaches 4.5:1. */
  labelDark: RGB;
  labelLight: RGB;
  muted: RGB;
  rule: RGB;
  ghost: RGB;
  accent: RGB;
  hatch: RGB;
}

export function cardTheme(dark: boolean): CardTheme {
  return dark
    ? {
        dark,
        paper: hexToRgb('#1b1e1a'),
        ink: hexToRgb('#eef1ec'),
        labelDark: hexToRgb('#000000'),
        labelLight: hexToRgb('#ffffff'),
        muted: hexToRgb('#a3ad9f'),
        rule: hexToRgb('#3d443c'),
        ghost: hexToRgb('#8f9a8c'),
        accent: hexToRgb('#8cc985'),
        hatch: hexToRgb('#6a7367'),
      }
    : {
        dark,
        paper: hexToRgb('#fdfdfb'),
        ink: hexToRgb('#1b1f1a'),
        labelDark: hexToRgb('#000000'),
        labelLight: hexToRgb('#ffffff'),
        muted: hexToRgb('#5a6358'),
        rule: hexToRgb('#d6dbd2'),
        ghost: hexToRgb('#7a8577'),
        accent: hexToRgb('#2f6b3a'),
        hatch: hexToRgb('#99a296'),
      };
}

/**
 * Shading of a row: t = share / largest share, from paper (t = 0) to full ink
 * (t = 1), linear in OKLab lightness.
 */
export function rowFill(theme: CardTheme, t: number): RGB {
  return mixOklab(theme.paper, theme.ink, t);
}

/** Label colour for text drawn on a row shaded at t (always ≥ 4.5:1). */
export function rowLabel(theme: CardTheme, t: number): RGB {
  return bestLabel(rowFill(theme, t), [theme.labelDark, theme.labelLight]);
}

/** Ramp position of each row: share / max share (0 when every share is 0). */
export function rampPositions(shares: number[]): number[] {
  let max = 0;
  for (const s of shares) if (s > max) max = s;
  return shares.map((s) => (max > 0 ? Math.max(0, Math.min(1, s / max)) : 0));
}

/** Whether card faces use the dark theme (the Appearance setting, via app/theme). */
export function prefersDark(): boolean {
  return isDark();
}
/** Kept for callers that reset on a scheme change; the scheme is no longer cached here. */
export function refreshScheme(): void {}
