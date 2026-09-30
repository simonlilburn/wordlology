// Arranging the atlas grid (pure): moving columns/rows and sorting openers.

/** A copy of `items` with the element at `from` moved to index `to`. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const out = items.slice();
  if (from < 0 || from >= out.length) return out;
  const t = Math.max(0, Math.min(out.length - 1, to));
  const [x] = out.splice(from, 1);
  out.splice(t, 0, x);
  return out;
}

/**
 * Rows sorted by ascending mean (best first); rows without a mean keep their
 * relative order after the others. `means[i]` belongs to `rows[i]`.
 */
export function sortByMean<T>(rows: readonly T[], means: readonly number[]): T[] {
  const idx = rows.map((_, i) => i);
  idx.sort((a, b) => {
    const ma = means[a], mb = means[b];
    const fa = Number.isFinite(ma), fb = Number.isFinite(mb);
    if (fa && fb) return ma - mb || a - b;
    if (fa) return -1;
    if (fb) return 1;
    return a - b;
  });
  return idx.map((i) => rows[i]);
}

/** Index a dragged header lands on, from its centre offset in layout units. */
export function dropIndex(from: number, delta: number, pitch: number, count: number): number {
  return Math.max(0, Math.min(count - 1, from + Math.round(delta / pitch)));
}

/** Mean of the finite values (NaN if none). */
export function meanOf(values: readonly number[]): number {
  let s = 0, n = 0;
  for (const v of values) if (Number.isFinite(v)) {
    s += v;
    n++;
  }
  return n > 0 ? s / n : NaN;
}
