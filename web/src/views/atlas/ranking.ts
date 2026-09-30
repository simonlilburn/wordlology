// Ranking panel helpers (pure): reorder throttling, tie brackets, CSV.

import type { Ranking, RankingEntry, RankMetric } from '../../model/rankings';

/**
 * Keeps a displayed order that changes at most once per interval, so a list
 * whose estimates move stays readable. New entries are appended at once and
 * removed ones dropped at once; only reordering waits.
 */
export class ReorderThrottle {
  order: string[] = [];
  private lastChange = -Infinity;
  constructor(public intervalMs = 500) {}

  /** Offer the latest ranked order; returns the order to show and how long until a pending reorder may apply. */
  offer(next: string[], now: number): { order: string[]; pendingMs: number } {
    const nextSet = new Set(next);
    const kept = this.order.filter((k) => nextSet.has(k));
    const keptSet = new Set(kept);
    const added = next.filter((k) => !keptSet.has(k));
    const merged = kept.concat(added);
    const sameAsNext = merged.length === next.length && merged.every((k, i) => k === next[i]);
    if (sameAsNext) {
      const sameAsShown = merged.length === this.order.length && merged.every((k, i) => k === this.order[i]);
      if (!sameAsShown) this.order = merged;
      return { order: this.order, pendingMs: 0 };
    }
    // A reorder is outstanding: apply it if the interval has passed.
    if (now - this.lastChange >= this.intervalMs) {
      this.order = next.slice();
      this.lastChange = now;
      return { order: this.order, pendingMs: 0 };
    }
    this.order = merged;
    return { order: this.order, pendingMs: Math.max(1, this.intervalMs - (now - this.lastChange)) };
  }
}

export type BracketPart = 'start' | 'mid' | 'end' | null;

/** Brackets for runs of adjacent entries in the same tie group ("tied within noise"). */
export function tieBrackets(groups: number[]): BracketPart[] {
  const out: BracketPart[] = groups.map(() => null);
  let i = 0;
  while (i < groups.length) {
    let j = i;
    if (groups[i] >= 0) while (j + 1 < groups.length && groups[j + 1] === groups[i]) j++;
    if (j > i) {
      out[i] = 'start';
      for (let k = i + 1; k < j; k++) out[k] = 'mid';
      out[j] = 'end';
    }
    i = j + 1;
  }
  return out;
}

export const METRIC_LABELS: Record<RankMetric, string> = {
  mean: 'mean guesses',
  fail_rate: 'fail rate',
  le3: 'solved in 3 or fewer',
  mean_fail_plus: 'mean, failure = max + 1',
};

/** Whether larger values of the metric are better (for display arrows). */
export function metricHigherIsBetter(m: RankMetric): boolean {
  return m === 'le3';
}

export function fmtMetric(m: RankMetric, v: number, provisional = false): string {
  if (!Number.isFinite(v)) return '–';
  if (m === 'fail_rate' || m === 'le3') {
    const p = v * 100;
    return provisional ? `~${Math.round(p)}%` : `${p.toFixed(1)}%`;
  }
  return provisional ? `~${v.toFixed(1)}` : v.toFixed(2);
}

function csvNum(v: number): string {
  if (!Number.isFinite(v)) return 'NA';
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toPrecision(6)));
}

function csvStr(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** ranking.csv as in the specification ("Data export"). */
export function rankingCsv(r: Pick<Ranking, 'id' | 'fixedKind' | 'fixedValue' | 'metric' | 'entries'>): string {
  const header = 'ranking_id,fixed_kind,fixed_value,entry,rank,metric,value,ci_low,ci_high,fail_rate,stage';
  const rows = [...r.entries]
    .sort((a, b) => a.rank - b.rank)
    .map((e: RankingEntry) =>
      [
        csvStr(r.id),
        r.fixedKind,
        csvStr(r.fixedValue),
        csvStr(e.key),
        csvNum(e.rank),
        r.metric,
        csvNum(e.value),
        csvNum(e.ciLow),
        csvNum(e.ciHigh),
        csvNum(e.failRate),
        e.stage,
      ].join(','),
    );
  return [header, ...rows].join('\n') + '\n';
}

/** What a ranking panel needs to know about an entry beyond the model's fields. */
type EntryLike = Pick<RankingEntry, 'key' | 'stage' | 'round' | 'provisional' | 'scoreKind' | 'targets' | 'replicates'>;

/**
 * Whether an entry was screened out. The model reports candidates still in
 * the running as stage "screened" too (they are not full cards yet); those
 * were evaluated in the current round (round − 1). When a ranking finishes,
 * every entry without a full card was screened out; when it is cancelled,
 * the candidates of the interrupted round were not.
 */
export function isScreenedOut(e: EntryLike, round: number, status: Ranking['status']): boolean {
  if (e.stage !== 'screened') return false;
  if (status === 'done' || status === 'error') return true;
  return (e.round ?? 0) < round - 1;
}

/** The effort an entry's value reflects (changes when a round has evaluated it). */
export function effortSignature(e: EntryLike): string {
  return `${e.stage}|${e.scoreKind ?? ''}|${e.targets ?? 0}|${e.replicates ?? 0}`;
}

/** Signatures of the candidates in the running, taken when a round starts. */
export function roundStart(entries: readonly EntryLike[], round: number, status: Ranking['status']): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of entries) if (!isScreenedOut(e, round, status)) m.set(e.key, effortSignature(e));
  return m;
}

/**
 * Progress within the current round: candidates still in the running and how
 * many have finished it (a full card that is complete, or an entry whose
 * effort changed since the round started).
 */
export function roundProgress(
  entries: readonly EntryLike[],
  round: number,
  status: Ranking['status'],
  start: ReadonlyMap<string, string> | null = null,
): { active: number; done: number } {
  let active = 0, done = 0;
  if (status !== 'running') return { active, done };
  for (const e of entries) {
    if (isScreenedOut(e, round, status)) continue;
    active++;
    if (e.stage === 'full') {
      if (!e.provisional) done++;
    } else if (start) {
      const s = start.get(e.key);
      if (s !== undefined && s !== effortSignature(e)) done++;
    }
  }
  return { active, done };
}

/** A ranking value: bits for openers screened by one-step information, else the metric. */
export function fmtEntryValue(metric: RankMetric, e: Pick<RankingEntry, 'scoreKind' | 'value'>, provisional: boolean): string {
  if (e.scoreKind === 'info') return Number.isFinite(e.value) ? `${e.value.toFixed(2)} bits` : '–';
  return fmtMetric(metric, e.value, provisional);
}
