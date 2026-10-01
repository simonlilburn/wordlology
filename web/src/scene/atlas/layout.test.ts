import { describe, expect, it } from 'vitest';
import {
  CARD_H,
  CARD_W,
  CARD_TOOLBAR_H,
  cardRegion,
  cardView,
  cellRect,
  fitView,
  GAP,
  gridLayout,
  hitCell,
  lerpView,
  lodFor,
  rectVisible,
  resolutionBucket,
  screenToLayout,
  viewTransform,
} from './layout';

describe('grid layout', () => {
  it('keeps cards portrait 3:4', () => {
    expect(CARD_W / CARD_H).toBeCloseTo(0.75, 9);
  });

  it('lays out cells with a dashed column at the right and a dashed row below', () => {
    const g = gridLayout(3, 2);
    expect(cellRect(g, 2, 1)).toEqual({ x: 2 * (CARD_W + GAP), y: CARD_H + GAP, w: CARD_W, h: CARD_H });
    expect(g.dashedCol.x).toBe(3 * (CARD_W + GAP));
    expect(g.dashedCol.h).toBe(2 * (CARD_H + GAP) - GAP);
    expect(g.dashedRow.y).toBe(2 * (CARD_H + GAP));
    expect(g.bounds.w).toBe(g.dashedCol.x + g.dashedCol.w);
    expect(g.bounds.h).toBe(g.dashedRow.y + g.dashedRow.h);
    // An empty grid still has one cell.
    expect(gridLayout(0, 0).cols).toBe(1);
  });

  it('hits cells and misses gaps', () => {
    const g = gridLayout(2, 2);
    expect(hitCell(g, 10, 10)).toEqual([0, 0]);
    expect(hitCell(g, CARD_W + GAP + 5, CARD_H + GAP + 5)).toEqual([1, 1]);
    expect(hitCell(g, CARD_W + GAP / 2, 10)).toBeNull();
    expect(hitCell(g, -1, 10)).toBeNull();
    expect(hitCell(g, 10, 3 * (CARD_H + GAP))).toBeNull();
  });
});

describe('views', () => {
  const vp = { left: 0, top: 0, width: 1000, height: 800 };

  it('fits a rect inside margins and maps layout to screen', () => {
    const r = { x: 0, y: 0, w: 2000, h: 1000 };
    const m = { left: 100, right: 0, top: 50, bottom: 0 };
    const v = fitView(r, vp, m);
    expect(v.scale).toBeCloseTo(0.45, 9);
    const t = viewTransform(v, vp);
    // The rect's left edge sits at the left margin.
    expect(t.tx + r.x * t.s).toBeCloseTo(100, 6);
    const back = screenToLayout(v, vp, t.tx + 123 * t.s, t.ty + 45 * t.s);
    expect(back.x).toBeCloseTo(123, 9);
    expect(back.y).toBeCloseTo(45, 9);
  });

  it('shows one card large with its neighbours (or dashed cards) peeking in', () => {
    const r = { x: 0, y: 0, w: CARD_W, h: CARD_H };
    const v = cardView(r, vp);
    const region = cardRegion(r);
    expect(region.w).toBeGreaterThan(CARD_W + GAP);
    expect(region.h).toBeGreaterThan(CARD_H + GAP);
    expect(CARD_H * v.scale).toBeGreaterThan(800 * 0.6);
    // The whole card and the start of the dashed "+ Strategy" card are on screen.
    const g = gridLayout(1, 1);
    const t = viewTransform(v, vp);
    expect(t.tx).toBeGreaterThanOrEqual(0);
    expect(t.ty).toBeGreaterThanOrEqual(0);
    expect(t.tx + (g.dashedCol.x + 40) * t.s).toBeLessThan(vp.width);
    expect(t.ty + (g.dashedRow.y + 40) * t.s).toBeLessThan(vp.height);
  });

  it('gives phones a compact card view that keeps the card clear of the toolbar', () => {
    const r = cellRect(gridLayout(1, 1), 0, 0);
    const vp = { left: 0, top: 0, width: 390, height: 460 };
    const v = cardView(r, vp);
    const t = viewTransform(v, vp);
    // Wider than the desktop layout would make it, and still with a peek at the "+ Strategy" card.
    expect(CARD_W * v.scale).toBeGreaterThan(260);
    expect(t.tx).toBeGreaterThanOrEqual(0);
    expect(t.tx + CARD_W * t.s).toBeLessThan(vp.width);
    expect(t.tx + (CARD_W + GAP) * t.s).toBeLessThan(vp.width);
    // The card's bottom sits above the toolbar reserve.
    expect(t.ty + CARD_H * t.s).toBeLessThanOrEqual(vp.height - CARD_TOOLBAR_H + 1);
    expect(cardRegion(r, true).w).toBeLessThan(cardRegion(r).w);
  });

  it('interpolates centres linearly and scales geometrically', () => {
    const a = { cx: 0, cy: 0, scale: 1 }, b = { cx: 100, cy: 50, scale: 4 };
    const m = lerpView(a, b, 0.5);
    expect(m.cx).toBe(50);
    expect(m.scale).toBeCloseTo(2, 9);
    expect(lerpView(a, b, 2)).toEqual(b);
  });

  it('knows what is on screen', () => {
    const v = { cx: 500, cy: 400, scale: 1 };
    expect(rectVisible({ x: 0, y: 0, w: 10, h: 10 }, v, vp)).toBe(true);
    expect(rectVisible({ x: 2000, y: 0, w: 10, h: 10 }, v, vp)).toBe(false);
    expect(rectVisible({ x: 1010, y: 0, w: 10, h: 10 }, v, vp, 20)).toBe(true);
  });
});

describe('level of detail', () => {
  it('shrinks cards to chips and then to micro swatches', () => {
    expect(lodFor(400)).toBe('full');
    expect(lodFor(120)).toBe('chip');
    expect(lodFor(20)).toBe('micro');
  });

  it('has hysteresis at the thresholds', () => {
    expect(lodFor(195, 'full')).toBe('full');
    expect(lodFor(195, null)).toBe('chip');
    expect(lodFor(205, 'chip')).toBe('chip');
    expect(lodFor(215, 'chip')).toBe('full');
    expect(lodFor(60, 'micro')).toBe('micro');
    expect(lodFor(50, 'chip')).toBe('chip');
  });

  it('keeps chips readable up to an 8 × 8 atlas on a laptop screen', () => {
    const g = gridLayout(8, 8);
    const v = fitView(g.bounds, { left: 0, top: 0, width: 1280, height: 800 }, { left: 156, right: 28, top: 84, bottom: 64 });
    expect(lodFor(CARD_H * v.scale)).toBe('chip');
  });

  it('picks texture resolution buckets', () => {
    expect(resolutionBucket(10)).toBe(96);
    expect(resolutionBucket(500)).toBe(512);
    expect(resolutionBucket(99999)).toBe(1536);
  });
});
