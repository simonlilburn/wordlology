// The solver worker's logic (docs/architecture.md, "Worker protocol"),
// independent of the worker global so tests can run it in-process with the
// real WASM package. solver.worker.ts wires it to `self`.
//
// Runs execute in slices of about 20 ms; between slices the host yields to
// its message queue (through a MessageChannel), so it can pause, cancel or
// switch runs. It always works on its highest-priority unpaused run,
// rotating between runs of equal priority so that several cards fill
// together.

import type { FromWorker, ToWorker } from './protocol';
import { PRIORITY_RANK, normaliseProgress, normaliseSummary } from './protocol';
import type { Priority } from './types';

export type WasmModule = typeof import('../wasm/pkg/wl_wasm.js');
type Solver = InstanceType<WasmModule['Solver']>;

export const SLICE_MS = 20;
/** Keep at most this many word lists (pattern matrices) loaded. */
const MAX_SOLVERS = 2;
/** Progress events at most this often per run (plus one with every batch that has games). */
const PROGRESS_EVERY_MS = 100;
const HEADER_BYTES = 8;

export interface HostDeps {
  post(msg: FromWorker, transfer?: Transferable[]): void;
  /** Load and initialise the WASM package. */
  loadWasm(): Promise<WasmModule>;
  /** Yield to the message queue, then call fn (default: a MessageChannel). */
  yieldThen?: (fn: () => void) => void;
  now?: () => number;
}

interface Job {
  runId: number;
  key: string;
  handle: number;
  priority: number;
  paused: boolean;
  lastSlice: number;
  lastProgress: number;
  /** Phase labels were sent with an earlier progress event. */
  sentPhases?: boolean;
}

export interface WorkerHost {
  onmessage(msg: ToWorker): void;
  /** Runs in progress (tests). */
  activeRuns(): number;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function channelYield(): (fn: () => void) => void {
  if (typeof MessageChannel === 'undefined') return (fn) => setTimeout(fn, 0);
  const channel = new MessageChannel();
  let pending: (() => void) | null = null;
  channel.port1.onmessage = () => {
    const f = pending;
    pending = null;
    f?.();
  };
  // Node keeps a process alive while a port is referenced.
  (channel.port1 as unknown as { unref?: () => void }).unref?.();
  return (fn) => {
    pending = fn;
    channel.port2.postMessage(0);
  };
}

export function createWorkerHost(deps: HostDeps): WorkerHost {
  const now = deps.now ?? (() => performance.now());
  const yieldThen = deps.yieldThen ?? channelYield();
  let wasmPromise: Promise<WasmModule> | null = null;
  const solvers = new Map<string, { solver: Solver; used: number }>();
  const jobs = new Map<number, Job>();
  let sliceCounter = 0;
  let scheduled = false;
  /** Control messages for runs whose 'run' message is still queued (behind a load). */
  const early = new Map<number, { cancelled?: boolean; paused?: boolean; priority?: Priority }>();
  const post = deps.post;

  function earlyFor(runId: number) {
    let e = early.get(runId);
    if (!e) early.set(runId, (e = {}));
    return e;
  }

  function loadWasm(): Promise<WasmModule> {
    if (!wasmPromise) {
      wasmPromise = deps.loadWasm();
      wasmPromise.catch(() => (wasmPromise = null));
    }
    return wasmPromise;
  }

  function solverFor(key: string): Solver {
    const s = solvers.get(key);
    if (!s) throw new Error(`word list ${key} is not loaded in this worker`);
    s.used = now();
    return s.solver;
  }

  function anySolver(): Solver {
    let best: { solver: Solver; used: number } | null = null;
    for (const s of solvers.values()) if (!best || s.used > best.used) best = s;
    if (!best) throw new Error('no word list loaded');
    return best.solver;
  }

  async function handle(msg: ToWorker): Promise<void> {
    switch (msg.type) {
      case 'load': {
        const wasm = await loadWasm();
        if (solvers.has(msg.key)) {
          const s = solverFor(msg.key);
          post({ type: 'loaded', key: msg.key, matrixMs: s.matrixMs });
          return;
        }
        const manifest = typeof msg.manifest === 'string' ? msg.manifest : JSON.stringify(msg.manifest);
        const solver = new wasm.Solver(manifest, msg.guesses, msg.answers, msg.frequencies ?? undefined);
        solvers.set(msg.key, { solver, used: now() });
        while (solvers.size > MAX_SOLVERS) {
          // Drop the least recently used list, failing its runs.
          let oldKey = '';
          let oldUsed = Infinity;
          for (const [k, s] of solvers) if (k !== msg.key && s.used < oldUsed) [oldKey, oldUsed] = [k, s.used];
          if (!oldKey) break;
          for (const job of [...jobs.values()]) {
            if (job.key !== oldKey) continue;
            jobs.delete(job.runId);
            post({ type: 'error', runId: job.runId, message: 'word list unloaded' });
          }
          solvers.get(oldKey)!.solver.free();
          solvers.delete(oldKey);
        }
        post({ type: 'loaded', key: msg.key, matrixMs: solver.matrixMs });
        return;
      }
      case 'run': {
        const pre = early.get(msg.runId);
        early.delete(msg.runId);
        if (pre?.cancelled) return;
        const solver = solverFor(msg.key);
        const handle = solver.startRun(JSON.stringify(msg.config), JSON.stringify(msg.scope));
        jobs.set(msg.runId, {
          runId: msg.runId,
          key: msg.key,
          handle,
          priority: PRIORITY_RANK[pre?.priority ?? msg.priority ?? 'visible'],
          paused: pre?.paused ?? false,
          lastSlice: -1,
          lastProgress: 0,
        });
        schedule();
        return;
      }
      case 'pause': {
        const job = jobs.get(msg.runId);
        if (job) job.paused = true;
        else earlyFor(msg.runId).paused = true;
        return;
      }
      case 'resume': {
        const job = jobs.get(msg.runId);
        if (job) job.paused = false;
        else earlyFor(msg.runId).paused = false;
        schedule();
        return;
      }
      case 'priority': {
        const job = jobs.get(msg.runId);
        if (job) job.priority = PRIORITY_RANK[msg.priority] ?? job.priority;
        else earlyFor(msg.runId).priority = msg.priority;
        schedule();
        return;
      }
      case 'cancel': {
        const job = jobs.get(msg.runId);
        if (!job) {
          earlyFor(msg.runId).cancelled = true;
          return;
        }
        jobs.delete(msg.runId);
        try {
          solvers.get(job.key)?.solver.cancel(job.handle);
        } catch {
          /* already finished */
        }
        return;
      }
      case 'scores': {
        const s = solverFor(msg.key);
        const data = JSON.parse(s.scores(JSON.stringify(msg.config), JSON.stringify(msg.history), msg.topK));
        post({ type: 'result', reqId: msg.reqId, data });
        return;
      }
      case 'openerInfo': {
        const s = solverFor(msg.key);
        const info = s.openerInfo(JSON.stringify(msg.config));
        const copy = new Float64Array(info);
        post({ type: 'result', reqId: msg.reqId, data: copy }, [copy.buffer]);
        return;
      }
      case 'configId': {
        const s = solverFor(msg.key);
        post({ type: 'result', reqId: msg.reqId, data: s.configId(JSON.stringify(msg.config)) });
        return;
      }
      case 'continue': {
        const s = solverFor(msg.key);
        const bytes = s.continueGame(JSON.stringify(msg.config), msg.target, JSON.stringify(msg.history), msg.replicate, msg.oneStep);
        const buffer = bytes.slice().buffer as ArrayBuffer;
        post({ type: 'result', reqId: msg.reqId, data: buffer }, [buffer]);
        return;
      }
      case 'meta': {
        const wasm = await loadWasm();
        const s = anySolver();
        post({
          type: 'result',
          reqId: msg.reqId,
          data: { solverVersion: wasm.Solver.solverVersion(), schemas: JSON.parse(s.schemas()), presets: JSON.parse(s.presets()) },
        });
        return;
      }
    }
  }

  function pickJob(): Job | null {
    let best: Job | null = null;
    for (const job of jobs.values()) {
      if (job.paused) continue;
      if (!best || job.priority > best.priority || (job.priority === best.priority && job.lastSlice < best.lastSlice)) best = job;
    }
    return best;
  }

  function sendProgress(job: Job, solver: Solver): void {
    const p = normaliseProgress(JSON.parse(solver.progress(job.handle)));
    // The first progress event carries the strategy's phase labels, so partial
    // results (and partial exports) can name phases before the summary arrives.
    if (!job.sentPhases) {
      job.sentPhases = true;
      try {
        const phases = normaliseSummary(JSON.parse(solver.summary(job.handle))).phases;
        if (phases.length) p.phases = phases;
      } catch {
        /* the summary will carry them */
      }
    }
    post({ type: 'progress', runId: job.runId, ...p });
    job.lastProgress = now();
  }

  function runSlice(): void {
    const job = pickJob();
    if (!job) return;
    job.lastSlice = ++sliceCounter;
    const entry = solvers.get(job.key);
    if (!entry) {
      jobs.delete(job.runId);
      post({ type: 'error', runId: job.runId, message: `word list ${job.key} is not loaded` });
      return;
    }
    const solver = entry.solver;
    entry.used = now();
    try {
      const bytes = solver.step(job.handle, SLICE_MS);
      // A batch with games is longer than its header (several batches may be concatenated).
      const hasGames = bytes.length > HEADER_BYTES;
      if (hasGames) {
        const buffer = bytes.slice().buffer as ArrayBuffer;
        post({ type: 'games', runId: job.runId, buffer }, [buffer]);
      }
      const done = solver.isDone(job.handle);
      if (done || hasGames || now() - job.lastProgress > PROGRESS_EVERY_MS) sendProgress(job, solver);
      if (done) {
        const s = normaliseSummary(JSON.parse(solver.summary(job.handle)));
        jobs.delete(job.runId);
        try {
          solver.cancel(job.handle); // frees the finished run's state
        } catch {
          /* ignore */
        }
        post({ type: 'summary', runId: job.runId, ...s });
      }
    } catch (e) {
      jobs.delete(job.runId);
      try {
        solver.cancel(job.handle);
      } catch {
        /* ignore */
      }
      post({ type: 'error', runId: job.runId, message: errorMessage(e) });
    }
  }

  function schedule(): void {
    if (scheduled) return;
    let any = false;
    for (const job of jobs.values()) if (!job.paused) any = true;
    if (!any) return;
    scheduled = true;
    yieldThen(() => {
      scheduled = false;
      runSlice();
      schedule();
    });
  }

  // Messages are handled in order; loads (which build the matrix) complete
  // before later messages that need them.
  let queue: Promise<void> = Promise.resolve();
  return {
    onmessage(msg: ToWorker): void {
      // Control messages act immediately so a pause or cancel never waits behind a load.
      if (msg.type === 'pause' || msg.type === 'resume' || msg.type === 'cancel' || msg.type === 'priority') {
        void handle(msg);
        return;
      }
      queue = queue.then(() =>
        handle(msg).catch((e) => {
          const m = errorMessage(e);
          if (msg.type === 'run') post({ type: 'error', runId: msg.runId, message: m });
          else if (msg.type === 'load') post({ type: 'error', key: msg.key, message: m });
          else post({ type: 'error', reqId: msg.reqId, message: m });
        }),
      );
    },
    activeRuns: () => jobs.size,
  };
}
