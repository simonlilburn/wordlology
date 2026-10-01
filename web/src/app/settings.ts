// Settings persistence. Owned by the platform agent.
//
// - Display settings are kept per browser (localStorage).
// - Result settings are part of the configuration: they travel in the URL
//   hash (app/url.ts) rather than local storage, so a link reproduces them.
// - Saved strategies and recent openers are kept in this browser.
// - Player branches: "this session only" (sessionStorage) by default, or
//   "kept in this browser" (localStorage), keyed by word list and answer
//   selection; stored as words so indices can be rebuilt.

import { loadSaved, storeSaved } from '../lab/saved';
import { feedback as patternOf } from '../model/feedback';
import { answersSha256, normaliseWords } from '../model/sha256';
import type { WordData } from '../model/types';
import { wordDataKey } from '../model/wordlists';
import {
  app,
  DEFAULT_DISPLAY,
  DEFAULT_RESULT,
  type BoardGame,
  type DisplaySettings,
  type ResultSettings,
  type StrategyEntry,
} from './store.svelte';

const K_DISPLAY = 'wordlology:display:v1';
const K_RECENT = 'wordlology:recent-openers:v1';
const K_PLAYERS = 'wordlology:players:v1:';

function storage(kind: 'local' | 'session'): Storage | null {
  try {
    const s = kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

function readJson<T>(s: Storage | null, key: string): T | null {
  if (!s) return null;
  try {
    const v = s.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(s: Storage | null, key: string, v: unknown): void {
  if (!s) return;
  try {
    s.setItem(key, JSON.stringify(v));
  } catch {
    /* quota or privacy mode */
  }
}

/** Copy only keys of `defaults` whose values have the same type (arrays and objects shallowly checked). */
export function mergeSettings<T extends object>(defaults: T, raw: unknown): T {
  const out = structuredClone(defaults) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object') return out as T;
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(out)) {
    if (!(k in r)) continue;
    const d = out[k];
    const v = r[k];
    if (typeof d === 'number' && typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof d === 'boolean' && typeof v === 'boolean') out[k] = v;
    else if (typeof d === 'string' && typeof v === 'string') out[k] = v;
    else if (Array.isArray(d) && Array.isArray(v)) out[k] = v;
    else if (d && typeof d === 'object' && !Array.isArray(d) && v && typeof v === 'object') out[k] = v;
    else if (typeof d === 'string' && Array.isArray(v)) out[k] = v; // e.g. rankStrategySet: 'all' | string[]
  }
  return out as T;
}

const DISPLAY_CHOICES: Partial<Record<keyof DisplaySettings, readonly unknown[]>> = {
  palette: ['standard', 'high-contrast'],
  growthAnimation: ['full', 'fast', 'off'],
  filterScope: ['tree', 'all'],
  motion: ['system', 'reduced', 'full'],
};

/** Validate display settings (unknown choices fall back to defaults, numbers are clamped). */
export function sanitiseDisplay(d: DisplaySettings): DisplaySettings {
  const out = { ...d };
  for (const [k, choices] of Object.entries(DISPLAY_CHOICES)) {
    const key = k as keyof DisplaySettings;
    if (!choices!.includes(out[key])) (out as Record<string, unknown>)[key] = DEFAULT_DISPLAY[key];
  }
  out.counterfactualBranches = Math.round(out.counterfactualBranches);
  if (out.counterfactualBranches !== 0) out.counterfactualBranches = Math.min(5, Math.max(2, out.counterfactualBranches));
  out.labelThreshold = Math.min(16, Math.max(8, out.labelThreshold));
  out.exportWarnRows = Math.max(0, Math.round(out.exportWarnRows));
  return out;
}

const RESULT_CHOICES: Partial<Record<keyof ResultSettings, readonly unknown[]>> = {
  stochasticPool: ['candidates', 'allowed'],
  weighting: ['equal', 'frequency'],
  rankMetric: ['mean', 'fail_rate', 'le3', 'mean_fail_plus'],
};

/** Validate result settings from an untrusted source (a link). */
export function sanitiseResult(r: ResultSettings): ResultSettings {
  const out = structuredClone(r);
  for (const [k, choices] of Object.entries(RESULT_CHOICES)) {
    const key = k as keyof ResultSettings;
    if (!choices!.includes(out[key])) (out as unknown as Record<string, unknown>)[key] = DEFAULT_RESULT[key];
  }
  out.maxGuesses = Math.min(10, Math.max(4, Math.round(out.maxGuesses)));
  out.replicatesTree = Math.min(1000, Math.max(1, Math.round(out.replicatesTree)));
  out.replicatesCard = Math.min(1000, Math.max(1, Math.round(out.replicatesCard)));
  out.baseSeed = Math.round(out.baseSeed);
  out.rankKeep = Math.min(50, Math.max(1, Math.round(out.rankKeep)));
  const a = out.answers as { kind?: string; n?: unknown; words?: unknown };
  if (a.kind === 'top' && typeof a.n === 'number' && a.n >= 1) out.answers = { kind: 'top', n: Math.round(a.n) };
  else if (a.kind === 'pasted' && Array.isArray(a.words)) {
    const words = normaliseWords(a.words.map(String));
    out.answers = { kind: 'pasted', words, sha256: answersSha256(words) };
  } else out.answers = { kind: 'default' };
  if (!out.arrivalStrategy || typeof out.arrivalStrategy !== 'object' || typeof out.arrivalStrategy.kind !== 'string') {
    out.arrivalStrategy = structuredClone(DEFAULT_RESULT.arrivalStrategy);
  }
  return out;
}

export function loadDisplaySettings(): DisplaySettings {
  return sanitiseDisplay(mergeSettings(DEFAULT_DISPLAY, readJson(storage('local'), K_DISPLAY)));
}

export function saveDisplaySettings(d: DisplaySettings = app.display): void {
  writeJson(storage('local'), K_DISPLAY, JSON.parse(JSON.stringify(d)));
}

/** Restore display settings, saved strategies and recent openers into the store. */
export function restoreLocalSettings(): void {
  app.display = loadDisplaySettings();
  // Saved strategies use the Lab's storage (lab/saved.ts), so both agree on one key.
  const saved = loadSaved();
  if (saved.length && !app.saved.length) app.saved = saved;
  const recent = readJson<string[]>(storage('local'), K_RECENT);
  if (Array.isArray(recent)) app.focus.recentOpeners = recent.filter((w) => typeof w === 'string').slice(0, 8);
}

export function saveSavedStrategies(): void {
  storeSaved(JSON.parse(JSON.stringify(app.saved)) as StrategyEntry[]);
}

export function saveRecentOpeners(): void {
  writeJson(storage('local'), K_RECENT, [...app.focus.recentOpeners]);
}

/** Set a pasted answer list (the sha256 is computed here and kept in the settings). */
export function setPastedAnswers(words: string[]): void {
  const w = normaliseWords(words);
  app.result.answers = { kind: 'pasted', words: w, sha256: answersSha256(w) };
}

/** Reset every result and display setting to its default. */
export function resetSettings(): void {
  app.result = structuredClone(DEFAULT_RESULT);
  app.display = structuredClone(DEFAULT_DISPLAY);
}

/** Result settings that differ from the defaults (for the dots beside changed settings and the share link). */
export function changedResult(r: ResultSettings = app.result): Partial<ResultSettings> {
  const out: Partial<ResultSettings> = {};
  for (const k of Object.keys(DEFAULT_RESULT) as (keyof ResultSettings)[]) {
    if (JSON.stringify(r[k]) !== JSON.stringify(DEFAULT_RESULT[k])) (out as Record<string, unknown>)[k] = r[k];
  }
  return out;
}

/** Display settings that differ from the defaults. */
export function changedDisplay(d: DisplaySettings = app.display): Partial<DisplaySettings> {
  const out: Partial<DisplaySettings> = {};
  for (const k of Object.keys(DEFAULT_DISPLAY) as (keyof DisplaySettings)[]) {
    if (JSON.stringify(d[k]) !== JSON.stringify(DEFAULT_DISPLAY[k])) (out as Record<string, unknown>)[k] = d[k];
  }
  return out;
}

/** Whether one setting differs from its default. */
export function isChanged(group: 'result' | 'display', key: string): boolean {
  const cur = group === 'result' ? (app.result as unknown as Record<string, unknown>) : (app.display as unknown as Record<string, unknown>);
  const def = group === 'result' ? (DEFAULT_RESULT as unknown as Record<string, unknown>) : (DEFAULT_DISPLAY as unknown as Record<string, unknown>);
  return JSON.stringify(cur[key]) !== JSON.stringify(def[key]);
}

interface StoredPlayerGame {
  target: string;
  guesses: string[];
  status: BoardGame['status'];
}

function playersKey(words: WordData): string {
  return K_PLAYERS + wordDataKey(words);
}

/** Save player branches per the "Player branches" setting. */
export function savePlayerBranches(words: WordData | null = app.words): void {
  if (!words) return;
  const data: StoredPlayerGame[] = app.game.history.map((h) => ({
    target: words.guesses[words.answers[h.target]],
    guesses: h.guesses.map((g) => words.guesses[g]),
    status: h.status,
  }));
  const keep = app.display.keepPlayerBranches;
  writeJson(storage(keep ? 'local' : 'session'), playersKey(words), data);
  // Only one place holds them.
  try {
    storage(keep ? 'session' : 'local')?.removeItem(playersKey(words));
  } catch {
    /* ignore */
  }
}

/** Restore player branches for a word list (from this session, or this browser if kept). */
export function loadPlayerBranches(words: WordData): BoardGame[] {
  const keep = app.display.keepPlayerBranches;
  const data = readJson<StoredPlayerGame[]>(storage(keep ? 'local' : 'session'), playersKey(words));
  if (!Array.isArray(data)) return [];
  const out: BoardGame[] = [];
  for (const d of data) {
    if (!d || typeof d.target !== 'string' || !Array.isArray(d.guesses)) continue;
    const tid = words.index.get(d.target);
    if (tid === undefined || words.answerOf[tid] < 0) continue;
    const guesses = d.guesses.map((g) => words.index.get(g));
    if (guesses.some((g) => g === undefined)) continue;
    const ids = guesses as number[];
    const targetWord = d.target;
    const patterns = ids.map((g) => patternOf(words.guesses[g], targetWord));
    out.push({ target: words.answerOf[tid], guesses: ids, patterns, status: d.status });
  }
  return out;
}

