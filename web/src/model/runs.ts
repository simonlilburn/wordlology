// Run manager: shared runs keyed by config ID and scope. Owned by the platform agent.
//
// runs.request(config, scope, priority) returns a shared Run at once; its
// `games` array grows as batches arrive. The run is keyed locally by a
// canonical form of the configuration until the solver has computed the
// config ID, then by `${configId}|${scopeKey}` as well.

import { isDeterministicSpec, localConfigKey } from '../app/config';
import { backend as defaultBackend } from '../backend';
import { controlsOf, scopeKey, type RunControls } from '../backend/stream';
import type { Config, Priority, Scope, SolverBackend } from '../backend/types';
import type { Run, RunManager, RunStatus } from './types';

const PRIORITY_RANK: Record<Priority, number> = { focused: 2, visible: 1, background: 0 };
/** Completed runs kept in the manager's map (by games held); older ones are forgotten (the cache has them). */
const KEEP_GAMES = 600_000;

export interface RunManagerImpl extends RunManager {
  /** Every run the manager holds. */
  all(): Run[];
  /** Look up by the local key (before the config ID is known). */
  getLocal(config: Config, scope: Scope): Run | undefined;
  /** Forget every run (e.g. after the word list changes); running ones are cancelled. */
  reset(): void;
  /** Called with every run the manager creates. */
  onRun(cb: (run: Run) => void): () => void;
  /** Forget a finished run so its games can be garbage-collected once nobody else holds it. */
  release(run: Run): void;
}

class RunImpl implements Run {
  key: string;
  configId = '';
  games: Run['games'] = [];
  progress: Run['progress'] = null;
  summary: Run['summary'] = null;
  status: RunStatus = 'queued';
  error: string | null = null;
  deterministic: boolean;
  phases: string[] = [];
  version = 0;
  priority: Priority;
  readonly localKey: string;
  readonly scopeKey: string;
  private listeners = new Set<(run: Run) => void>();
  private controls: Partial<RunControls> | null = null;
  readonly abort = new AbortController();
  lastUsed = Date.now();
  paused = false;

  constructor(
    public config: Config,
    public scope: Scope,
    priority: Priority,
    localKey: string,
    private manager: Manager,
  ) {
    this.priority = priority;
    this.localKey = localKey;
    this.deterministic = isDeterministicSpec(config.strategy);
    this.scopeKey = scopeKey(scope, this.deterministic ? 1 : config.replicates);
    this.key = localKey;
  }

  onChange(cb: (run: Run) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  bump(): void {
    this.version++;
    for (const cb of [...this.listeners]) {
      try {
        cb(this);
      } catch (e) {
        console.error(e);
      }
    }
  }

  attach(controls: Partial<RunControls>): void {
    this.controls = controls;
    if (this.paused) controls.pause?.();
  }

  setPriority(p: Priority): void {
    if (p === this.priority) return;
    this.priority = p;
    this.controls?.setPriority?.(p);
    this.bump();
  }

  /** Pause computing (not part of the Run contract; used by rankings and tests). */
  pause(): void {
    if (this.paused || this.isFinal()) return;
    this.paused = true;
    this.controls?.pause?.();
    if (this.status === 'running' || this.status === 'queued') this.status = 'paused';
    this.bump();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.controls?.resume?.();
    if (this.status === 'paused') this.status = this.games.length || this.progress ? 'running' : 'queued';
    this.bump();
  }

  isFinal(): boolean {
    return this.status === 'done' || this.status === 'error' || this.status === 'cancelled';
  }

  /** A method, so status checks after an await are not narrowed away by TypeScript. */
  isCancelled(): boolean {
    return this.status === 'cancelled';
  }

  cancel(): void {
    if (this.isFinal()) return;
    this.status = 'cancelled';
    this.abort.abort();
    this.manager.forget(this);
    this.bump();
  }
}

class Manager implements RunManagerImpl {
  private byLocal = new Map<string, RunImpl>();
  private byKey = new Map<string, RunImpl>();
  private runListeners = new Set<(run: Run) => void>();

  constructor(private getBackend: () => SolverBackend) {}

  request(config: Config, scope: Scope, priority: Priority = 'visible'): Run {
    const plain = JSON.parse(JSON.stringify(config)) as Config;
    const deterministic = isDeterministicSpec(plain.strategy);
    if (deterministic) plain.replicates = 1;
    const sk = scopeKey(scope, plain.replicates);
    const local = `${localConfigKey(plain)}|${sk}`;
    const existing = this.byLocal.get(local);
    if (existing && existing.status !== 'cancelled' && existing.status !== 'error') {
      existing.lastUsed = Date.now();
      if (PRIORITY_RANK[priority] > PRIORITY_RANK[existing.priority]) existing.setPriority(priority);
      if (existing.paused) existing.resume();
      return existing;
    }
    const run = new RunImpl(plain, JSON.parse(JSON.stringify(scope)) as Scope, priority, local, this);
    this.byLocal.set(local, run);
    for (const cb of this.runListeners) cb(run);
    void this.drive(run);
    this.trim();
    return run;
  }

  private async drive(run: RunImpl): Promise<void> {
    const backend = this.getBackend();
    try {
      if (backend.configId) {
        const id = await backend.configId(run.config);
        run.configId = id;
        run.key = `${id}|${run.scopeKey}`;
        if (!this.byKey.has(run.key)) this.byKey.set(run.key, run);
      }
      if (run.status === 'cancelled') return;
      const stream = backend.run({ config: run.config, scope: run.scope, priority: run.priority }, run.abort.signal);
      run.attach(controlsOf(stream));
      // A priority change before the stream existed.
      controlsOf(stream).setPriority?.(run.priority);
      for await (const ev of stream) {
        if (run.isCancelled()) break;
        if (run.status === 'queued') run.status = run.paused ? 'paused' : 'running';
        if (ev.type === 'games') {
          for (const g of ev.games) run.games.push(g);
        } else if (ev.type === 'progress') {
          run.progress = ev;
        } else if (ev.type === 'summary') {
          run.summary = ev;
          run.phases = ev.phases;
          run.deterministic = ev.deterministic;
          if (!run.configId && ev.configId) {
            run.configId = ev.configId;
            run.key = `${ev.configId}|${run.scopeKey}`;
            if (!this.byKey.has(run.key)) this.byKey.set(run.key, run);
          }
          run.status = 'done';
        }
        run.bump();
      }
      if (run.status !== 'done' && !run.isCancelled()) {
        // The stream ended without a summary (aborted elsewhere).
        run.status = 'cancelled';
        this.forget(run);
        run.bump();
      }
    } catch (e) {
      if (run.status === 'cancelled') return;
      run.status = 'error';
      run.error = e instanceof Error ? e.message : String(e);
      this.forget(run);
      run.bump();
    }
  }

  forget(run: RunImpl): void {
    if (this.byLocal.get(run.localKey) === run) this.byLocal.delete(run.localKey);
    if (this.byKey.get(run.key) === run) this.byKey.delete(run.key);
  }

  /** Forget the least recently used completed runs beyond the budget. */
  private trim(): void {
    let total = 0;
    for (const r of this.byLocal.values()) total += r.games.length;
    if (total <= KEEP_GAMES) return;
    const done = [...this.byLocal.values()].filter((r) => r.status === 'done').sort((a, b) => a.lastUsed - b.lastUsed);
    for (const r of done) {
      if (total <= KEEP_GAMES) break;
      total -= r.games.length;
      this.forget(r);
    }
  }

  get(key: string): Run | undefined {
    return this.byKey.get(key) ?? this.byLocal.get(key);
  }

  getLocal(config: Config, scope: Scope): Run | undefined {
    const plain = JSON.parse(JSON.stringify(config)) as Config;
    if (isDeterministicSpec(plain.strategy)) plain.replicates = 1;
    return this.byLocal.get(`${localConfigKey(plain)}|${scopeKey(scope, plain.replicates)}`);
  }

  async configId(config: Config): Promise<string> {
    const b = this.getBackend();
    if (!b.configId) throw new Error('this backend cannot compute config IDs');
    return b.configId(config);
  }

  all(): Run[] {
    return [...this.byLocal.values()];
  }

  reset(): void {
    for (const r of [...this.byLocal.values()]) if (!r.isFinal()) r.cancel();
    this.byLocal.clear();
    this.byKey.clear();
  }

  onRun(cb: (run: Run) => void): () => void {
    this.runListeners.add(cb);
    return () => this.runListeners.delete(cb);
  }

  release(run: Run): void {
    const r = run as RunImpl;
    if (r.isFinal?.()) this.forget(r);
  }
}

/** A run manager over a backend (tests pass a fake). */
export function createRunManager(getBackend: () => SolverBackend): RunManagerImpl {
  return new Manager(getBackend);
}

let backendGetter: () => SolverBackend = () => defaultBackend;

/** Point the shared manager at another backend (tests inject a fake). */
export function setRunBackend(get: () => SolverBackend): void {
  backendGetter = get;
}

export const runs: RunManagerImpl = createRunManager(() => backendGetter());

/** Pause/resume helpers for runs from this manager. */
export function pauseRun(run: Run): void {
  (run as Partial<RunImpl>).pause?.();
}
export function resumeRun(run: Run): void {
  (run as Partial<RunImpl>).resume?.();
}
