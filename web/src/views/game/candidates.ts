// Candidate sets and per-turn statistics for replay annotations, computed on
// the main thread by filtering the answers for feedback consistency.

export type FeedbackFn = (guess: string, target: string) => number;

/** Answers (as words) consistent with every row of the history. */
export function consistentAnswers(answers: string[], history: { word: string; pattern: number }[], feedback: FeedbackFn): string[] {
  let cands = answers;
  for (const row of history) cands = cands.filter((t) => feedback(row.word, t) === row.pattern);
  return cands;
}

/** Expected information (bits) of a guess over a candidate set: the entropy of its feedback partition. */
export function expectedBits(guess: string, candidates: string[], feedback: FeedbackFn): number {
  const n = candidates.length;
  if (n <= 1) return 0;
  const counts = new Map<number, number>();
  for (const t of candidates) {
    const p = feedback(guess, t);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  let h = 0;
  for (const c of counts.values()) {
    const q = c / n;
    h -= q * Math.log2(q);
  }
  return h;
}

export interface TurnStats {
  /** Candidates before and after this guess. */
  before: number;
  after: number;
  bitsExpected: number;
  /** log2(before / after); after is at least 1 for a consistent history. */
  bitsObserved: number;
  /** Whether the guess was still a candidate. */
  isCandidate: boolean;
}

/**
 * Statistics for each turn of a history, plus the candidate list remaining
 * after each turn (index i = after turn i).
 */
export function turnStats(
  answers: string[],
  history: { word: string; pattern: number }[],
  feedback: FeedbackFn,
): { stats: TurnStats[]; remaining: string[][] } {
  const stats: TurnStats[] = [];
  const remaining: string[][] = [];
  let cands = answers;
  for (const row of history) {
    const next = cands.filter((t) => feedback(row.word, t) === row.pattern);
    const before = cands.length;
    const after = next.length;
    stats.push({
      before,
      after,
      bitsExpected: expectedBits(row.word, cands, feedback),
      bitsObserved: after > 0 && before > 0 ? Math.log2(before / after) : 0,
      isCandidate: cands.includes(row.word),
    });
    remaining.push(next);
    cands = next;
  }
  return { stats, remaining };
}

/** Format bits for the narrow annotation column. */
export function fmtBits(b: number): string {
  return b >= 10 ? b.toFixed(1) : b.toFixed(2);
}

/** Format a probability as a short percentage ("12%", "0.4%", "<0.1%", "100%"). */
export function fmtProb(p: number): string {
  if (!Number.isFinite(p)) return '—';
  if (p >= 0.995) return '100%';
  if (p >= 0.1) return `${Math.round(p * 100)}%`;
  if (p >= 0.001) return `${(p * 100).toFixed(1)}%`;
  if (p > 0) return '<0.1%';
  return '0%';
}

const nf = new Intl.NumberFormat('en');
export function fmtCount(n: number): string {
  return nf.format(n);
}
