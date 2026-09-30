// Worker protocol (docs/architecture.md, "Worker protocol"). Shared by the
// pool (main thread) and solver.worker.ts.

import type { Config, Priority, ProgressEvent, Scope, SummaryEvent } from './types';

export type ToWorker =
  | {
      type: 'load';
      /** List id + answer selection (model/wordlists.ts wordDataKey). */
      key: string;
      /** Manifest object or its JSON text. */
      manifest: unknown;
      guesses: string;
      answers: string;
      frequencies: string | null;
    }
  /** `priority` is an extension: the worker works on its highest-priority unpaused run. */
  | { type: 'run'; runId: number; key: string; config: Config; scope: Scope; priority?: Priority }
  | { type: 'pause'; runId: number }
  | { type: 'resume'; runId: number }
  | { type: 'cancel'; runId: number }
  /** Extension: change a run's priority. */
  | { type: 'priority'; runId: number; priority: Priority }
  | { type: 'scores'; reqId: number; key: string; config: Config; history: { guess: number; pattern: number }[]; topK: number }
  | { type: 'openerInfo'; reqId: number; key: string; config: Config }
  | { type: 'configId'; reqId: number; key: string; config: Config }
  | {
      type: 'continue';
      reqId: number;
      key: string;
      config: Config;
      target: number;
      history: number[];
      replicate: number;
      oneStep: boolean;
    }
  | { type: 'meta'; reqId: number };

type ProgressFields = Omit<ProgressEvent, 'type'>;
type SummaryFields = Omit<SummaryEvent, 'type'>;

export type FromWorker =
  | { type: 'loaded'; key: string; matrixMs: number }
  | { type: 'games'; runId: number; buffer: ArrayBuffer }
  | ({ type: 'progress'; runId: number } & ProgressFields)
  | ({ type: 'summary'; runId: number } & SummaryFields)
  | { type: 'result'; reqId: number; data: unknown }
  | { type: 'error'; runId?: number; reqId?: number; key?: string; message: string };

export interface MetaResult {
  solverVersion: string;
  schemas: unknown[];
  presets: unknown[];
}

export const PRIORITY_RANK: Record<Priority, number> = { focused: 2, visible: 1, background: 0 };

/** Accept camelCase or snake_case progress JSON from the solver. */
export function normaliseProgress(raw: Record<string, unknown>): ProgressFields {
  const num = (a: string, b: string): number | undefined => {
    const v = raw[a] ?? raw[b];
    return typeof v === 'number' ? v : undefined;
  };
  const out: ProgressFields = {
    done: num('done', 'done') ?? 0,
    total: num('total', 'total') ?? 0,
    targetsDone: num('targetsDone', 'targets_done') ?? 0,
    targetsTotal: num('targetsTotal', 'targets_total') ?? 0,
  };
  const sd = num('settledDepth', 'settled_depth');
  if (sd !== undefined) out.settledDepth = sd;
  const un = num('unresolved', 'unresolved');
  if (un !== undefined) out.unresolved = un;
  return out;
}

/** Accept camelCase or snake_case summary JSON from the solver. */
export function normaliseSummary(raw: Record<string, unknown>): SummaryFields {
  return {
    configId: String(raw.configId ?? raw.config_id ?? ''),
    nGames: Number(raw.nGames ?? raw.n_games ?? 0),
    elapsedMs: Number(raw.elapsedMs ?? raw.elapsed_ms ?? 0),
    phases: Array.isArray(raw.phases) ? (raw.phases as unknown[]).map(String) : [],
    deterministic: Boolean(raw.deterministic),
  };
}
