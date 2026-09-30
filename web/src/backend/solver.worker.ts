/// <reference lib="webworker" />
// Solver worker: hosts the WASM solver and implements the worker protocol
// (docs/architecture.md, "Worker protocol"). Runs execute in slices of about
// 20 ms; between slices the worker yields to its message queue (through a
// MessageChannel), so it can pause, cancel or switch runs. It always works on
// its highest-priority unpaused run, rotating between runs of equal priority
// so that several cards fill together.

import type { FromWorker, ToWorker } from './protocol';
import { PRIORITY_RANK, normaliseProgress, normaliseSummary } from './protocol';
import type { Priority } from './types';

type WasmModule = typeof import('../wasm/pkg/wl_wasm.js');
type Solver = InstanceType<WasmModule['Solver']>;

const SLICE_MS = 20;
/** Keep at most this many word lists (pattern matrices) loaded. */
const MAX_SOLVERS = 2;
/** Progress events at most this often per run (plus one with every batch that has games). */
const PROGRESS_EVERY_MS = 100;

const scope = self as unknown as DedicatedWorkerGlobalScope;

interface Job {
  runId: number;
  key: string;
  handle: number;
  priority: number;
  paused: boolean;
  lastSlice: number;
  lastProgress: number;
}

let wasmPromise: Promise<WasmModule> | null = null;
const solvers = new Map<string, { solver: Solver; used: number }>();
const jobs = new Map<number, Job>();
let sliceCounter = 0;
let scheduled = false;
/** Control messages for runs whose 'run' message is still queued (behind a load). */
const early = new Map<number, { cancelled?: boolean; paused?: boolean; priority?: Priority }>();

function earlyFor(runId: number) {
  let e = early.get(runId);
  if (!e) early.set(runId, (e = {}));
  return e;
}

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  scope.postMessage(msg, transfer);
}

function loadWasm(): Promise<WasmModule> {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      const mod = await import('../wasm/pkg/wl_wasm.js');
      await mod.default();
      return mod;
    })();
  }
  return wasmPromise;
}

function solverFor(key: string): Solver {
  const s = solvers.get(key);
  if (!s) throw new Error(`word list ${key} is not loaded in this worker`);
  s.used = performance.now();
  return s.solver;
}

function anySolver(): Solver {
  let best: { solver: Solver; used: number } | null = null;
  for (const s of solvers.values()) if (!best || s.used > best.used) best = s;
  if (!best) throw new Error('no word list loaded');
  return best.solver;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
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
      solvers.set(msg.key, { solver, used: performance.now() });
      while (solvers.size > MAX_SOLVERS) {
        // Drop the least recently used list, cancelling its runs.
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
      scope.postMessage({ type: 'result', reqId: msg.reqId, data: copy } satisfies FromWorker, [copy.buffer]);
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
  post({ type: 'progress', runId: job.runId, ...p });
  job.lastProgress = performance.now();
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
  entry.used = performance.now();
  try {
    const bytes = solver.step(job.handle, SLICE_MS);
    const nGames = bytes.length >= 8 ? bytes[6] | (bytes[7] << 8) : 0;
    if (nGames > 0) {
      const buffer = bytes.slice().buffer as ArrayBuffer;
      post({ type: 'games', runId: job.runId, buffer }, [buffer]);
    }
    const done = solver.isDone(job.handle);
    if (done || nGames > 0 || performance.now() - job.lastProgress > PROGRESS_EVERY_MS) sendProgress(job, solver);
    if (done) {
      const s = normaliseSummary(JSON.parse(solver.summary(job.handle)));
      jobs.delete(job.runId);
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

const channel = new MessageChannel();
channel.port1.onmessage = () => {
  scheduled = false;
  runSlice();
  schedule();
};

function schedule(): void {
  if (scheduled) return;
  let any = false;
  for (const job of jobs.values()) if (!job.paused) any = true;
  if (!any) return;
  scheduled = true;
  channel.port2.postMessage(0);
}

// Messages are handled in order; loads (which build the matrix) complete
// before later messages that need them.
let queue: Promise<void> = Promise.resolve();
scope.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  // Control messages act immediately so a pause or cancel never waits behind a load.
  if (msg.type === 'pause' || msg.type === 'resume' || msg.type === 'cancel' || msg.type === 'priority') {
    void handle(msg);
    return;
  }
  queue = queue.then(
    () =>
      handle(msg).catch((e) => {
        const m = errorMessage(e);
        if (msg.type === 'run') post({ type: 'error', runId: msg.runId, message: m });
        else if (msg.type === 'load') post({ type: 'error', key: msg.key, message: m });
        else post({ type: 'error', reqId: msg.reqId, message: m });
      }),
  );
};
