import { describe, expect, it } from 'vitest';
import { atlasFrame, dipLevel, dipStep, fadeToward, MAX_TILT, planeSlide, smoothstep, stackFrame, STACK_PLANES, type DipState } from './choreo';

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

describe('reduced-motion dip', () => {
  const run = (from: DipState, z: number) => {
    let s = from;
    let t = 0;
    while (t < 1000 && !(s.level === dipLevel(z) && s.alpha === 1)) {
      s = dipStep(s, dipLevel(z), 16);
      t += 16;
    }
    return { s, t };
  };

  it('maps z to the level shown', () => {
    expect(dipLevel(1)).toBe(1);
    expect(dipLevel(1.49)).toBe(1);
    expect(dipLevel(1.5)).toBe(2);
    expect(dipLevel(2.6)).toBe(3);
  });

  it('fades the card in from the tree without a fade-out', () => {
    const s1 = dipStep({ level: 1, alpha: 1 }, 2, 16);
    expect(s1).toEqual({ level: 2, alpha: 0 });
    const { s, t } = run({ level: 1, alpha: 1 }, 2);
    expect(s).toEqual({ level: 2, alpha: 1 });
    expect(t).toBeLessThanOrEqual(200);
  });

  it('dips out and back in between card and atlas within 200 ms, switching the view only when invisible', () => {
    let s: DipState = { level: 2, alpha: 1 };
    let t = 0;
    let switchedAt = -1;
    while (!(s.level === 3 && s.alpha === 1)) {
      const next = dipStep(s, 3, 10);
      if (next.level !== s.level) {
        expect(s.alpha === 0 || next.alpha === 0).toBe(true);
        switchedAt = t;
      }
      s = next;
      t += 10;
      expect(t).toBeLessThan(400);
    }
    expect(switchedAt).toBeGreaterThan(0);
    expect(t).toBeLessThanOrEqual(200);
  });

  it('reverses mid-dip', () => {
    let s: DipState = { level: 2, alpha: 1 };
    s = dipStep(s, 3, 40);
    expect(s.level).toBe(2);
    expect(s.alpha).toBeLessThan(1);
    s = dipStep(s, 2, 40);
    expect(s.level).toBe(2);
    expect(s.alpha).toBeGreaterThan(0.5);
  });
});
