// Growth animation schedule and reveal order (pure).
//
// After the Game → Tree transition the strategy's games stream in around the
// trunk: games that stay with the trunk longest come first; the first five
// draw one at a time (about 500 ms each, words readable); then the reveal rate
// doubles every second until all R games are in, capped at about 6 s in total.
// Compute and reveal are decoupled: the clock stalls while the run has not yet
// produced the games the schedule wants.

export type GrowthMode = 'full' | 'fast' | 'off';

export interface GrowthTiming {
  /** Games drawn one at a time at the start. */
  firstCount: number;
  /** Time per game during the one-at-a-time phase (ms). */
  firstMs: number;
  /** Total duration cap (ms). */
  capMs: number;
  /** Minimum reveal rate right after the first games (games/s); it doubles every second. */
  minRate: number;
  /** Draw-on time of the first games' new segments, and of later games (ms). */
  drawFirstMs: number;
  drawLaterMs: number;
}

export function growthTiming(mode: GrowthMode): GrowthTiming | null {
  if (mode === 'off') return null;
  if (mode === 'fast') return { firstCount: 5, firstMs: 150, capMs: 2000, minRate: 6, drawFirstMs: 140, drawLaterMs: 120 };
  return { firstCount: 5, firstMs: 500, capMs: 6000, minRate: 2, drawFirstMs: 460, drawLaterMs: 260 };
}

/** Initial rate after the one-at-a-time phase, so that `rest` games fit before the cap. */
export function rampRate(rest: number, timing: GrowthTiming): number {
  const t1 = timing.firstCount * timing.firstMs;
  const tb = Math.max(0.05, (timing.capMs - t1) / 1000);
  return Math.max(timing.minRate, (rest * Math.LN2) / (Math.pow(2, tb) - 1));
}

/** Number of games whose reveal has started by time t (ms since growth started). */
export function revealCount(t: number, total: number, timing: GrowthTiming): number {
  if (total <= 0 || t < 0) return 0;
  const nFirst = Math.min(timing.firstCount, total);
  const t1 = nFirst * timing.firstMs;
  if (t < t1) return Math.min(nFirst, Math.floor(t / timing.firstMs) + 1);
  const rest = total - nFirst;
  if (rest <= 0) return total;
  const r0 = rampRate(rest, timing);
  const u = (t - t1) / 1000;
  const n = nFirst + Math.floor((r0 * (Math.pow(2, u) - 1)) / Math.LN2 + 1e-9);
  return Math.min(total, n);
}

/** When the last game starts to reveal (ms), for `total` games. */
export function growthDuration(total: number, timing: GrowthTiming): number {
  if (total <= 0) return 0;
  const nFirst = Math.min(timing.firstCount, total);
  const t1 = nFirst * timing.firstMs;
  const rest = total - nFirst;
  if (rest <= 0) return (nFirst - 1) * timing.firstMs;
  const r0 = rampRate(rest, timing);
  return t1 + 1000 * Math.log2(1 + (rest * Math.LN2) / r0);
}

/** Draw-on time for the i-th revealed game (0-based). */
export function drawTime(i: number, timing: GrowthTiming): number {
  return i < timing.firstCount ? timing.drawFirstMs : timing.drawLaterMs;
}

/**
 * Advance the growth clock by dt unless the schedule wants more games than
 * have been computed (and the run is still going): then the clock stalls.
 */
export function advanceClock(clock: number, dt: number, total: number, available: number, done: boolean, timing: GrowthTiming): { clock: number; stalled: boolean } {
  const wanted = revealCount(clock + dt, total, timing);
  if (done || wanted <= available) return { clock: clock + dt, stalled: false };
  // Move up to the last moment the schedule needs no more than the games computed so far.
  let lo = clock;
  let hi = clock + dt;
  if (revealCount(lo, total, timing) > available) return { clock, stalled: true };
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (revealCount(mid, total, timing) <= available) lo = mid;
    else hi = mid;
  }
  return { clock: lo, stalled: true };
}

export interface GrowthClock {
  /** ms of schedule time elapsed. */
  clock: number;
  /** Games revealed during the one-at-a-time phase that added nothing new (they take no slot). */
  skipped: number;
  /** Waiting for compute. */
  stalled: boolean;
}

/**
 * Advance the growth by dt and reveal the games the schedule wants.
 * `reveal(first)` reveals the next computed game (first: during the
 * one-at-a-time phase) and returns how many nodes it put on screen for the
 * first time, or null when no computed game is waiting. A one-at-a-time slot
 * is only spent on a game that adds something to the picture: one that
 * retraces paths already shown (the trunk, at first) is revealed at once and
 * the schedule moves on. Returns the number of games revealed so far.
 */
export function growthStep(
  st: GrowthClock,
  dt: number,
  total: number,
  count: number,
  available: number,
  done: boolean,
  timing: GrowthTiming,
  reveal: (first: boolean) => number | null,
): number {
  const slots = () => Math.max(1, total - st.skipped);
  const res = advanceClock(st.clock, dt, slots(), Math.max(0, available - st.skipped), done, timing);
  st.clock = res.clock;
  st.stalled = res.stalled;
  let want = revealCount(st.clock, slots(), timing) + st.skipped;
  while (count < Math.min(want, total)) {
    const first = count - st.skipped < timing.firstCount;
    const fresh = reveal(first);
    if (fresh === null) break;
    count++;
    if (first && fresh === 0 && count < total) {
      st.skipped++;
      want = revealCount(st.clock, slots(), timing) + st.skipped;
    }
  }
  return count;
}

/**
 * Reveal queue: games bucketed by priority (higher first), first in first out
 * within a bucket. Priority is how long the game stays with the trunk: the
 * depth of the deepest trunk node on its path.
 */
export class RevealQueue<T> {
  private buckets: T[][] = [];
  private heads: number[] = [];
  private n = 0;

  push(item: T, priority: number): void {
    const p = Math.max(0, Math.floor(priority));
    while (this.buckets.length <= p) {
      this.buckets.push([]);
      this.heads.push(0);
    }
    this.buckets[p].push(item);
    this.n++;
  }

  pop(): T | undefined {
    for (let p = this.buckets.length - 1; p >= 0; p--) {
      const b = this.buckets[p];
      if (this.heads[p] < b.length) {
        const item = b[this.heads[p]++];
        this.n--;
        if (this.heads[p] > 64 && this.heads[p] * 2 > b.length) {
          b.splice(0, this.heads[p]);
          this.heads[p] = 0;
        }
        return item;
      }
    }
    return undefined;
  }

  get size(): number {
    return this.n;
  }

  clear(): void {
    this.buckets = [];
    this.heads = [];
    this.n = 0;
  }
}

/** Depth of the deepest trunk node on a path (the path's nodes from the first guess, and the trunk's). */
export function sharedDepth(pathGuesses: readonly number[], trunkGuesses: readonly number[]): number {
  let d = 0;
  while (d < pathGuesses.length && d < trunkGuesses.length && pathGuesses[d] === trunkGuesses[d]) d++;
  return d;
}
