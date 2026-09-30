import { describe, expect, it } from 'vitest';
import { atlasFrame, fadeToward, MAX_TILT, planeSlide, smoothstep, stackFrame, STACK_PLANES } from './choreo';

describe('Tree → Card choreography', () => {
  it('starts at the tree and ends face-on at the card', () => {
    const a = stackFrame(0);
    expect(a.viewT).toBe(0);
    expect(a.tilt).toBe(0);
    expect(a.spread).toBe(0);
    expect(a.faceAlpha).toBe(0);
    expect(a.planesAlpha).toBe(0);
    expect(a.persp).toBe(false);
    const b = stackFrame(1);
    expect(b.viewT).toBe(1);
    expect(b.tilt).toBe(0);
    expect(b.spread).toBe(0);
    expect(b.pull).toBeCloseTo(1, 9);
    expect(b.faceAlpha).toBe(1);
    expect(b.ghostAlpha).toBe(1);
    expect(b.frameAlpha).toBe(1);
    expect(b.planesAlpha).toBe(0);
    expect(b.persp).toBe(false);
  });

  it('tilts about 30° and spreads the planes in the middle, using the perspective camera', () => {
    let maxTilt = 0;
    let perspFrames = 0;
    for (let i = 0; i <= 100; i++) {
      const f = stackFrame(i / 100);
      maxTilt = Math.max(maxTilt, f.tilt);
      if (f.persp) perspFrames++;
      expect(f.pull).toBeLessThanOrEqual(1 + 1e-9);
    }
    expect(maxTilt).toBeCloseTo(MAX_TILT, 6);
    expect(MAX_TILT).toBeCloseTo(Math.PI / 6, 9);
    expect(perspFrames).toBeGreaterThan(30);
    // The planes are gone and the camera face-on before the card is fully shown.
    const late = stackFrame(0.9);
    expect(late.tilt).toBe(0);
    expect(late.spread).toBe(0);
  });

  it('is a pure function of z, so reversing retraces the same frames', () => {
    expect(stackFrame(0.37)).toEqual(stackFrame(0.37));
    expect(stackFrame(-1)).toEqual(stackFrame(0));
    expect(stackFrame(2)).toEqual(stackFrame(1));
  });

  it('slides the planes in one after another', () => {
    expect(planeSlide(0, 0)).toBe(0);
    expect(planeSlide(1, STACK_PLANES - 1)).toBe(1);
    expect(planeSlide(0.2, 0)).toBeGreaterThan(planeSlide(0.2, 20));
  });
});

describe('Card → Atlas choreography', () => {
  it('pulls back from the card to the atlas and shows the dashed cards', () => {
    expect(atlasFrame(2).viewT).toBe(0);
    expect(atlasFrame(3).viewT).toBe(1);
    expect(atlasFrame(2.5).viewT).toBeCloseTo(0.5, 9);
    expect(atlasFrame(1.5).dashedAlpha).toBe(0);
    expect(atlasFrame(2.02).dashedAlpha).toBe(1);
    expect(atlasFrame(1).neighbourAlpha).toBe(0);
    expect(atlasFrame(3).headerAlpha).toBe(1);
  });
});

describe('reduced motion', () => {
  it('cross-fades within 200 ms', () => {
    let a = 0;
    let t = 0;
    while (a < 1) {
      a = fadeToward(a, 1, 16);
      t += 16;
    }
    expect(t).toBeLessThanOrEqual(200);
    expect(fadeToward(0.5, 0, 1000)).toBe(0);
    expect(fadeToward(0.3, 0.3, 16)).toBe(0.3);
  });

  it('has a clamped smoothstep', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
    expect(smoothstep(0, 1, 2)).toBe(1);
  });
});
