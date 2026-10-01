// Guarded access to the platform from the panes and the Lab: the solver
// backend (created by the platform in backend/index.ts), config building, and
// the strategy catalogue with fallbacks. Everything degrades to null or a
// fallback while the platform's pieces are missing or still throw.
import type { Config, Preset, SolverBackend, StrategySchema, StrategySpec } from '../backend/types';
import { isDeterministicSpec, makeConfig, specLabel } from '../app/config';
import { app, type StrategyEntry } from '../app/store.svelte';
import { effectiveSchemas, FALLBACK_PRESETS } from '../lab/catalogue';
import { specDeterministic } from '../lab/lab';
import { attempt } from './util';

// A glob import resolves to nothing while the module does not exist, instead of failing the build.
const backendModules = import.meta.glob('../backend/index.ts');
let backendPromise: Promise<SolverBackend | null> | null = null;

function isBackend(x: unknown): x is SolverBackend {
  return !!x && typeof x === 'object' && typeof (x as SolverBackend).run === 'function';
}

async function pickBackend(mod: Record<string, unknown>): Promise<SolverBackend | null> {
  for (const name of ['backend', 'default']) if (isBackend(mod[name])) return mod[name] as SolverBackend;
  for (const name of ['getBackend', 'backend', 'default']) {
    const f = mod[name];
    if (typeof f === 'function') {
      try {
        const b = await (f as () => unknown)();
        if (isBackend(b)) return b;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** The app's solver backend, or null if there is none yet. */
export function getBackend(): Promise<SolverBackend | null> {
  if (backendPromise) return backendPromise;
  const load = backendModules['../backend/index.ts'];
  if (!load) return Promise.resolve(null);
  backendPromise = load()
    .then((m) => pickBackend(m as Record<string, unknown>))
    .catch(() => null)
    .then((b) => {
      if (!b) backendPromise = null;
      return b;
    });
  return backendPromise;
}

/** One-step expected information of every guess (opener screening), or null. */
export async function openerInfo(config: Config): Promise<Float64Array | null> {
  const b = await getBackend();
  if (!b?.openerInfo) return null;
  try {
    return await b.openerInfo(config);
  } catch {
    return null;
  }
}

/** Strategy schemas: the backend's (app.catalogue), else the fallback catalogue. */
export function schemas(): StrategySchema[] {
  return effectiveSchemas(app.catalogue?.schemas);
}

/** Presets: the backend's (app.catalogue), else the fallback catalogue. */
export function presets(): Preset[] {
  const p = app.catalogue?.presets;
  return p && p.length ? p : FALLBACK_PRESETS;
}

/** The strategy in focus, falling back to the arrival strategy. */
export function focusedSpec(): StrategySpec {
  return app.focus.strategy?.spec ?? app.result.arrivalStrategy;
}

export function deterministic(spec: StrategySpec): boolean {
  return attempt(() => isDeterministicSpec(spec), specDeterministic(spec));
}

export function labelOf(spec: StrategySpec): string {
  return attempt(() => specLabel(spec), spec.kind.replace(/_/g, ' '));
}

/** A configuration from the result settings, as a plain object (safe to post to workers), or null. */
export function configFor(strategy: StrategySpec, opener: string | null, kind: 'tree' | 'card', replicates?: number): Config | null {
  return attempt<Config | null>(() => plain(makeConfig({ strategy: plain(strategy), opener, kind, replicates })), null);
}

/** A plain deep copy of a possibly proxied value. */
export function plain<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** Whether the loaded word list has frequencies (true while unknown, so nothing is disabled early). */
export function hasFrequencies(): boolean {
  return app.words ? app.words.zipf !== null : true;
}

/** Same spec (key order ignored). */
export function sameSpec(a: StrategySpec | null | undefined, b: StrategySpec | null | undefined): boolean {
  if (!a || !b) return false;
  return sortedJson(a) === sortedJson(b);
}

function sortedJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${sortedJson(o[k])}`)
    .join(',')}}`;
}

/** Whether `entry` is the strategy in focus. */
export function isCurrent(entry: { id: string; spec: StrategySpec }): boolean {
  const f = app.focus.strategy;
  if (f) return f.id === entry.id;
  return sameSpec(entry.spec, app.result.arrivalStrategy);
}

export function presetEntry(p: Preset): StrategyEntry {
  return { id: p.id, label: p.label, colour: p.colour, spec: p.spec };
}

/** Word of an answer index, or ''. */
export function answerWord(target: number): string {
  const w = app.words;
  if (!w || target < 0 || target >= w.answers.length) return '';
  return w.guesses[w.answers[target]] ?? '';
}

/** Whether the target is the player's current unsolved game (its word must stay hidden). */
export function isSpoiler(target: number): boolean {
  const b = app.game.board;
  return !!b && b.status === 'playing' && b.target === target;
}
