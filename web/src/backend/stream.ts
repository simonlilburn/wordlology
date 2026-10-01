// Push-based async streams for run events, with run controls that composed
// backends forward to the backend actually computing the run.

import type { Priority, RunEvent, Scope } from './types';

/** What SolverBackend.run returns in this app: run events plus controls. */
export interface RunStream extends AsyncIterable<RunEvent> {
  setPriority(p: Priority): void;
  pause(): void;
  resume(): void;
}

export interface RunControls {
  setPriority(p: Priority): void;
  pause(): void;
  resume(): void;
}

/** An async iterable fed by push(); end() finishes it, fail() makes the consumer throw. */
export class EventStream<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiters: { resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void }[] = [];
  private ended = false;
  private error: unknown = null;
  private returned = false;
  onReturn: (() => void) | null = null;

  push(v: T): void {
    if (this.ended || this.returned) return;
    const w = this.waiters.shift();
    if (w) w.resolve({ value: v, done: false });
    else this.queue.push(v);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const w of this.waiters.splice(0)) w.resolve({ value: undefined, done: true });
  }

  fail(e: unknown): void {
    if (this.ended) return;
    this.error = e ?? new Error('run failed');
    this.ended = true;
    for (const w of this.waiters.splice(0)) w.reject(this.error);
  }

  get isEnded(): boolean {
    return this.ended;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.queue.length) return Promise.resolve({ value: this.queue.shift()!, done: false });
        if (this.ended) {
          if (this.error) {
            const e = this.error;
            this.error = null;
            return Promise.reject(e);
          }
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
      return: () => {
        this.returned = true;
        this.queue.length = 0;
        this.end();
        this.onReturn?.();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/** A RunStream whose controls go to whichever inner stream is attached (remembering calls made before). */
export class ForwardingRunStream extends EventStream<RunEvent> implements RunStream {
  private target: Partial<RunControls> | null = null;
  private priority: Priority | null = null;
  private paused = false;

  attach(target: Partial<RunControls>): void {
    this.target = target;
    if (this.priority) target.setPriority?.(this.priority);
    if (this.paused) target.pause?.();
  }

  setPriority(p: Priority): void {
    this.priority = p;
    this.target?.setPriority?.(p);
  }

  pause(): void {
    this.paused = true;
    this.target?.pause?.();
  }

  resume(): void {
    this.paused = false;
    this.target?.resume?.();
  }
}

/** Controls of a stream returned by any backend (no-ops when it has none). */
export function controlsOf(stream: AsyncIterable<RunEvent>): Partial<RunControls> {
  return stream as Partial<RunControls>;
}

/** The replicate range a scope covers for a configuration's replicate count. */
export function scopeRange(scope: Scope, replicates: number): [number, number] {
  return scope.replicates ? [scope.replicates[0], scope.replicates[1]] : [0, replicates];
}

/**
 * A plain, structured-cloneable copy of a value (Svelte $state proxies cannot
 * be posted to workers). Typed arrays and ArrayBuffers are kept as they are.
 */
export function plain<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return v;
  return JSON.parse(JSON.stringify(v)) as T;
}

/** FNV-1a 32-bit hash as 8 hex digits (for compact keys of long lists). */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * A canonical key for a scope, given the configuration's (canonical)
 * replicate count, so that `{targets:'all'}` and
 * `{targets:'all', replicates:[0, R]}` share one key.
 */
export function scopeKey(scope: Scope, replicates: number): string {
  let t: string;
  if (scope.targets === 'all') t = 'all';
  else if (Array.isArray(scope.targets)) {
    const list = scope.targets.join(',');
    t = list.length <= 48 ? `t${list}` : `t${scope.targets.length}-${fnv1a(list)}`;
  } else t = `s${scope.targets.sample}`;
  const [a, b] = scopeRange(scope, replicates);
  return `${t}/r${a}-${b}`;
}
