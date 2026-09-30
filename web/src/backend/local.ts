// LocalWasmBackend: runs the solver in the worker pool.

import { localConfigKey, isDeterministicSpec } from '../app/config';
import { DEFAULT_LIST_ID, selectionKey, wordDataKey } from '../model/wordlists';
import type { WordData } from '../model/types';
import { decodeBatches } from './decode';
import { WorkerPool, type Job, type WorkerLike } from './pool';
import type { MetaResult } from './protocol';
import { ForwardingRunStream, plain, type RunStream } from './stream';
import type {
  Capabilities,
  Config,
  ContinueRequest,
  Game,
  Preset,
  RunRequest,
  ScoresRequest,
  ScoresResult,
  SolverBackend,
  StrategySchema,
  WordListManifest,
} from './types';

/** The load key of a configuration's word list and answer selection. */
export function configListKey(config: Config): string {
  return `${config.word_list.id}@${config.word_list.version}/${selectionKey(config.word_list.answers)}`;
}

export function createSolverWorker(): WorkerLike {
  return new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module', name: 'wordlology-solver' }) as unknown as WorkerLike;
}

export class LocalWasmBackend implements SolverBackend {
  readonly id = 'local-wasm';
  readonly pool: WorkerPool;
  private caps: Promise<Capabilities> | null = null;
  private configIds = new Map<string, Promise<string>>();
  private openerInfos = new Map<string, Promise<Float64Array>>();
  private words: WordData | null = null;
  /** Resolves once some word list has loaded in the workers. */
  private loadedOnce: Promise<void>;
  private markLoaded!: () => void;
  matrixMs = 0;

  constructor(createWorker: () => WorkerLike = createSolverWorker, size?: number) {
    this.pool = new WorkerPool(createWorker, size);
    this.loadedOnce = new Promise((res) => (this.markLoaded = res));
  }

  /** Load a word list (and answer selection) into every worker; resolves when the matrices are built. */
  async setWords(words: WordData): Promise<number> {
    this.words = words;
    const ms = await this.pool.load(
      {
        key: wordDataKey(words),
        manifest: words.manifest,
        guesses: words.texts.guesses,
        answers: words.texts.answers,
        frequencies: words.texts.frequencies,
      },
      words.answers.length,
    );
    this.matrixMs = ms;
    this.markLoaded();
    return ms;
  }

  capabilities(): Promise<Capabilities> {
    if (!this.caps) {
      this.caps = this.loadedOnce
        .then(() => this.pool.meta())
        .then((m: MetaResult) => ({
          solverVersion: m.solverVersion,
          strategies: m.schemas as StrategySchema[],
          presets: m.presets as Preset[],
          wordLists: [DEFAULT_LIST_ID],
          exactMode: false,
          maxReplicates: 1000,
        }));
      this.caps.catch(() => (this.caps = null));
    }
    return this.caps;
  }

  async wordLists(): Promise<WordListManifest[]> {
    if (this.words) return [this.words.manifest];
    const res = await fetch(`${import.meta.env.BASE_URL}wordlists/${DEFAULT_LIST_ID}/manifest.json`);
    return [(await res.json()) as WordListManifest];
  }

  run(request: RunRequest, signal: AbortSignal): RunStream {
    // Callers may pass Svelte $state proxies, which cannot be posted to a worker.
    const req = plain({ config: request.config, scope: request.scope, priority: request.priority });
    const out = new ForwardingRunStream();
    const key = configListKey(req.config);
    const deterministic = isDeterministicSpec(req.config.strategy);
    const config: Config = deterministic ? { ...req.config, replicates: 1 } : req.config;
    let job: Job | null = null;
    const start = () => {
      if (signal.aborted) {
        out.end();
        return;
      }
      job = this.pool.start(key, config, req.scope, req.priority ?? 'visible', {
        onGames: (buffer) => {
          try {
            const games = decodeBatches(buffer);
            out.push({ type: 'games', games, buffer });
          } catch (e) {
            out.fail(e);
            if (job) this.pool.cancel(job);
          }
        },
        onProgress: (p) => out.push(p),
        onSummary: (s) => {
          out.push(s);
          out.end();
        },
        onError: (m) => out.fail(new Error(m)),
      }, deterministic);
      const j = job;
      out.attach({
        setPriority: (p) => this.pool.setPriority(j, p),
        pause: () => this.pool.pause(j),
        resume: () => this.pool.resume(j),
      });
    };
    signal.addEventListener('abort', () => {
      if (job) this.pool.cancel(job);
      out.end();
    });
    out.onReturn = () => {
      if (job) this.pool.cancel(job);
    };
    if (this.pool.isLoaded(key)) start();
    else this.loadedOnce.then(start, (e) => out.fail(e));
    return out;
  }

  configId(configIn: Config): Promise<string> {
    const config = plain(configIn);
    const k = localConfigKey(config);
    let p = this.configIds.get(k);
    if (!p) {
      const listKey = configListKey(config);
      p = this.loadedOnce.then(() =>
        this.pool.request<string>((reqId) => ({ type: 'configId', reqId, key: listKey, config }), listKey),
      );
      p.catch(() => this.configIds.delete(k));
      this.configIds.set(k, p);
    }
    return p;
  }

  scores(request: ScoresRequest, signal?: AbortSignal): Promise<ScoresResult> {
    const req = plain(request);
    const key = configListKey(req.config);
    const p = this.pool.request<ScoresResult>(
      (reqId) => ({ type: 'scores', reqId, key, config: req.config, history: req.history, topK: req.topK }),
      key,
    );
    return withSignal(p, signal);
  }

  openerInfo(configIn: Config, signal?: AbortSignal): Promise<Float64Array> {
    const config = plain(configIn);
    const key = configListKey(config);
    const k = `${key}|${config.rules.hard_mode}|${config.rules.max_guesses}`;
    let p = this.openerInfos.get(k);
    if (!p) {
      p = this.pool.request<Float64Array>((reqId) => ({ type: 'openerInfo', reqId, key, config }), key);
      p.catch(() => this.openerInfos.delete(k));
      this.openerInfos.set(k, p);
    }
    return withSignal(p, signal);
  }

  async continueGame(request: ContinueRequest, signal?: AbortSignal): Promise<Game> {
    const req = plain(request);
    const key = configListKey(req.config);
    const buffer = await withSignal(
      this.pool.request<ArrayBuffer>(
        (reqId) => ({
          type: 'continue',
          reqId,
          key,
          config: req.config,
          target: req.target,
          history: req.history,
          replicate: req.replicate,
          oneStep: req.oneStep,
        }),
        key,
      ),
      signal,
    );
    const games = decodeBatches(buffer);
    if (!games.length) throw new Error('the solver returned no game');
    return games[0];
  }
}

function withSignal<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
