// The density ghost: every game's path drawn at very low opacity on a
// persistent density grid, so a card shows where its games flow. Paths share
// one layout (the stack planes of the Tree → Card transition use it too), so
// the superimposed trees add up to exactly this ghost.
//
// Layout of a path: guess 1 (the opener) sits at the centre of the first row;
// each later guess moves sideways by an offset keyed on the feedback that led
// to it, so games that received the same feedback travel together. Better
// feedback (more greens and yellows) stays nearer the centre.

export interface PathTurn {
  guess: number;
  pattern: number;
}

const SPREADS = [0, 0.4, 0.2, 0.11, 0.06, 0.035, 0.02, 0.012, 0.008, 0.005];

function hash32(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** 0..1 closeness score of a feedback pattern (all correct = 1). */
export function patternScore(pattern: number, wordLength: number): number {
  let p = pattern;
  let score = 0;
  for (let i = 0; i < wordLength; i++) {
    const c = p % 3;
    p = (p - c) / 3;
    score += c;
  }
  return wordLength > 0 ? score / (2 * wordLength) : 0;
}

/**
 * Horizontal positions (0..1) of a game's nodes: one per guess, plus a final
 * point in the Out row for a failed game. Row of point i is i (Out = maxGuesses).
 */
export function pathXs(turns: PathTurn[], solved: boolean, maxGuesses: number, wordLength: number): number[] {
  const xs: number[] = [];
  let x = 0.5;
  for (let d = 0; d < turns.length && d < maxGuesses; d++) {
    if (d > 0) {
      const prev = turns[d - 1];
      const h = hash32(prev.pattern + 7919 * d, turns[d].guess);
      const side = hash32(prev.pattern, d) & 1 ? 1 : -1;
      const closeness = patternScore(prev.pattern, wordLength);
      const spread = SPREADS[Math.min(d, SPREADS.length - 1)];
      const mag = spread * (0.12 + 0.88 * (1 - closeness)) * (0.55 + 0.45 * ((h & 0xffff) / 0xffff));
      x = Math.max(0.02, Math.min(0.98, x + side * mag));
    }
    xs.push(x);
  }
  if (!solved && xs.length > 0) xs.push(xs[xs.length - 1]);
  return xs;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/**
 * Points along a path in unit coordinates (x 0..1 across, y 0..1 down the rows
 * region), sampled densely enough for a grid `cols` wide and `rowsPx` tall.
 * Calls `emit(x, y)` for each sample; returns the sample count.
 */
export function tracePath(
  xs: number[],
  nRows: number,
  cols: number,
  rowsPx: number,
  emit: (x: number, y: number) => void,
): number {
  if (xs.length === 0) return 0;
  const rowH = 1 / nRows;
  let count = 0;
  // Lead-in from the top edge to the opener.
  const y0 = 0.5 * rowH;
  const leadSteps = Math.max(1, Math.ceil(y0 * rowsPx));
  for (let s = 0; s < leadSteps; s++) {
    emit(xs[0], (s / leadSteps) * y0);
    count++;
  }
  for (let i = 0; i + 1 < xs.length; i++) {
    const xa = xs[i], xb = xs[i + 1];
    const ya = (i + 0.5) * rowH, yb = (i + 1.5) * rowH;
    const len = Math.max(Math.abs(xb - xa) * cols, (yb - ya) * rowsPx);
    const steps = Math.max(1, Math.ceil(len));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      emit(xa + (xb - xa) * smooth(t), ya + (yb - ya) * t);
      count++;
    }
  }
  const last = xs.length - 1;
  emit(xs[last], (last + 0.5) * rowH);
  return count + 1;
}

/** A persistent density grid; games are added once, as they arrive. */
export class DensityGrid {
  data: Float32Array;
  max = 0;
  games = 0;
  version = 0;
  constructor(
    public cols: number,
    public rowsPx: number,
    public nRows: number,
  ) {
    this.data = new Float32Array(cols * rowsPx);
  }

  clear(): void {
    this.data.fill(0);
    this.max = 0;
    this.games = 0;
    this.version++;
  }

  /** Add one game's path with weight w. */
  addPath(xs: number[], w = 1): void {
    const { cols, rowsPx, data } = this;
    let lastCell = -1;
    let max = this.max;
    const deposit = (x: number, y: number, weight: number) => {
      const cx = Math.min(cols - 1, Math.max(0, Math.floor(x * cols)));
      const cy = Math.min(rowsPx - 1, Math.max(0, Math.floor(y * rowsPx)));
      const c = cy * cols + cx;
      if (c === lastCell) return;
      lastCell = c;
      const v = (data[c] += weight);
      if (v > max) max = v;
    };
    tracePath(xs, this.nRows, cols, rowsPx, (x, y) => deposit(x, y, w));
    // A small end mark where the game stops.
    if (xs.length > 0) {
      const last = xs.length - 1;
      const ex = xs[last];
      const ey = (last + 0.5) / this.nRows;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        lastCell = -1;
        deposit(ex + dx / cols, ey + dy / rowsPx, w * 0.5);
      }
    }
    this.max = max;
    this.games++;
    this.version++;
  }

  /**
   * Render to RGBA pixels: opacity grows with the square root of density, so
   * single paths stay faint while the main streams show where games flow.
   */
  toRgba(rgb: [number, number, number], maxAlpha: number, out?: Uint8ClampedArray): Uint8ClampedArray {
    const n = this.data.length;
    const px = out && out.length === n * 4 ? out : new Uint8ClampedArray(n * 4);
    const inv = 1 / Math.sqrt(Math.max(1e-9, this.max));
    const a255 = maxAlpha * 255;
    const floor = Math.min(a255, 8);
    const [r, g, b] = rgb;
    for (let i = 0; i < n; i++) {
      const v = this.data[i];
      const j = i * 4;
      px[j] = r;
      px[j + 1] = g;
      px[j + 2] = b;
      px[j + 3] = v > 0 ? Math.max(floor, Math.sqrt(v) * inv * a255) : 0;
    }
    return px;
  }
}
