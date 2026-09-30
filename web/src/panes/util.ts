// Small pure helpers shared by the panes and the Lab.

/** Cells of a feedback code: 0 absent, 1 present, 2 correct (position i = digit i in base 3). */
export function cellsOf(code: number, len: number): number[] {
  const out: number[] = [];
  let c = code;
  for (let i = 0; i < len; i++) {
    out.push(c % 3);
    c = Math.floor(c / 3);
  }
  return out;
}

export const CELL_NAMES = ['absent', 'present', 'correct'] as const;

/** Accessible description of a guess and its feedback, e.g. "CRANE: C absent, R present, …". */
export function describeGuess(word: string, code: number): string {
  const cells = cellsOf(code, word.length);
  return `${word.toUpperCase()}: ${[...word].map((l, i) => `${l.toUpperCase()} ${CELL_NAMES[cells[i]]}`).join(', ')}`;
}

const intFmt = new Intl.NumberFormat('en-GB');
export function fmtInt(n: number): string {
  return Number.isFinite(n) ? intFmt.format(Math.round(n)) : '–';
}

export function fmtPct(x: number, digits = 1): string {
  if (!Number.isFinite(x)) return '–';
  return (x * 100).toFixed(digits) + '%';
}

export function fmtNum(x: number, digits = 2): string {
  return Number.isFinite(x) ? x.toFixed(digits) : '–';
}

/** Probability as a percentage with sensible precision for tiny values. */
export function fmtProb(p: number): string {
  if (!Number.isFinite(p)) return '–';
  if (p >= 0.1) return (p * 100).toFixed(0) + '%';
  if (p >= 0.01) return (p * 100).toFixed(1) + '%';
  if (p > 0) return (p * 100).toPrecision(2) + '%';
  return '0%';
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Deterministic PRNG (mulberry32) for stable random orders. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Outcome row labels: "1".."max", then "X". */
export function outcomeLabels(maxGuesses: number): string[] {
  return [...Array.from({ length: maxGuesses }, (_, i) => String(i + 1)), 'X'];
}

/** Safe call of a function that may still be a throwing stub. */
export function attempt<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
