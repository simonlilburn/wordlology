// Strategies in share links: a catalogue preset travels as its id, anything
// else (saved or Lab strategies) as its full entry. Owned by the platform agent.

import type { Preset } from '../backend/types';
import { FALLBACK_PRESETS } from '../lab/catalogue';
import { strategyJson } from './config';
import { app, type StrategyEntry } from './store.svelte';

/** A preset id pending until the solver's catalogue has loaded. */
let pendingPreset: string | null = null;

function knownPresets(): Preset[] {
  const p = app.catalogue.presets;
  return p && p.length ? p : FALLBACK_PRESETS;
}

function samePreset(entry: StrategyEntry, p: Preset): boolean {
  if (entry.id !== p.id) return false;
  try {
    return strategyJson(entry.spec) === strategyJson(p.spec);
  } catch {
    return false;
  }
}

/** How a strategy entry is written into a link. */
export function strategyForLink(entry: StrategyEntry): { presetId: string } | StrategyEntry {
  const preset = knownPresets().find((p) => samePreset(entry, p));
  if (preset) return { presetId: preset.id };
  return { id: entry.id, label: entry.label, colour: entry.colour, spec: JSON.parse(JSON.stringify(entry.spec)) };
}

function entryOf(p: Preset): StrategyEntry {
  return { id: p.id, label: p.label, colour: p.colour, spec: JSON.parse(JSON.stringify(p.spec)) };
}

/** Focus the strategy of a link. A preset id the catalogue does not know yet waits for it. */
export function applyStrategyFromLink(s: { presetId: string } | StrategyEntry): void {
  if ('presetId' in s) {
    const preset = knownPresets().find((p) => p.id === s.presetId);
    if (preset) {
      app.focus.strategy = entryOf(preset);
      pendingPreset = null;
    } else {
      pendingPreset = s.presetId;
    }
    return;
  }
  pendingPreset = null;
  const saved = app.saved.find((e) => e.id === s.id && strategyJson(e.spec) === strategyJson(s.spec));
  app.focus.strategy = saved ? { ...saved, spec: JSON.parse(JSON.stringify(saved.spec)) } : { ...s, spec: JSON.parse(JSON.stringify(s.spec)) };
}

/** Resolve a preset id that arrived before the catalogue (called once the catalogue loads). Returns true if applied. */
export function resolvePendingLinkStrategy(): boolean {
  if (!pendingPreset) return false;
  const preset = app.catalogue.presets.find((p) => p.id === pendingPreset);
  pendingPreset = null;
  if (!preset) return false;
  app.focus.strategy = entryOf(preset);
  return true;
}
