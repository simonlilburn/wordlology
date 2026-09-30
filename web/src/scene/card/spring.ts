// Critically damped springs: shading, bars and numbers on a card ease toward
// each new estimate over about 300 ms without overshoot, whatever the frame rate
// (the step is the exact solution, so large dt stays stable).

/** Angular frequency for which a spring starting at rest is within `tol` of its target after `ms`. */
export function omegaForSettle(ms: number, tol = 0.02): number {
  // Solve (1 + w t) e^{-w t} = tol for x = w t by Newton's method.
  let x = 5;
  for (let i = 0; i < 30; i++) {
    const f = (1 + x) * Math.exp(-x) - tol;
    const df = -x * Math.exp(-x);
    const nx = x - f / df;
    if (Math.abs(nx - x) < 1e-10) {
      x = nx;
      break;
    }
    x = nx;
  }
  return x / (ms / 1000);
}

export const CARD_OMEGA = omegaForSettle(300);

/** Advance one critically damped spring by dt seconds. Returns [x, v]. */
export function springStep(x: number, v: number, target: number, dt: number, omega = CARD_OMEGA): [number, number] {
  if (!(dt > 0)) return [x, v];
  const e0 = x - target;
  const decay = Math.exp(-omega * dt);
  const c = v + omega * e0;
  const e = (e0 + c * dt) * decay;
  const nv = (v - omega * c * dt) * decay;
  return [target + e, nv];
}

/** A vector of springs sharing one frequency. */
export class SpringArray {
  x: Float64Array;
  v: Float64Array;
  target: Float64Array;
  constructor(n: number, public omega = CARD_OMEGA) {
    this.x = new Float64Array(n);
    this.v = new Float64Array(n);
    this.target = new Float64Array(n);
  }
  get length(): number {
    return this.x.length;
  }
  /** Set targets; with `snap` the values jump there (first display). */
  set(values: ArrayLike<number>, snap = false): void {
    for (let i = 0; i < this.x.length; i++) {
      const t = i < values.length ? values[i] : 0;
      this.target[i] = Number.isFinite(t) ? t : 0;
      if (snap) {
        this.x[i] = this.target[i];
        this.v[i] = 0;
      }
    }
  }
  /** Jump the springs at `indices` to their targets. */
  snap(indices: Iterable<number>): void {
    for (const i of indices) {
      if (i < 0 || i >= this.x.length) continue;
      this.x[i] = this.target[i];
      this.v[i] = 0;
    }
  }
  /** Step every spring; returns true while any is still moving visibly. */
  step(dt: number, epsilon = 1e-4): boolean {
    let moving = false;
    for (let i = 0; i < this.x.length; i++) {
      const [nx, nv] = springStep(this.x[i], this.v[i], this.target[i], dt, this.omega);
      if (Math.abs(nx - this.target[i]) < epsilon && Math.abs(nv) < epsilon * this.omega) {
        this.x[i] = this.target[i];
        this.v[i] = 0;
      } else {
        this.x[i] = nx;
        this.v[i] = nv;
        moving = true;
      }
    }
    return moving;
  }
  settled(epsilon = 1e-4): boolean {
    for (let i = 0; i < this.x.length; i++) {
      if (Math.abs(this.x[i] - this.target[i]) >= epsilon || this.v[i] !== 0) return false;
    }
    return true;
  }
}
