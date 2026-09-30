// Number formatting for card faces, ranking entries and tables. Provisional
// values (a card still filling) carry a leading "~" and one fewer digit.

const nf = new Intl.NumberFormat('en-US');

export function fmtInt(n: number): string {
  return Number.isFinite(n) ? nf.format(Math.round(n)) : '–';
}

/** Round to `sig` significant digits (at least 1). */
export function roundSig(n: number, sig: number): number {
  if (!Number.isFinite(n) || n === 0) return n;
  const s = Math.max(1, sig);
  const mag = Math.floor(Math.log10(Math.abs(n)));
  const f = Math.pow(10, mag - s + 1);
  return Math.round(n / f) * f;
}

/** A game count; provisional counts drop their last significant digit. */
export function fmtCount(n: number, provisional = false): string {
  if (!Number.isFinite(n)) return '–';
  const r = Math.round(n);
  if (!provisional) return fmtInt(r);
  if (r === 0) return '~0';
  const digits = String(Math.abs(r)).length;
  return '~' + fmtInt(roundSig(r, Math.max(1, digits - 1)));
}

/** A share as a percentage: "34.2%" when final, "~34%" while provisional. */
export function fmtPercent(share: number, provisional = false): string {
  if (!Number.isFinite(share)) return '–';
  const p = share * 100;
  if (provisional) {
    if (p > 0 && p < 0.5) return '<1%';
    return '~' + Math.round(p) + '%';
  }
  if (p > 0 && p < 0.05) return '<0.1%';
  return (Math.round(p * 10) / 10).toFixed(1) + '%';
}

/** Mean guesses: "3.62 ± 0.01" (stochastic, final), "3.62", or "~3.6". */
export function fmtMean(mean: number, se: number | null = null, provisional = false): string {
  if (!Number.isFinite(mean)) return '–';
  if (provisional) return '~' + mean.toFixed(1);
  const m = mean.toFixed(2);
  return se !== null && Number.isFinite(se) ? `${m} ± ${fmtSe(se)}` : m;
}

/** Standard error with enough digits to be non-zero (at most 3 decimals). */
export function fmtSe(se: number): string {
  if (se >= 0.005 || se === 0) return se.toFixed(2);
  return se.toFixed(3);
}

/** A guess count quantile; values above max guesses read "X". */
export function fmtQuantile(k: number, maxGuesses: number, provisional = false): string {
  if (!Number.isFinite(k)) return '–';
  const v = Math.round(k);
  const s = v > maxGuesses ? 'X' : String(v);
  return provisional ? '~' + s : s;
}

export function rowName(i: number, maxGuesses: number): string {
  return i < maxGuesses ? String(i + 1) : 'Out';
}

export function rowLongName(i: number, maxGuesses: number): string {
  return i < maxGuesses ? `Guess ${i + 1}` : 'Out';
}

/** Progress line text on a filling card. */
export function progressText(p: {
  deterministic: boolean;
  nTargetsDone: number;
  nTargets: number;
  nGames: number;
  expectedGames: number;
  settledDepth?: number;
}): string {
  if (p.deterministic) {
    const depth = p.settledDepth !== undefined && p.settledDepth > 0 ? ` · settled to guess ${p.settledDepth}` : '';
    return `resolving · ${fmtInt(p.nTargetsDone)} / ${fmtInt(p.nTargets)} targets${depth}`;
  }
  if (p.nTargetsDone < p.nTargets || p.expectedGames <= p.nTargets) {
    return `estimate · ${fmtInt(p.nTargetsDone)} / ${fmtInt(p.nTargets)} targets`;
  }
  return `estimate · ${fmtInt(p.nGames)} / ${fmtInt(p.expectedGames)} games`;
}
