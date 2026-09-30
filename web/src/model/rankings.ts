// Rankings by successive halving. Owned by the platform agent.
//
// A row ranking fixes an opener and ranks strategies; a column ranking fixes a
// strategy and ranks openers (docs/specification.md, "Rankings"):
//
//   1. Screen every candidate cheaply: one-step expected information for
//      openers, or 200 sampled targets at R = 1 for strategies.
//   2. Keep the best half, double the effort (more targets, then higher R),
//      and re-rank.
//   3. Stop when `rankKeep` candidates remain; these get full cards. Entries
//      screened out keep their last score and are marked "screened".
//
// Sampled rounds play the same targets for every candidate (a seeded
// permutation of the answers, nested from round to round), so candidates
// are compared target by target. Each round only plays the games the
// previous rounds lack. Metrics: mean guesses, fail rate, share solved in
// three or fewer, mean with a failure counted as max + 1; ties break on fail
// rate, then name. Intervals are 95%: over targets (finite-population
// corrected) while sampled, across replicates for full stochastic cards.
// Adjacent entries whose paired per-target difference is within noise share
// a tie group.

import { isDeterministicSpec, makeConfig as appMakeConfig, specLabel, type MakeConfigOptions } from '../app/config';
import { app, type ResultSettings, type StrategyEntry } from '../app/store.svelte';
import { backend } from '../backend';
import type { Config, Game, Scope, StrategySpec } from '../backend/types';
import { FALLBACK_PRESETS } from '../lab/catalogue';
import { cardFromRecords, metricOf, metricValue, outcomeRecord, rawTargetWeights, Z95, type CardStats } from './card';
import { runs as defaultRuns, type RunManagerImpl } from './runs';
import type { Run, RunManager, WordData } from './types';

export type RankMetric = 'mean' | 'fail_rate' | 'le3' | 'mean_fail_plus';

export interface RankingEntry {
  /** Opener word, or strategy id. */
  key: string;
  label: string;
  colour?: string;
  spec?: StrategySpec;
  opener?: string | null;
  rank: number;
  value: number;
  ciLow: number;
  ciHigh: number;
  failRate: number;
  /** Seven-row (max guesses + X) mini distribution. */
  distribution: number[];
  stage: 'full' | 'screened';
  /** Index of the tie group ("tied within noise"), or -1. */
  tieGroup: number;
  /** What `value` measures: the ranking metric, or one-step information (bits) for openers screened by it. */
  scoreKind?: RankMetric | 'info';
  /** The round the entry was last evaluated in (0 = screening). */
  round?: number;
  /** Targets and replicates the value is based on. */
  targets?: number;
  replicates?: number;
  /** Still computing (the value is an estimate that will change). */
  provisional?: boolean;
  /** Full entries: the card configuration and its run (shared with the Atlas). */
  config?: Config;
  run?: Run;
}

export interface Ranking {
  id: string;
  fixedKind: 'opener' | 'strategy';
  fixedValue: string;
  metric: RankMetric;
  round: number;
  rounds: number;
  entries: RankingEntry[];
  status: 'running' | 'done' | 'cancelled' | 'error';
  version: number;
  onChange(cb: () => void): () => void;
  cancel(): void;
  /** Error message when status is 'error'. */
  error?: string | null;
}

/** Targets in the first sampled round. */
export const SCREEN_TARGETS = 200;
/** Concurrent runs a ranking keeps in flight. */
const CONCURRENCY = 8;
/** Listener notifications at most this often while a round is running. */
const NOTIFY_MS = 200;

/** What a ranking needs from the app (tests pass fakes). */
export interface RankingDeps {
  runs: Pick<RunManager, 'request'> & Partial<Pick<RunManagerImpl, 'release'>>;
  words: WordData;
  result: ResultSettings;
  makeConfig(opts: MakeConfigOptions): Config;
  openerInfo(config: Config, signal?: AbortSignal): Promise<Float64Array>;
  /** Default strategy set (presets and saved strategies). */
  strategies(): StrategyEntry[];
}

function defaultDeps(): RankingDeps {
  const words = app.words;
  if (!words) throw new Error('the word list has not loaded yet');
  return {
    runs: defaultRuns,
    words,
    result: JSON.parse(JSON.stringify(app.result)) as ResultSettings,
    makeConfig: appMakeConfig,
    openerInfo: (config, signal) => backend.openerInfo(config, signal),
    strategies: () => {
      const presets = app.catalogue.presets.length ? app.catalogue.presets : FALLBACK_PRESETS;
      const all: StrategyEntry[] = presets.map((p) => ({ id: p.id, label: p.label, colour: p.colour, spec: p.spec }));
      for (const s of app.saved) if (!all.some((e) => e.id === s.id)) all.push(s);
      return JSON.parse(JSON.stringify(all)) as StrategyEntry[];
    },
  };
}

/** Whether larger values of a metric are better. */
export function higherIsBetter(metric: RankMetric | 'info'): boolean {
  return metric === 'le3' || metric === 'info';
}

/** Per-game value of a metric (its mean over games is the card metric). */
export function gameMetric(metric: RankMetric, g: Game, maxGuesses: number): number {
  const n = g.turns.length;
  switch (metric) {
    case 'mean':
      return n;
    case 'fail_rate':
      return g.solved ? 0 : 1;
    case 'le3':
      return g.solved && n <= 3 ? 1 : 0;
    case 'mean_fail_plus':
      return g.solved ? n : maxGuesses + 1;
  }
}

/** A seeded permutation of 0..n-1 (splitmix32 + Fisher–Yates), for the rounds' target samples. */
export function seededOrder(n: number, seed: number): number[] {
  let s = (seed ^ 0x9e3779b9) >>> 0;
  const next = () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return ((z ^ (z >>> 16)) >>> 0) / 4294967296;
  };
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Effort of a round: the first `targets` of the ranking's target order, replicates [0, reps). */
export interface Effort {
  targets: number;
  reps: number;
}

/** The next effort: double the targets until all are in, then double R (capped at `maxReps`). */
export function nextEffort(e: Effort, nTargets: number, maxReps: number): Effort {
  if (e.targets < nTargets) return { targets: Math.min(nTargets, e.targets * 2), reps: e.reps };
  return { targets: nTargets, reps: Math.min(maxReps, e.reps * 2) };
}

/** Candidates kept after a round: the best half, but never fewer than `keep`. */
export function keepCount(n: number, keep: number): number {
  return Math.min(n, Math.max(keep, Math.ceil(n / 2)));
}

/**
 * Rounds a ranking of n candidates will run: the screening round (sampled
 * targets for strategies, one-step information for openers), a sampled round
 * after every halving that still leaves more than `keep`, and the full cards.
 */
export function plannedRounds(n: number, keep: number, infoScreen = false): number {
  if (n <= keep) return infoScreen ? 2 : 1;
  let h = 0;
  let c = n;
  while (c > keep) {
    c = keepCount(c, keep);
    h++;
  }
  return h + 1;
}

interface Candidate {
  key: string;
  label: string;
  colour?: string;
  spec: StrategySpec;
  opener: string | null;
  deterministic: boolean;
  /** Outcome records [target, replicate, row] gathered so far (sampled rounds). */
  recs: [number, number, number][];
  /** Per target: sum and sum of squares of the per-game metric, and game count. */
  perTarget: Map<number, [number, number, number]>;
  /** Effort the records cover. */
  effort: Effort;
  stage: 'active' | 'screened' | 'full';
  /** Round it was last evaluated in / eliminated after. */
  round: number;
  info: number;
  value: number;
  ciLow: number;
  ciHigh: number;
  failRate: number;
  distribution: number[];
  scoreKind: RankMetric | 'info';
  provisional: boolean;
  card: CardStats | null;
  config?: Config;
  run?: Run;
}

class RankingImpl implements Ranking {
  round = 0;
  rounds = 1;
  entries: RankingEntry[] = [];
  status: Ranking['status'] = 'running';
  version = 0;
  error: string | null = null;
  readonly abort = new AbortController();
  private listeners = new Set<() => void>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  /** Runs started by this ranking and still going (cancelled with it). */
  readonly live = new Set<Run>();

  constructor(
    readonly id: string,
    readonly fixedKind: 'opener' | 'strategy',
    readonly fixedValue: string,
    readonly metric: RankMetric,
  ) {}

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Notify now. */
  emit(): void {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    this.version++;
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch (e) {
        console.error(e);
      }
    }
  }

  /** Notify soon (throttled). */
  touch(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.emit();
    }, NOTIFY_MS);
  }

  cancel(): void {
    if (this.status !== 'running') return;
    this.status = 'cancelled';
    this.abort.abort();
    for (const run of this.live) {
      // Sampled runs are this ranking's own; full cards may be shared with the Atlas, so they only drop back.
      if (Array.isArray(run.scope.targets)) run.cancel();
      else run.setPriority('background');
    }
    this.live.clear();
    for (const e of this.entries) e.provisional = false;
    this.emit();
  }
}

class Aborted extends Error {}

function compareCandidates(metric: RankMetric | 'info') {
  const sign = higherIsBetter(metric) ? -1 : 1;
  return (a: Candidate, b: Candidate): number => {
    const va = Number.isFinite(a.value) ? a.value : sign * Infinity;
    const vb = Number.isFinite(b.value) ? b.value : sign * Infinity;
    if (va !== vb) return sign * (va - vb);
    const fa = Number.isFinite(a.failRate) ? a.failRate : Infinity;
    const fb = Number.isFinite(b.failRate) ? b.failRate : Infinity;
    if (fa !== fb) return fa - fb;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  };
}

/** Paired per-target difference of a metric between two candidates: mean and its standard error. */
export function pairedDifference(
  a: Map<number, [number, number, number]>,
  b: Map<number, [number, number, number]>,
  nTargets: number,
): { mean: number; se: number; n: number } {
  const d: number[] = [];
  let within = 0;
  let withinKnown = true;
  for (const [t, [sa, qa, na]] of a) {
    const bb = b.get(t);
    if (!bb || !na || !bb[2]) continue;
    const [sb, qb, nb] = bb;
    const ma = sa / na;
    const mb = sb / nb;
    d.push(ma - mb);
    // Within-target replicate variance of the difference of the two means.
    if (na >= 2 && nb >= 2) {
      const va = Math.max(0, (qa - na * ma * ma) / (na - 1));
      const vb = Math.max(0, (qb - nb * mb * mb) / (nb - 1));
      within += va / na + vb / nb;
    } else withinKnown = false;
  }
  const n = d.length;
  if (n === 0) return { mean: NaN, se: NaN, n: 0 };
  let s = 0;
  for (const x of d) s += x;
  const mean = s / n;
  if (n < 2) return { mean, se: Infinity, n };
  let ss = 0;
  for (const x of d) ss += (x - mean) * (x - mean);
  const sd2 = ss / (n - 1);
  const fpc = Math.max(0, 1 - n / Math.max(n, nTargets));
  // Sampling over targets (finite-population corrected) plus replicate noise within targets.
  let v = (fpc * sd2) / n + (withinKnown ? within / (n * n) : fpc === 0 ? sd2 / n : 0);
  if (!Number.isFinite(v)) v = sd2 / n;
  return { mean, se: Math.sqrt(v), n };
}

/** The per-target metric of a set of games: target → [sum, sum of squares, count]. */
function perTargetOf(metric: RankMetric, games: readonly Game[], maxGuesses: number, into: Map<number, [number, number, number]>): void {
  for (const g of games) {
    if (g.isPlayer) continue;
    const y = gameMetric(metric, g, maxGuesses);
    const e = into.get(g.target);
    if (e) {
      e[0] += y;
      e[1] += y * y;
      e[2]++;
    } else into.set(g.target, [y, y * y, 1]);
  }
}

class Driver {
  readonly maxGuesses: number;
  readonly nAnswers: number;
  readonly weights: Float64Array;
  readonly order: number[];
  readonly keep: number;
  readonly cardReps: number;
  private runsInFlight = 0;
  private waiters: (() => void)[] = [];

  constructor(
    readonly ranking: RankingImpl,
    readonly deps: RankingDeps,
    readonly cands: Candidate[],
  ) {
    const r = deps.result;
    this.maxGuesses = r.maxGuesses;
    this.nAnswers = deps.words.answers.length;
    const zipf = deps.words.zipf;
    this.weights = rawTargetWeights(zipf ? deps.words.answers.map((id) => zipf[id]) : null, this.nAnswers, r.weighting);
    this.order = seededOrder(this.nAnswers, (r.baseSeed >>> 0) ^ 0x5eed);
    this.keep = Math.max(1, Math.round(r.rankKeep));
    this.cardReps = Math.max(1, Math.round(r.replicatesCard));
  }

  private check(): void {
    if (this.ranking.abort.signal.aborted) throw new Aborted();
  }

  private config(c: Candidate, reps: number): Config {
    return this.deps.makeConfig({ strategy: c.spec, opener: c.opener, kind: 'card', replicates: reps });
  }

  private async slot(): Promise<void> {
    while (this.runsInFlight >= CONCURRENCY) await new Promise<void>((res) => this.waiters.push(res));
    this.runsInFlight++;
  }

  private free(): void {
    this.runsInFlight--;
    this.waiters.shift()?.();
  }

  /** Request a run and wait for it to finish; `onGames` sees games as they arrive. */
  private async play(config: Config, scope: Scope, onGames: (games: Game[], run: Run) => void, retain = false): Promise<Run> {
    await this.slot();
    try {
      for (let attempt = 0; ; attempt++) {
        this.check();
        const run = this.deps.runs.request(config, scope, 'visible');
        this.ranking.live.add(run);
        let seen = 0;
        const pump = () => {
          if (run.games.length > seen) {
            const fresh = run.games.slice(seen);
            seen = run.games.length;
            onGames(fresh, run);
          }
        };
        pump();
        const status = await new Promise<Run['status']>((resolve) => {
          const finish = () => {
            if (run.status === 'done' || run.status === 'error' || run.status === 'cancelled') {
              off();
              this.ranking.abort.signal.removeEventListener('abort', onAbort);
              resolve(run.status);
            }
          };
          const onAbort = () => {
            off();
            resolve('cancelled');
          };
          const off = run.onChange(() => {
            pump();
            finish();
          });
          this.ranking.abort.signal.addEventListener('abort', onAbort, { once: true });
          finish();
        });
        this.ranking.live.delete(run);
        this.check();
        pump();
        if (status === 'done') {
          if (!retain) this.deps.runs.release?.(run);
          return run;
        }
        if (status === 'error') throw new Error(run.error ?? 'a ranking run failed');
        // Cancelled by someone else (a shared run): try again once.
        if (attempt >= 1) throw new Error('a ranking run was cancelled');
      }
    } finally {
      this.free();
    }
  }

  /** Recompute a candidate's value from its records. */
  private evaluate(c: Candidate): void {
    const det = c.deterministic;
    const card = cardFromRecords(c.recs, this.maxGuesses, this.nAnswers, det, this.weights);
    c.card = card;
    this.applyCard(c, card, c.effort.targets);
  }

  private applyCard(c: Candidate, card: CardStats, targetsDone: number): void {
    const metric = this.ranking.metric;
    c.scoreKind = metric;
    c.distribution = card.shares.slice();
    c.failRate = card.shares[this.maxGuesses];
    const n = card.nTargetsSeen;
    if (n === 0) {
      c.value = c.ciLow = c.ciHigh = NaN;
      return;
    }
    if (n < this.nAnswers) {
      // Sampled: an interval over targets, finite-population corrected.
      const v = metricOf(metric, card.shares, card.mean);
      let ss = 0;
      let wt = 0;
      for (const [t, [s, , cnt]] of c.perTarget) {
        const w = this.weights[t] ?? 1;
        const y = s / cnt;
        ss += w * (y - v) * (y - v);
        wt += w;
      }
      const s2 = n >= 2 && wt > 0 ? ((ss / wt) * n) / (n - 1) : Infinity;
      const half = n >= 2 ? Z95 * Math.sqrt(Math.max(0, 1 - n / this.nAnswers) * (s2 / n)) : Infinity;
      c.value = v;
      c.ciLow = v - half;
      c.ciHigh = v + half;
    } else {
      [c.value, c.ciLow, c.ciHigh] = metricValue(metric, card);
    }
    void targetsDone;
  }

  /** Play the games a candidate lacks for an effort (sampled rounds). */
  private async extend(c: Candidate, to: Effort): Promise<void> {
    const reps = c.deterministic ? 1 : to.reps;
    const from = c.effort;
    const jobs: { targets: number[]; range: [number, number] }[] = [];
    if (to.targets > from.targets && from.reps > 0) jobs.push({ targets: this.order.slice(from.targets, to.targets), range: [0, from.reps] });
    if (reps > from.reps) jobs.push({ targets: this.order.slice(0, to.targets), range: [from.reps, reps] });
    if (from.reps === 0) jobs.splice(0, jobs.length, { targets: this.order.slice(0, to.targets), range: [0, reps] });
    for (const job of jobs) {
      if (!job.targets.length || job.range[1] <= job.range[0]) continue;
      const config = this.config(c, Math.max(job.range[1], 1));
      await this.play(config, { targets: job.targets, replicates: job.range }, (games) => {
        for (const g of games) if (!g.isPlayer) c.recs.push(outcomeRecord(g, this.maxGuesses));
        perTargetOf(this.ranking.metric, games, this.maxGuesses, c.perTarget);
      });
    }
    c.effort = { targets: to.targets, reps };
    c.provisional = false;
    this.evaluate(c);
    this.publish();
  }

  /** Full card: every target at the card replicate count (shared with the Atlas). */
  private async full(c: Candidate): Promise<void> {
    const config = this.config(c, this.cardReps);
    c.config = config;
    c.stage = 'full';
    c.provisional = true;
    c.recs = [];
    c.perTarget = new Map();
    const run = await this.play(
      config,
      { targets: 'all' },
      (games, r) => {
        c.run = r;
        for (const g of games) if (!g.isPlayer) c.recs.push(outcomeRecord(g, this.maxGuesses));
        perTargetOf(this.ranking.metric, games, this.maxGuesses, c.perTarget);
        c.card = cardFromRecords(c.recs, this.maxGuesses, this.nAnswers, c.deterministic, this.weights);
        this.applyCard(c, c.card, c.card.nTargetsSeen);
        this.ranking.touch();
        this.publishSoon();
      },
      true,
    );
    c.run = run;
    c.provisional = false;
    c.effort = { targets: this.nAnswers, reps: c.deterministic ? 1 : this.cardReps };
    this.evaluate(c);
    this.publish();
  }

  private publishPending = false;
  private publishSoon(): void {
    if (this.publishPending) return;
    this.publishPending = true;
    setTimeout(() => {
      this.publishPending = false;
      if (this.ranking.status === 'running') this.publish();
    }, NOTIFY_MS);
  }

  /** Order candidates, assign ranks and tie groups, and publish entries. */
  publish(final = false): void {
    const metric = this.ranking.metric;
    const cmp = compareCandidates(metric);
    const full = this.cands.filter((c) => c.stage === 'full').sort(cmp);
    const active = this.cands.filter((c) => c.stage === 'active');
    const activeMetric = active.filter((c) => c.scoreKind !== 'info').sort(cmp);
    const activeInfo = active.filter((c) => c.scoreKind === 'info').sort(compareCandidates('info'));
    const screened = this.cands.filter((c) => c.stage === 'screened');
    // Eliminated later first; then by their score at elimination.
    const byRound = new Map<number, Candidate[]>();
    for (const c of screened) {
      const k = c.scoreKind === 'info' ? -1 : c.round;
      if (!byRound.has(k)) byRound.set(k, []);
      byRound.get(k)!.push(c);
    }
    const rounds = [...byRound.keys()].sort((a, b) => b - a);
    const ordered = [...full, ...activeMetric, ...activeInfo];
    for (const r of rounds) {
      const group = byRound.get(r)!;
      ordered.push(...group.sort(compareCandidates(r === -1 ? 'info' : metric)));
    }
    // Tie groups among adjacent entries evaluated alike.
    const groups = new Array<number>(ordered.length).fill(-1);
    let nextGroup = 0;
    for (let i = 0; i + 1 < ordered.length; i++) {
      const a = ordered[i];
      const b = ordered[i + 1];
      if (!this.comparable(a, b)) continue;
      if (this.tied(a, b)) {
        if (groups[i] < 0) groups[i] = nextGroup++;
        groups[i + 1] = groups[i];
      }
    }
    this.ranking.entries = ordered.map((c, i) => ({
      key: c.key,
      label: c.label,
      colour: c.colour,
      spec: c.spec,
      opener: c.opener,
      rank: i + 1,
      value: c.value,
      ciLow: c.ciLow,
      ciHigh: c.ciHigh,
      failRate: c.failRate,
      distribution: c.distribution,
      stage: c.stage === 'full' ? 'full' : 'screened',
      tieGroup: groups[i],
      scoreKind: c.scoreKind,
      round: c.round,
      targets: c.scoreKind === 'info' ? 0 : c.effort.targets,
      replicates: c.scoreKind === 'info' ? 0 : c.effort.reps,
      provisional: !final && (c.provisional || c.stage === 'active'),
      config: c.config,
      run: c.run,
    }));
    this.ranking.touch();
  }

  private comparable(a: Candidate, b: Candidate): boolean {
    if (a.scoreKind === 'info' || b.scoreKind === 'info') return false;
    if (a.stage !== b.stage) return false;
    if (a.stage === 'screened' && a.round !== b.round) return false;
    if (a.effort.targets !== b.effort.targets) return false;
    // Exact results are never "within noise".
    const exact = a.effort.targets >= this.nAnswers && a.deterministic && b.deterministic;
    return !exact && Number.isFinite(a.value) && Number.isFinite(b.value);
  }

  private tied(a: Candidate, b: Candidate): boolean {
    if (a.value === b.value) return true;
    const d = pairedDifference(a.perTarget, b.perTarget, this.nAnswers);
    if (!(d.n > 0) || !Number.isFinite(d.se)) return d.n > 0;
    return Math.abs(d.mean) <= Z95 * d.se;
  }

  /** Keep the best candidates of the active set; the rest are screened out at this round. */
  private halve(): Candidate[] {
    const active = this.cands.filter((c) => c.stage === 'active');
    const kind = active.some((c) => c.scoreKind === 'info') ? 'info' : this.ranking.metric;
    active.sort(compareCandidates(kind));
    const k = keepCount(active.length, this.keep);
    for (const c of active.slice(k)) {
      c.stage = 'screened';
      c.provisional = false;
    }
    return active.slice(0, k);
  }

  private async round(active: Candidate[], fn: (c: Candidate) => Promise<void>): Promise<void> {
    this.ranking.round++;
    for (const c of active) {
      c.round = this.ranking.round - 1;
      c.provisional = true;
    }
    this.publish();
    await Promise.all(active.map((c) => fn(c)));
    this.check();
  }

  async runOpeners(strategy: StrategyEntry, known: Float64Array | null = null): Promise<void> {
    // Round 0: one-step expected information of every opener (from the initial state).
    const info = known ?? (await this.deps.openerInfo(infoConfig(this.deps, strategy.spec), this.ranking.abort.signal));
    this.check();
    this.ranking.round = 1;
    for (const c of this.cands) {
      const id = this.deps.words.index.get(c.key);
      c.info = id !== undefined && id < info.length ? info[id] : NaN;
      c.value = c.info;
      c.ciLow = c.ciHigh = c.info;
      c.scoreKind = 'info';
      c.round = 0;
    }
    this.publish();
    await this.halving({ targets: 0, reps: 0 });
  }

  async runStrategies(): Promise<void> {
    await this.halving(null);
  }

  /** Screening (when `start` is null: 200 sampled targets at R = 1), then halving rounds, then full cards. */
  private async halving(start: Effort | null): Promise<void> {
    let effort: Effort;
    let active = this.cands.filter((c) => c.stage === 'active');
    if (!start) {
      effort = { targets: Math.min(SCREEN_TARGETS, this.nAnswers), reps: 1 };
      // With no more candidates than full evaluations, screening is pointless.
      if (active.length > this.keep) await this.round(active, (c) => this.extend(c, effort));
    } else effort = start;
    while (true) {
      active = this.cands.filter((c) => c.stage === 'active');
      if (active.length <= this.keep) break;
      active = this.halve();
      this.publish();
      if (active.length <= this.keep) break;
      effort = effort.reps === 0 ? { targets: Math.min(SCREEN_TARGETS, this.nAnswers), reps: 1 } : nextEffort(effort, this.nAnswers, this.cardReps);
      const fullEffort = effort.targets >= this.nAnswers && (effort.reps >= this.cardReps || active.every((c) => c.deterministic));
      if (fullEffort) break;
      const e = effort;
      await this.round(active, (c) => this.extend(c, e));
    }
    active = this.cands.filter((c) => c.stage === 'active');
    await this.round(active, (c) => this.full(c));
  }
}

/** The configuration whose one-step information screens openers (the strategy with no opener). */
function infoConfig(d: Pick<RankingDeps, 'makeConfig'>, spec: StrategySpec): Config {
  return d.makeConfig({ strategy: spec, opener: null, kind: 'card', replicates: 1 });
}

let rankingSeq = 0;

function makeRanking(fixedKind: 'opener' | 'strategy', fixedValue: string, metric: RankMetric): RankingImpl {
  const id = `${fixedKind}-${fixedValue}-${metric}-${(++rankingSeq).toString(36)}`;
  return new RankingImpl(id, fixedKind, fixedValue, metric);
}

function start(ranking: RankingImpl, go: () => Promise<Driver | null>): void {
  void (async () => {
    try {
      const driver = await go();
      if (ranking.status !== 'running') return;
      ranking.status = 'done';
      driver?.publish(true);
      ranking.emit();
    } catch (e) {
      if (e instanceof Aborted || ranking.status === 'cancelled') return;
      ranking.status = 'error';
      ranking.error = e instanceof Error ? e.message : String(e);
      console.error(e);
      ranking.emit();
    }
  })();
}

function candidate(key: string, label: string, spec: StrategySpec, opener: string | null, colour?: string): Candidate {
  return {
    key,
    label,
    colour,
    spec: JSON.parse(JSON.stringify(spec)) as StrategySpec,
    opener,
    deterministic: isDeterministicSpec(spec),
    recs: [],
    perTarget: new Map(),
    effort: { targets: 0, reps: 0 },
    stage: 'active',
    round: 0,
    info: NaN,
    value: NaN,
    ciLow: NaN,
    ciHigh: NaN,
    failRate: NaN,
    distribution: [],
    scoreKind: 'mean',
    provisional: true,
    card: null,
  };
}

/** Rank every strategy in `set` for a fixed opener (row ranking). An empty set uses the "Strategy set" setting. */
export function rankStrategies(opener: string | null, set: StrategyEntry[], deps?: RankingDeps): Ranking {
  const d = deps ?? defaultDeps();
  const metric = d.result.rankMetric;
  let list = set;
  if (!list.length) {
    const all = d.strategies();
    const chosen = d.result.rankStrategySet;
    list = chosen === 'all' ? all : all.filter((e) => chosen.includes(e.id));
  }
  const seen = new Set<string>();
  const cands: Candidate[] = [];
  for (const e of list) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    cands.push(candidate(e.id, e.label || specLabel(e.spec), e.spec, opener, e.colour));
  }
  const ranking = makeRanking('opener', opener ?? 'NA', metric);
  const driver = new Driver(ranking, d, cands);
  ranking.rounds = plannedRounds(cands.length, driver.keep);
  if (!cands.length) {
    ranking.status = 'done';
    return ranking;
  }
  start(ranking, async () => {
    await driver.runStrategies();
    return driver;
  });
  return ranking;
}

/** The opener candidates of the "Opener set" setting. */
export function openerSet(deps: Pick<RankingDeps, 'words' | 'result'>, info: Float64Array | null = null): string[] {
  const w = deps.words;
  const s = deps.result.rankOpenerSet;
  switch (s.kind) {
    case 'answers':
      return w.answers.map((id) => w.guesses[id]);
    case 'allowed':
      return [...w.guesses];
    case 'pasted':
      return s.words.map((x) => x.trim().toLowerCase()).filter((x) => w.index.has(x));
    case 'top_info': {
      if (!info) return [...w.guesses];
      const ids = w.guesses.map((_, i) => i).sort((a, b) => info[b] - info[a] || a - b);
      return ids.slice(0, Math.max(1, s.n)).map((i) => w.guesses[i]);
    }
  }
}

/** Rank openers for a fixed strategy (column ranking). `null` uses the "Opener set" setting. */
export function rankOpeners(strategy: StrategyEntry, openers: string[] | null, deps?: RankingDeps): Ranking {
  const d = deps ?? defaultDeps();
  const metric = d.result.rankMetric;
  const ranking = makeRanking('strategy', strategy.id, metric);
  const build = (words: string[]) => {
    const seen = new Set<string>();
    const cands: Candidate[] = [];
    for (const raw of words) {
      const w = raw.trim().toLowerCase();
      if (!w || seen.has(w) || !d.words.index.has(w)) continue;
      seen.add(w);
      cands.push(candidate(w, w, strategy.spec, w, strategy.colour));
    }
    return cands;
  };
  const keep = Math.max(1, Math.round(d.result.rankKeep));
  if (openers) {
    const cands = build(openers);
    ranking.rounds = plannedRounds(cands.length, keep, true);
    if (!cands.length) {
      ranking.status = 'done';
      return ranking;
    }
    const driver = new Driver(ranking, d, cands);
    start(ranking, async () => {
      await driver.runOpeners(strategy);
      return driver;
    });
    return ranking;
  }
  // The setting's set; "top N by information" needs the information first.
  const needsInfo = d.result.rankOpenerSet.kind === 'top_info';
  start(ranking, async () => {
    let info: Float64Array | null = null;
    if (needsInfo) info = await d.openerInfo(infoConfig(d, strategy.spec), ranking.abort.signal);
    const cands = build(openerSet(d, info));
    ranking.rounds = plannedRounds(cands.length, keep, true);
    if (!cands.length) return null;
    const driver = new Driver(ranking, d, cands);
    await driver.runOpeners(strategy, info);
    return driver;
  });
  return ranking;
}
