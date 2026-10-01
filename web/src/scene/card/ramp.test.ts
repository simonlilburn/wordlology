import { describe, expect, it } from 'vitest';
import {
  bestLabel,
  cardTheme,
  contrastRatio,
  hexToRgb,
  mixOklab,
  oklabToRgb,
  rampPositions,
  relativeLuminance,
  rgbToHex,
  rgbToOklab,
  rowFill,
  rowLabel,
} from './ramp';

describe('colour conversions', () => {
  it('parses and formats hex colours', () => {
    expect(hexToRgb('#ff8000')).toEqual([255, 128, 0]);
    expect(hexToRgb('fff')).toEqual([255, 255, 255]);
    expect(rgbToHex([255, 128, 0])).toBe('#ff8000');
  });

  it('round-trips through OKLab', () => {
    for (const hex of ['#000000', '#ffffff', '#6a4cf0', '#17171a', '#fdfdfc', '#1f9d8b']) {
      const rgb = hexToRgb(hex);
      const back = oklabToRgb(rgbToOklab(rgb));
      for (let i = 0; i < 3; i++) expect(Math.abs(back[i] - rgb[i])).toBeLessThan(0.6);
    }
  });

  it('has WCAG luminance and contrast of black and white', () => {
    expect(relativeLuminance([0, 0, 0])).toBe(0);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 6);
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 6);
  });
});

describe('row ramp', () => {
  it('maps the largest share to full ink and zero to paper', () => {
    expect(rampPositions([0.1, 0.4, 0.2, 0])).toEqual([0.25, 1, 0.5, 0]);
    expect(rampPositions([0, 0, 0])).toEqual([0, 0, 0]);
    const theme = cardTheme(false);
    expect(rowFill(theme, 0)).toEqual(theme.paper.map((v) => expect.closeTo(v, 0)));
    const ink = rowFill(theme, 1);
    for (let i = 0; i < 3; i++) expect(Math.abs(ink[i] - theme.ink[i])).toBeLessThan(0.6);
  });

  it('is perceptually uniform: OKLab lightness steps are even', () => {
    const theme = cardTheme(false);
    const L = [0, 0.25, 0.5, 0.75, 1].map((t) => rgbToOklab(rowFill(theme, t))[0]);
    const steps = L.slice(1).map((l, i) => l - L[i]);
    for (const s of steps) expect(s).toBeCloseTo(steps[0], 2);
  });

  it('interpolates in OKLab between the endpoints', () => {
    const a = hexToRgb('#ffffff'), b = hexToRgb('#000000');
    expect(mixOklab(a, b, 0)).toEqual(a.map((v) => expect.closeTo(v, 0)));
    expect(mixOklab(a, b, 2)).toEqual(mixOklab(a, b, 1));
  });

  it('keeps labels at WCAG AA contrast (4.5:1) on every shade, light and dark', () => {
    for (const dark of [false, true]) {
      const theme = cardTheme(dark);
      let flipped = false;
      let first = rowLabel(theme, 0);
      for (let i = 0; i <= 100; i++) {
        const t = i / 100;
        const bg = rowFill(theme, t);
        const label = rowLabel(theme, t);
        expect(contrastRatio(bg, label)).toBeGreaterThanOrEqual(4.5);
        if (label.join() !== first.join()) flipped = true;
      }
      expect(flipped).toBe(true);
      first = [0, 0, 0];
    }
  });

  it('picks the candidate with the highest contrast', () => {
    expect(bestLabel([250, 250, 250], [[0, 0, 0], [255, 255, 255]])).toEqual([0, 0, 0]);
    expect(bestLabel([20, 20, 20], [[0, 0, 0], [255, 255, 255]])).toEqual([255, 255, 255]);
  });
});
