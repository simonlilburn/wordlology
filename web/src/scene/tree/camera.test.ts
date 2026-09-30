import { describe, expect, it } from 'vitest';
import { approachViewport, expectedViewport, fitCamera, fitScale, layoutScale, occlusionOf, zoomAt } from './camera';

describe('tree camera', () => {
  const vp = { left: 0, top: 200, width: 900, height: 600 };

  it('fits the tree with the trunk centred and never above scale 1', () => {
    const b = { minX: -900, maxX: 300, top: 30, bottom: -500 };
    const s = fitScale(b, vp);
    expect(s).toBeCloseTo((450 - 16) / 900);
    expect(fitCamera(b, vp).cx).toBe(0);
    expect(fitScale({ minX: -10, maxX: 10, top: 10, bottom: -10 }, vp)).toBe(1);
  });

  it('zooms about a point and reports what did not fit below the minimum', () => {
    const c = { cx: 0, cy: 0, s: 1 };
    const { cam, rest } = zoomAt(c, vp, 0.25, 450, 500, 0.5);
    expect(cam.s).toBe(0.5);
    expect(rest).toBeCloseTo(0.5);
  });

  it('quantises the layout scale in half octaves, never below 1', () => {
    expect(layoutScale(0.4)).toBe(1);
    expect(layoutScale(1.3)).toBe(1);
    expect(layoutScale(1.5)).toBeCloseTo(Math.SQRT2);
    expect(layoutScale(2.1)).toBe(2);
  });
});

describe('viewport during the Game → Tree zoom', () => {
  it('lays out for the cover expected at the Tree level before the panes arrive', () => {
    const W = 1280;
    const H = 800;
    const atTree = { left: 0, top: 212, width: 940, height: 588 };
    const arrival = occlusionOf(atTree, W, H);
    expect(arrival).toEqual({ top: 212, right: 340, bottom: 0 });
    const early = expectedViewport({ left: 0, top: 0, width: W, height: H }, W, H, arrival);
    expect(early).toEqual(atTree);
    // A pane that covers more now than at the last arrival still counts.
    const more = expectedViewport({ left: 0, top: 0, width: 800, height: 600 }, W, H, arrival);
    expect(more.width).toBe(800);
    expect(more.height).toBe(588 - 200);
    expect(expectedViewport(atTree, W, H, null)).toEqual(atTree);
  });

  it('eases a viewport change instead of jumping', () => {
    const v = { left: 0, top: 0, width: 1280, height: 800 };
    const t = { left: 0, top: 212, width: 940, height: 588 };
    expect(approachViewport(v, t, 16)).toBe(false);
    expect(v.top).toBeGreaterThan(0);
    expect(v.top).toBeLessThan(212);
    for (let i = 0; i < 100; i++) approachViewport(v, t, 16);
    expect(v).toEqual(t);
  });
});
