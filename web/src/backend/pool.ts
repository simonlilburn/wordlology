// Worker pool and scheduler (docs/architecture.md, "Worker protocol").
//
// - min(4, hardwareConcurrency − 1) workers, at least 1.
// - Runs are split into shards (one worker run each). Large stochastic runs
//   are sharded across idle workers by replicate range; each shard is a full
//   pass over the seeded target order, so every prefix stays an unbiased
//   estimate.
// - Shards are assigned in priority order (focused, visible, background),
//   at most SLOTS_PER_WORKER per worker; higher-priority shards are assigned
//   even to full workers, which always work on their highest-priority
//   unpaused run, so background runs pause while higher-priority work waits.

import type { FromWorker, MetaResult, ToWorker } from './protocol';
import { PRIORITY_RANK } from './protocol';
import { plain } from './stream';
import type { Config, Priority, ProgressEvent, Scope, SummaryEvent } from './types';

export interface WorkerLike {
  postMessage(msg: ToWorker, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<FromWorker>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  terminate(): void;
}

export interface JobHandlers {
  onGames(buffer: ArrayBuffer): void;
  onProgress(p: ProgressEvent): void;
  onSummary(s: SummaryEvent): void;
  onError(message: string): void;
}

export interface LoadPayload {
  key: string;
  manifest: unknown;
  guesses: string;
  answers: string;
  frequencies: string | null;
}

/** Games in a run above which a stochastic run is sharded across idle workers. */
export const SHARD_MIN_GAMES = 4000;
/** Concurrent shards per worker (they share the worker round-robin at equal priority). */
export const SLOTS_PER_WORKER = 3;

interface Slot {
  index: number;
  worker: WorkerLike;
  loaded: Set<string>;
  loading: Map<string, { resolve: (ms: number) => void; reject: (e: Error) => void; promise: Promise<number> }>;
  shards: Set<Shard>;
  dead: boolean;
}

interface Shard {
  runId: number;
  job: Job;
  range: [number, number];
  slot: Slot | null;
  progress: ProgressEvent | null;
  summary: SummaryEvent | null;
  done: boolean;
  seq: number;
}

export interface Job {
  id: number;
  key: string;
  config: Config;
  scope: Scope;
  priority: Priority;
  paused: boolean;
  shards: Shard[];
  handlers: JobHandlers;
  finished: boolean;
  startedAt: number;
}

export function defaultPoolSize(): number {
  const hc = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
  return Math.max(1, Math.min(4, hc - 1));
}

/** Number of targets a scope plays, given the answer count. */
export function scopeTargetCount(scope: Scope, nAnswers: number): number {
  if (scope.targets === 'all') return nAnswers;
  if (Array.isArray(scope.targets)) return scope.targets.length;
  return Math.min(nAnswers, scope.targets.sample);
}

/** Split [a, b) into k contiguous, nearly equal ranges. */
export function splitRange(a: number, b: number, k: number): [number, number][] {
  const n = b - a;
  const parts = Math.max(1, Math.min(k, n));
  const out: [number, number][] = [];
  let lo = a;
  for (let i = 0; i < parts; i++) {
    const size = Math.floor(n / parts) + (i < n % parts ? 1 : 0);
    out.push([lo, lo + size]);
    lo += size;
  }
  return out;
}

/** Merge shard progress into one event for the run. */
export function mergeProgress(shards: { progress: ProgressEvent | null; range: [number, number] }[], expectedTotal?: number): ProgressEvent {
  let done = 0;
  let total = 0;
  let targetsDone = Infinity;
  let targetsTotal = 0;
  let settledDepth: number | undefined;
  let unresolved: number | undefined;
  for (const s of shards) {
    const p = s.progress;
    if (!p) {
      targetsDone = 0;
      continue;
    }
    done += p.done;
    total += p.total;
    targetsDone = Math.min(targetsDone, p.targetsDone);
    targetsTotal = Math.max(targetsTotal, p.targetsTotal);
    if (p.settledDepth !== undefined) settledDepth = settledDepth === undefined ? p.settledDepth : Math.min(settledDepth, p.settledDepth);
    if (p.unresolved !== undefined) unresolved = (unresolved ?? 0) + p.unresolved;
  }
  const ev: ProgressEvent = {
    type: 'progress',
    done,
    total: Math.max(total, expectedTotal ?? 0),
    targetsDone: Number.isFinite(targetsDone) ? targetsDone : 0,
    targetsTotal,
  };
  if (settledDepth !== undefined) ev.settledDepth = settledDepth;
  if (unresolved !== undefined) ev.unresolved = unresolved;
  const phases = shards.find((s) => s.progress?.phases?.length)?.progress?.phases;
  if (phases) ev.phases = phases;
  return ev;
}

export class WorkerPool {
  readonly slots: Slot[] = [];
  private jobs = new Map<number, Job>();
  private shardsByRun = new Map<number, Shard>();
  private pendingShards: Shard[] = [];
  private requests = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; slot: Slot }>();
  private nextId = 1;
  private seq = 0;
  private lastLoad: LoadPayload | null = null;
  /** Answer counts per load key, for shard sizing. */
  private answerCounts = new Map<string, number>();

  constructor(
    private createWorker: () => WorkerLike,
    readonly size: number = defaultPoolSize(),
  ) {}

  private ensureWorkers(): void {
    while (this.slots.length < this.size) {
      const index = this.slots.length;
      const worker = this.createWorker();
      const slot: Slot = { index, worker, loaded: new Set(), loading: new Map(), shards: new Set(), dead: false };
      worker.onmessage = (ev) => this.onMessage(slot, ev.data);
      worker.onerror = (ev) => this.onWorkerError(slot, ev?.message || 'worker failed');
      this.slots.push(slot);
    }
  }

  /** Load a word list in every worker (builds the pattern matrix). Resolves with the slowest matrix time. */
  async load(payloadIn: LoadPayload, nAnswers?: number): Promise<number> {
    const payload = plain(payloadIn);
    this.ensureWorkers();
    this.lastLoad = payload;
    if (nAnswers !== undefined) this.answerCounts.set(payload.key, nAnswers);
    const times = await Promise.all(this.slots.filter((s) => !s.dead).map((s) => this.loadSlot(s, payload)));
    return Math.max(0, ...times);
  }

  private loadSlot(slot: Slot, payload: LoadPayload): Promise<number> {
    const existing = slot.loading.get(payload.key);
    if (existing) return existing.promise;
    let resolve!: (ms: number) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<number>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    slot.loading.set(payload.key, { resolve, reject, promise });
    slot.worker.postMessage({ type: 'load', ...payload });
    return promise;
  }

  /** Whether some live worker has loaded (or is loading) a key. */
  isLoaded(key: string): boolean {
    return this.slots.some((s) => !s.dead && (s.loaded.has(key) || s.loading.has(key)));
  }

  private onWorkerError(slot: Slot, message: string): void {
    slot.dead = true;
    for (const l of slot.loading.values()) l.reject(new Error(message));
    slot.loading.clear();
    for (const [id, r] of this.requests) {
      if (r.slot === slot) {
        r.reject(new Error(message));
        this.requests.delete(id);
      }
    }
    for (const shard of [...slot.shards]) this.failJob(shard.job, message);
  }

  private onMessage(slot: Slot, msg: FromWorker): void {
    switch (msg.type) {
      case 'loaded': {
        slot.loaded.add(msg.key);
        const l = slot.loading.get(msg.key);
        slot.loading.delete(msg.key);
        l?.resolve(msg.matrixMs);
        this.assign();
        return;
      }
      case 'games': {
        const shard = this.shardsByRun.get(msg.runId);
        if (shard && !shard.job.finished) shard.job.handlers.onGames(msg.buffer);
        return;
      }
      case 'progress': {
        const shard = this.shardsByRun.get(msg.runId);
        if (!shard || shard.job.finished) return;
        const { runId: _r, type: _t, ...rest } = msg;
        shard.progress = { type: 'progress', ...rest };
        shard.job.handlers.onProgress(mergeProgress(shard.job.shards));
        return;
      }
      case 'summary': {
        const shard = this.shardsByRun.get(msg.runId);
        if (!shard) return;
        const { runId: _r, type: _t, ...rest } = msg;
        shard.summary = { type: 'summary', ...rest };
        this.finishShard(shard);
        const job = shard.job;
        if (!job.finished && job.shards.every((s) => s.done)) {
          job.finished = true;
          this.jobs.delete(job.id);
          const first = job.shards[0].summary!;
          const merged: SummaryEvent = {
            type: 'summary',
            configId: first.configId,
            nGames: job.shards.reduce((n, s) => n + (s.summary?.nGames ?? 0), 0),
            elapsedMs: Math.max(...job.shards.map((s) => s.summary?.elapsedMs ?? 0)),
            phases: first.phases,
            deterministic: first.deterministic,
          };
          job.handlers.onSummary(merged);
        }
        this.assign();
        return;
      }
      case 'result': {
        const r = this.requests.get(msg.reqId);
        if (!r) return;
        this.requests.delete(msg.reqId);
        r.resolve(msg.data);
        return;
      }
      case 'error': {
        if (msg.runId !== undefined) {
          const shard = this.shardsByRun.get(msg.runId);
          if (shard) {
            this.finishShard(shard);
            this.failJob(shard.job, msg.message);
          }
        } else if (msg.reqId !== undefined) {
          const r = this.requests.get(msg.reqId);
          if (r) {
            this.requests.delete(msg.reqId);
            r.reject(new Error(msg.message));
          }
        } else if (msg.key !== undefined) {
          const l = slot.loading.get(msg.key);
          slot.loading.delete(msg.key);
          l?.reject(new Error(msg.message));
        } else {
          for (const l of slot.loading.values()) l.reject(new Error(msg.message));
          slot.loading.clear();
        }
        return;
      }
    }
  }

  private finishShard(shard: Shard): void {
    shard.done = true;
    this.shardsByRun.delete(shard.runId);
    shard.slot?.shards.delete(shard);
    const i = this.pendingShards.indexOf(shard);
    if (i >= 0) this.pendingShards.splice(i, 1);
  }

  private failJob(job: Job, message: string): void {
    if (job.finished) return;
    job.finished = true;
    this.jobs.delete(job.id);
    for (const s of job.shards) {
      if (!s.done && s.slot) s.slot.worker.postMessage({ type: 'cancel', runId: s.runId });
      this.finishShard(s);
    }
    job.handlers.onError(message);
    this.assign();
  }

  /** Workers that could take work for a key (loaded or loading it). */
  private liveSlots(key: string): Slot[] {
    return this.slots.filter((s) => !s.dead && (s.loaded.has(key) || s.loading.has(key)));
  }

  /** Active (assigned, unfinished, unpaused) shards on a slot at priority ≥ rank. */
  private busyAt(slot: Slot, rank: number): number {
    let n = 0;
    for (const s of slot.shards) if (!s.job.paused && PRIORITY_RANK[s.job.priority] >= rank) n++;
    return n;
  }

  /** Start a run. */
  start(key: string, configIn: Config, scopeIn: Scope, priority: Priority, handlers: JobHandlers, deterministic: boolean): Job {
    const config = plain(configIn);
    const scope = plain(scopeIn);
    this.ensureWorkers();
    if (this.lastLoad && this.lastLoad.key === key) {
      for (const s of this.slots) if (!s.dead && !s.loaded.has(key) && !s.loading.has(key)) void this.loadSlot(s, this.lastLoad).catch(() => {});
    }
    const job: Job = {
      id: this.nextId++,
      key,
      config,
      scope,
      priority,
      paused: false,
      shards: [],
      handlers,
      finished: false,
      startedAt: Date.now(),
    };
    const range: [number, number] = scope.replicates ?? [0, deterministic ? 1 : config.replicates];
    const nTargets = scopeTargetCount(scope, this.answerCounts.get(key) ?? 2500);
    let ranges: [number, number][] = [range];
    if (!deterministic && range[1] - range[0] >= 2 && nTargets * (range[1] - range[0]) >= SHARD_MIN_GAMES) {
      const rank = PRIORITY_RANK[priority];
      const idle = this.liveSlots(key).filter((s) => this.busyAt(s, rank) === 0).length;
      ranges = splitRange(range[0], range[1], Math.max(1, idle));
    }
    for (const r of ranges) {
      const shard: Shard = { runId: this.nextId++, job, range: r, slot: null, progress: null, summary: null, done: false, seq: this.seq++ };
      job.shards.push(shard);
      this.shardsByRun.set(shard.runId, shard);
      this.pendingShards.push(shard);
    }
    this.jobs.set(job.id, job);
    this.assign();
    return job;
  }

  /** Assign pending shards to workers in priority order. */
  private assign(): void {
    if (!this.pendingShards.length) return;
    this.pendingShards.sort((a, b) => PRIORITY_RANK[b.job.priority] - PRIORITY_RANK[a.job.priority] || a.seq - b.seq);
    const still: Shard[] = [];
    for (const shard of this.pendingShards) {
      const job = shard.job;
      if (job.finished || job.paused) {
        if (!job.finished) still.push(shard);
        continue;
      }
      const rank = PRIORITY_RANK[job.priority];
      const slots = this.liveSlots(job.key);
      if (!slots.length) {
        still.push(shard);
        continue;
      }
      // Prefer workers without work at this priority or above, then the least loaded; shards of one job spread out.
      const siblings = new Set(job.shards.map((s) => s.slot).filter(Boolean));
      let best: Slot | null = null;
      let bestScore = Infinity;
      for (const s of slots) {
        const busy = this.busyAt(s, rank);
        const score = busy * 100 + s.shards.size * 10 + (siblings.has(s) ? 1000 : 0) + s.index * 0.01;
        if (score < bestScore) [best, bestScore] = [s, score];
      }
      if (!best) {
        still.push(shard);
        continue;
      }
      // A full worker only takes a shard that outranks everything it is running.
      const full = best.shards.size >= SLOTS_PER_WORKER;
      if (full) {
        let maxRank = -1;
        for (const s of best.shards) if (!s.job.paused) maxRank = Math.max(maxRank, PRIORITY_RANK[s.job.priority]);
        if (rank <= maxRank) {
          still.push(shard);
          continue;
        }
      }
      shard.slot = best;
      best.shards.add(shard);
      const scope: Scope = { ...job.scope, replicates: shard.range };
      best.worker.postMessage({ type: 'run', runId: shard.runId, key: job.key, config: job.config, scope, priority: job.priority });
    }
    this.pendingShards = still;
  }

  setPriority(job: Job, priority: Priority): void {
    if (job.finished || job.priority === priority) return;
    job.priority = priority;
    for (const s of job.shards) if (s.slot && !s.done) s.slot.worker.postMessage({ type: 'priority', runId: s.runId, priority });
    this.assign();
  }

  pause(job: Job): void {
    if (job.finished || job.paused) return;
    job.paused = true;
    for (const s of job.shards) if (s.slot && !s.done) s.slot.worker.postMessage({ type: 'pause', runId: s.runId });
  }

  resume(job: Job): void {
    if (job.finished || !job.paused) return;
    job.paused = false;
    for (const s of job.shards) if (s.slot && !s.done) s.slot.worker.postMessage({ type: 'resume', runId: s.runId });
    this.assign();
  }

  cancel(job: Job): void {
    if (job.finished) return;
    job.finished = true;
    this.jobs.delete(job.id);
    for (const s of job.shards) {
      if (!s.done && s.slot) s.slot.worker.postMessage({ type: 'cancel', runId: s.runId });
      this.finishShard(s);
    }
    this.assign();
  }

  /** Send a request to the least busy worker that has the key loaded (or is loading it). */
  request<T>(build: (reqId: number) => ToWorker, key: string | null, transfer: Transferable[] = []): Promise<T> {
    this.ensureWorkers();
    const candidates = key ? this.liveSlots(key) : this.slots.filter((s) => !s.dead && (s.loaded.size > 0 || s.loading.size > 0));
    if (!candidates.length) return Promise.reject(new Error(key ? `word list ${key} is not loaded` : 'solver not loaded'));
    let best = candidates[0];
    for (const s of candidates) {
      const loadedFirst = key ? Number(!s.loaded.has(key)) - Number(!best.loaded.has(key)) : 0;
      if (loadedFirst < 0 || (loadedFirst === 0 && s.shards.size < best.shards.size)) best = s;
    }
    const reqId = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.requests.set(reqId, { resolve: resolve as (v: unknown) => void, reject, slot: best });
      try {
        best.worker.postMessage(plain(build(reqId)), transfer);
      } catch (e) {
        this.requests.delete(reqId);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  meta(): Promise<MetaResult> {
    return this.request<MetaResult>((reqId) => ({ type: 'meta', reqId }), null);
  }

  /** Jobs not yet finished (for diagnostics and tests). */
  activeJobs(): Job[] {
    return [...this.jobs.values()];
  }

  dispose(): void {
    for (const s of this.slots) s.worker.terminate();
    this.slots.length = 0;
  }
}
