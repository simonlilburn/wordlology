// Histogram of per-target differences in mean guesses (A − B) for compare mode.

export interface DiffHistogram {
  /** Bin edges (length bins + 1). */
  edges: number[];
  counts: number[];
  /** Index of the bin containing 0. */
  zeroBin: number;
  binWidth: number;
  n: number;
  max: number;
}

function isIntegerData(values: number[]): boolean {
  for (const v of values) if (Math.abs(v - Math.round(v)) > 1e-9) return false;
  return true;
}

/**
 * Bin finite differences. Integer data (two deterministic cards) gets one bin
 * per integer; otherwise a "nice" width near the Freedman–Diaconis choice.
 * Bins are aligned so 0 is a bin centre, making ties one bar.
 */
export function binDiffs(diffs: ArrayLike<number>, maxBins = 41): DiffHistogram {
  const vals: number[] = [];
  for (let i = 0; i < diffs.length; i++) if (Number.isFinite(diffs[i])) vals.push(diffs[i]);
  if (vals.length === 0) return { edges: [-0.5, 0.5], counts: [0], zeroBin: 0, binWidth: 1, n: 0, max: 0 };
  vals.sort((a, b) => a - b);
  const lo = vals[0], hi = vals[vals.length - 1];
  let width: number;
  if (isIntegerData(vals)) {
    width = 1;
  } else {
    const q = (p: number) => vals[Math.min(vals.length - 1, Math.floor(p * (vals.length - 1)))];
    const iqr = q(0.75) - q(0.25);
    const fd = iqr > 0 ? (2 * iqr) / Math.cbrt(vals.length) : (hi - lo) / 10 || 0.1;
    width = niceStep(Math.max(fd, (hi - lo) / maxBins, 1e-6));
  }
  // Bins centred on multiples of width, so one bin is centred on 0.
  let first = Math.floor(lo / width + 0.5);
  let last = Math.floor(hi / width + 0.5);
  first = Math.min(first, 0);
  last = Math.max(last, 0);
  while (last - first + 1 > maxBins) {
    width = niceStep(width * 1.5);
    first = Math.min(0, Math.floor(lo / width + 0.5));
    last = Math.max(0, Math.floor(hi / width + 0.5));
  }
  const nb = last - first + 1;
  const counts = new Array(nb).fill(0);
  for (const v of vals) {
    const k = Math.floor(v / width + 0.5) - first;
    counts[Math.max(0, Math.min(nb - 1, k))]++;
  }
  const edges = Array.from({ length: nb + 1 }, (_, i) => (first + i - 0.5) * width);
  return { edges, counts, zeroBin: -first, binWidth: width, n: vals.length, max: Math.max(...counts) };
}

/** Round up to 1, 2, 2.5 or 5 × 10^k. */
export function niceStep(x: number): number {
  if (!(x > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / p;
  const nice = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
  return nice * p;
}

/** Wins, ties and losses for A from per-target differences (A − B; lower is better). */
export function winTieLoss(diffs: ArrayLike<number>, eps = 1e-9): { wins: number; ties: number; losses: number } {
  let wins = 0, ties = 0, losses = 0;
  for (let i = 0; i < diffs.length; i++) {
    const d = diffs[i];
    if (!Number.isFinite(d)) continue;
    if (d < -eps) wins++;
    else if (d > eps) losses++;
    else ties++;
  }
  return { wins, ties, losses };
}

/** Answer indices with the largest |diff|, largest first (ties by index). */
export function largestDiffs(diffs: ArrayLike<number>, k: number): number[] {
  const idx: number[] = [];
  for (let i = 0; i < diffs.length; i++) if (Number.isFinite(diffs[i]) && diffs[i] !== 0) idx.push(i);
  idx.sort((a, b) => Math.abs(diffs[b]) - Math.abs(diffs[a]) || a - b);
  return idx.slice(0, k);
}
