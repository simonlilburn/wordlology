// CacheBackend: wraps any backend with an IndexedDB cache of complete runs,
// keyed by config ID and scope, stored as binary game batches, least recently
// used first out, capped at 200 MB.

import { isDeterministicSpec } from '../app/config';
import { concatBuffers, decodeBatches, encodeGames } from './decode';
import { ForwardingRunStream, controlsOf, plain, scopeKey, type RunStream } from './stream';
import type {
  Capabilities,
  Config,
  ContinueRequest,
  Game,
  ProgressEvent,
  RunRequest,
  ScoresRequest,
  ScoresResult,
  SolverBackend,
  SummaryEvent,
  WordListManifest,
} from './types';

export const CACHE_CAP_BYTES = 200 * 1024 * 1024;
const DB_NAME = 'wordlology-cache';
const DB_VERSION = 1;
/** Games per event when replaying a cached run (keeps each frame's ingest small). */
const REPLAY_BATCH = 4000;

export interface CachedRun {
  key: string;
  data: ArrayBuffer;
  progress: ProgressEvent | null;
  summary: SummaryEvent;
}

interface CacheMeta {
  key: string;
  size: number;
  lastUsed: number;
}

/** Storage behind the cache (IndexedDB in browsers; a Map in tests). */
export interface CacheStore {
  get(key: string): Promise<CachedRun | undefined>;
  put(run: CachedRun): Promise<void>;
  delete(key: string): Promise<void>;
  touch(key: string): Promise<void>;
  meta(): Promise<CacheMeta[]>;
  clear(): Promise<void>;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export class IdbStore implements CacheStore {
  private db: Promise<IDBDatabase>;
  constructor(name = DB_NAME) {
    this.db = new Promise((resolve, reject) => {
      const open = indexedDB.open(name, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('runs')) db.createObjectStore('runs', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
  }
  async get(key: string): Promise<CachedRun | undefined> {
    const db = await this.db;
    return req(db.transaction('runs').objectStore('runs').get(key)) as Promise<CachedRun | undefined>;
  }
  async put(run: CachedRun): Promise<void> {
    const db = await this.db;
    const tx = db.transaction(['runs', 'meta'], 'readwrite');
    tx.objectStore('runs').put(run);
    tx.objectStore('meta').put({ key: run.key, size: run.data.byteLength, lastUsed: Date.now() } satisfies CacheMeta);
    await done(tx);
  }
  async delete(key: string): Promise<void> {
    const db = await this.db;
    const tx = db.transaction(['runs', 'meta'], 'readwrite');
    tx.objectStore('runs').delete(key);
    tx.objectStore('meta').delete(key);
    await done(tx);
  }
  async touch(key: string): Promise<void> {
    const db = await this.db;
    const tx = db.transaction('meta', 'readwrite');
    const store = tx.objectStore('meta');
    const m = (await req(store.get(key))) as CacheMeta | undefined;
    if (m) store.put({ ...m, lastUsed: Date.now() });
    await done(tx);
  }
  async meta(): Promise<CacheMeta[]> {
    const db = await this.db;
    return req(db.transaction('meta').objectStore('meta').getAll()) as Promise<CacheMeta[]>;
  }
  async clear(): Promise<void> {
    const db = await this.db;
    const tx = db.transaction(['runs', 'meta'], 'readwrite');
    tx.objectStore('runs').clear();
    tx.objectStore('meta').clear();
    await done(tx);
  }
}

/** In-memory store (tests, or browsers without IndexedDB). */
export class MemoryStore implements CacheStore {
  runs = new Map<string, CachedRun>();
  metas = new Map<string, CacheMeta>();
  private clock = 0;
  async get(key: string) {
    return this.runs.get(key);
  }
  async put(run: CachedRun) {
    this.runs.set(run.key, run);
    this.metas.set(run.key, { key: run.key, size: run.data.byteLength, lastUsed: ++this.clock });
  }
  async delete(key: string) {
    this.runs.delete(key);
    this.metas.delete(key);
  }
  async touch(key: string) {
    const m = this.metas.get(key);
    if (m) m.lastUsed = ++this.clock;
  }
  async meta() {
    return [...this.metas.values()];
  }
  async clear() {
    this.runs.clear();
    this.metas.clear();
  }
}

/** Keys to evict (least recently used first) so the total size fits the cap. */
export function evictionOrder(metas: CacheMeta[], cap: number): string[] {
  let total = metas.reduce((n, m) => n + m.size, 0);
  const out: string[] = [];
  for (const m of [...metas].sort((a, b) => a.lastUsed - b.lastUsed)) {
    if (total <= cap) break;
    out.push(m.key);
    total -= m.size;
  }
  return out;
}

export class CacheBackend implements SolverBackend {
  readonly id: string;
  private store: CacheStore | null;

  constructor(
    readonly inner: SolverBackend,
    store?: CacheStore | null,
    readonly cap = CACHE_CAP_BYTES,
  ) {
    this.id = `cache(${inner.id})`;
    if (store !== undefined) this.store = store;
    else {
      try {
        this.store = typeof indexedDB !== 'undefined' ? new IdbStore() : null;
      } catch {
        this.store = null;
      }
    }
  }

  capabilities(): Promise<Capabilities> {
    return this.inner.capabilities();
  }
  wordLists(): Promise<WordListManifest[]> {
    return this.inner.wordLists();
  }

  private async cacheKey(config: Config, scope: RunRequest['scope']): Promise<string | null> {
    if (!this.inner.configId) return null;
    const id = await this.inner.configId(config);
    const reps = isDeterministicSpec(config.strategy) ? 1 : config.replicates;
    return `${id}|${scopeKey(scope, reps)}`;
  }

  run(request: RunRequest, signal: AbortSignal): RunStream {
    const req = plain({ config: request.config, scope: request.scope, priority: request.priority });
    const out = new ForwardingRunStream();
    void (async () => {
      let key: string | null = null;
      if (this.store) {
        try {
          key = await this.cacheKey(req.config, req.scope);
          const hit = key ? await this.store.get(key) : undefined;
          if (hit && key) {
            if (signal.aborted) return out.end();
            void this.store.touch(key).catch(() => {});
            const games = decodeBatches(hit.data);
            for (let i = 0; i < games.length; i += REPLAY_BATCH) out.push({ type: 'games', games: games.slice(i, i + REPLAY_BATCH) });
            if (hit.progress) out.push(hit.progress);
            out.push(hit.summary);
            out.end();
            return;
          }
        } catch {
          key = null;
        }
      }
      if (signal.aborted) return out.end();
      const stream = this.inner.run(req, signal);
      out.attach(controlsOf(stream));
      const parts: ArrayBuffer[] = [];
      let progress: ProgressEvent | null = null;
      let summary: SummaryEvent | null = null;
      try {
        for await (const ev of stream) {
          if (ev.type === 'games') parts.push(ev.buffer ?? encodeGames(ev.games));
          else if (ev.type === 'progress') progress = ev;
          else if (ev.type === 'summary') summary = ev;
          out.push(ev);
        }
        out.end();
      } catch (e) {
        out.fail(e);
        return;
      }
      if (summary && key && this.store && !signal.aborted) void this.save(key, parts, progress, summary).catch(() => {});
    })().catch((e) => out.fail(e));
    return out;
  }

  private async save(key: string, parts: ArrayBuffer[], progress: ProgressEvent | null, summary: SummaryEvent): Promise<void> {
    const store = this.store!;
    const data = concatBuffers(parts);
    if (data.byteLength > this.cap) return;
    await store.put({ key, data, progress, summary });
    const evict = evictionOrder(await store.meta(), this.cap);
    for (const k of evict) if (k !== key) await store.delete(k);
  }

  /** Remove every cached run. */
  async clear(): Promise<void> {
    await this.store?.clear();
  }

  scores(req: ScoresRequest, signal?: AbortSignal): Promise<ScoresResult> {
    if (!this.inner.scores) return Promise.reject(new Error('scores are not available'));
    return this.inner.scores(req, signal);
  }
  openerInfo(config: Config, signal?: AbortSignal): Promise<Float64Array> {
    if (!this.inner.openerInfo) return Promise.reject(new Error('opener information is not available'));
    return this.inner.openerInfo(config, signal);
  }
  configId(config: Config): Promise<string> {
    if (!this.inner.configId) return Promise.reject(new Error('config IDs are not available'));
    return this.inner.configId(config);
  }
  continueGame(req: ContinueRequest, signal?: AbortSignal): Promise<Game> {
    if (!this.inner.continueGame) return Promise.reject(new Error('continuing games is not available'));
    return this.inner.continueGame(req, signal);
  }
}
