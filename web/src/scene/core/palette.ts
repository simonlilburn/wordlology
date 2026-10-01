// Scene colours, read from the CSS custom properties in effect at the canvas
// (so the high-contrast class and dark mode apply) and cached until the
// palette setting or the colour scheme changes.

import { app } from '../../app/store.svelte';
import { isDark } from '../../app/theme.svelte';

export type RGB = [number, number, number];

export interface Palette {
  key: string;
  dark: boolean;
  bg: RGB;
  fg: RGB;
  muted: RGB;
  line: RGB;
  panel: RGB;
  accent: RGB;
  correct: RGB;
  present: RGB;
  absent: RGB;
  tileText: RGB;
  /** River fill. */
  river: RGB;
  /** Failure cross. */
  fail: RGB;
  /** Cell colours by feedback code 0 absent, 1 present, 2 correct. */
  cells: [RGB, RGB, RGB];
}

const LIGHT = {
  bg: '#fbfbf8',
  fg: '#1b1f1a',
  muted: '#5d665b',
  line: '#cad0c6',
  panel: '#f1f3ee',
  accent: '#2f6b3a',
  correct: '#6aaa64',
  present: '#c9b458',
  absent: '#787c7e',
  tileText: '#ffffff',
};
const DARK = { ...LIGHT, bg: '#131512', fg: '#eef1ec', muted: '#9ba597', line: '#3d443c', panel: '#1b1e1a', accent: '#8cc985', correct: '#538d4e', present: '#b59f3b', absent: '#3a3a3c' };
const HIGH_CONTRAST = { correct: '#f5793a', present: '#85c0f9' };

export function parseColour(s: string, fallback: RGB = [0.5, 0.5, 0.5]): RGB {
  const t = s.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(t);
  if (m) {
    const v = parseInt(m[1], 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  }
  m = /^#([0-9a-f]{3})$/i.exec(t);
  if (m) {
    const h = m[1];
    return [parseInt(h[0] + h[0], 16) / 255, parseInt(h[1] + h[1], 16) / 255, parseInt(h[2] + h[2], 16) / 255];
  }
  m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(t);
  if (m) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
  return fallback;
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

let cached: Palette | null = null;
let probe: Element | null = null;

/** Set the element whose computed custom properties define the palette (the canvas). */
export function setPaletteProbe(el: Element | null): void {
  probe = el;
  cached = null;
}

/** The current palette (cheap: re-read only when the palette setting or the Appearance changes). */
export function palette(): Palette {
  const dark = isDark();
  const hc = app.display.palette === 'high-contrast';
  const key = `${dark ? 'd' : 'l'}${hc ? 'h' : 's'}`;
  if (cached && cached.key === key) return cached;
  const base: Record<string, string> = { ...(dark ? DARK : LIGHT), ...(hc ? HIGH_CONTRAST : {}) };
  let css: CSSStyleDeclaration | null = null;
  try {
    if (probe && typeof getComputedStyle !== 'undefined') css = getComputedStyle(probe);
  } catch {
    css = null;
  }
  const read = (name: string, prop: string): RGB => {
    const v = css?.getPropertyValue(prop) ?? '';
    return parseColour(v || base[name], parseColour(base[name]));
  };
  const bg = read('bg', '--bg');
  const fg = read('fg', '--fg');
  const muted = read('muted', '--muted');
  // The high-contrast class may not be applied to the DOM yet in this frame, so use its constants directly.
  const correct = hc ? parseColour(HIGH_CONTRAST.correct) : read('correct', '--correct');
  const present = hc ? parseColour(HIGH_CONTRAST.present) : read('present', '--present');
  const absent = read('absent', '--absent');
  const p: Palette = {
    key,
    dark,
    bg,
    fg,
    muted,
    line: read('line', '--line'),
    panel: read('panel', '--panel'),
    accent: read('accent', '--accent'),
    correct,
    present,
    absent,
    tileText: read('tileText', '--tile-text'),
    river: dark ? mix(muted, bg, 0.2) : mix(muted, bg, 0.1),
    fail: dark ? [0.93, 0.42, 0.42] : [0.78, 0.2, 0.2],
    cells: [absent, present, correct],
  };
  cached = p;
  return p;
}

/** Forget the cached palette (the colour scheme changed). */
export function invalidatePalette(): void {
  cached = null;
}
