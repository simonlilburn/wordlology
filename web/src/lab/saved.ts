// Saved strategies in this browser (localStorage). app.saved is the live list;
// the Lab loads it once at start and writes it back whenever it changes. The
// key and format (a plain JSON array of entries) are the ones app/settings.ts
// restores at start-up, so both sides read and write the same record.
import type { StrategyEntry } from '../app/store.svelte';

export const SAVED_KEY = 'wordlology:saved:v1';

function isEntry(x: unknown): x is StrategyEntry {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.label === 'string' &&
    typeof o.colour === 'string' &&
    !!o.spec &&
    typeof o.spec === 'object' &&
    typeof (o.spec as Record<string, unknown>).kind === 'string'
  );
}

/** Parse stored text; invalid entries are dropped. */
export function parseSaved(text: string | null): StrategyEntry[] {
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    const list = Array.isArray(v) ? v : Array.isArray(v?.entries) ? v.entries : [];
    return list.filter(isEntry).map((e: StrategyEntry) => ({ id: e.id, label: e.label, colour: e.colour, spec: e.spec }));
  } catch {
    return [];
  }
}

export function loadSaved(storage: Pick<Storage, 'getItem'> | null = safeStorage()): StrategyEntry[] {
  try {
    return parseSaved(storage?.getItem(SAVED_KEY) ?? null);
  } catch {
    return [];
  }
}

export function storeSaved(entries: StrategyEntry[], storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(SAVED_KEY, JSON.stringify(entries.map((e) => ({ id: e.id, label: e.label, colour: e.colour, spec: e.spec }))));
  } catch {
    // Storage full or blocked: saved strategies stay for this session only.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
