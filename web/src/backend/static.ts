// StaticBackend: serves runs precomputed by `wordlology precompute` from
// /precomputed/, and forwards everything else to the backend it wraps.
//
// /precomputed/index.json:
//   {
//     "solver_version": "0.1.0",
//     "entries": [
//       { "config_id": "0123456789abcdef",
//         "scope": { "targets": "all" },          // a Scope; replicates default to [0, replicates)
//         "replicates": 20,                       // the configuration's (canonical) replicate count
//         "file": "0123456789abcdef-all.wlgb",    // concatenated binary game batches
//         "summary": { "phases": ["info"], "deterministic": false, "elapsed_ms": 812 }   // optional
//       }
//     ]
//   }

import { isDeterministicSpec } from '../app/config';
import { decodeBatches } from './decode';
import { normaliseSummary } from './protocol';
import { ForwardingRunStream, controlsOf, scopeKey, type RunStream } from './stream';
import type {
  Capabilities,
  Config,
  ContinueRequest,
  Game,
  RunRequest,
  Scope,
  ScoresRequest,
  ScoresResult,
  SolverBackend,
  WordListManifest,
} from './types';

export interface StaticEntry {
  config_id: string;
  scope: Scope;
  replicates?: number;
  file: string;
  summary?: Record<string, unknown>;
}

export interface StaticIndex {
  solver_version?: string;
  entries: StaticEntry[];
}

const REPLAY_BATCH = 4000;

export class StaticBackend implements SolverBackend {
  readonly id: string;
  private index: Promise<Map<string, StaticEntry>> | null = null;

  constructor(
    readonly inner: SolverBackend,
    readonly base: string = `${import.meta.env?.BASE_URL ?? '/'}precomputed/`,
    private fetcher: typeof fetch = (...args) => fetch(...args),
  ) {
    this.id = `static(${inner.id})`;
  }

  /** Index entries by `${config_id}|${scopeKey}`. */
  loadIndex(): Promise<Map<string, StaticEntry>> {
    if (!this.index) {
      this.index = (async () => {
        const map = new Map<string, StaticEntry>();
        try {
          const res = await this.fetcher(`${this.base}index.json`);
          if (!res.ok) return map;
          const idx = (await res.json()) as StaticIndex;
          for (const e of idx.entries ?? []) {
            if (!e || typeof e.config_id !== 'string' || typeof e.file !== 'string') continue;
            const reps = e.replicates ?? e.scope?.replicates?.[1] ?? 1;
            map.set(`${e.config_id}|${scopeKey(e.scope ?? { targets: 'all' }, reps)}`, e);
          }
        } catch {
          /* no precomputed results */
        }
        return map;
      })();
    }
    return this.index;
  }

  capabilities(): Promise<Capabilities> {
    return this.inner.capabilities();
  }
  wordLists(): Promise<WordListManifest[]> {
    return this.inner.wordLists();
  }

  private async find(config: Config, scope: Scope): Promise<StaticEntry | null> {
    if (!this.inner.configId) return null;
    const index = await this.loadIndex();
    if (!index.size) return null;
    const id = await this.inner.configId(config);
    const reps = isDeterministicSpec(config.strategy) ? 1 : config.replicates;
    return index.get(`${id}|${scopeKey(scope, reps)}`) ?? null;
  }

  run(req: RunRequest, signal: AbortSignal): RunStream {
    const out = new ForwardingRunStream();
    void (async () => {
      let entry: StaticEntry | null = null;
      try {
        entry = await this.find(req.config, req.scope);
      } catch {
        entry = null;
      }
      if (signal.aborted) return out.end();
      if (entry) {
        try {
          const res = await this.fetcher(this.base + entry.file);
          if (!res.ok) throw new Error(`precomputed file ${entry.file}: ${res.status}`);
          const games = decodeBatches(await res.arrayBuffer());
          if (signal.aborted) return out.end();
          for (let i = 0; i < games.length; i += REPLAY_BATCH) out.push({ type: 'games', games: games.slice(i, i + REPLAY_BATCH) });
          const targets = new Set(games.map((g) => g.target)).size;
          out.push({ type: 'progress', done: games.length, total: games.length, targetsDone: targets, targetsTotal: targets });
          const s = normaliseSummary(entry.summary ?? {});
          out.push({
            type: 'summary',
            configId: entry.config_id,
            nGames: games.length,
            elapsedMs: s.elapsedMs,
            phases: s.phases,
            deterministic: entry.summary?.deterministic !== undefined ? s.deterministic : isDeterministicSpec(req.config.strategy),
          });
          out.end();
          return;
        } catch {
          /* fall through to computing it */
        }
      }
      const stream = this.inner.run(req, signal);
      out.attach(controlsOf(stream));
      try {
        for await (const ev of stream) out.push(ev);
        out.end();
      } catch (e) {
        out.fail(e);
      }
    })().catch((e) => out.fail(e));
    return out;
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
