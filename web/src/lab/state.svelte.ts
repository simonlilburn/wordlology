// Strategy Lab state and actions. Owned by the panes agent.
//
// The Lab edits one draft at a time: a copy of a preset, a saved strategy, an
// imported one, or a new one. Saving writes app.saved (kept in this browser
// through lab/saved.ts, the same record app/settings.ts restores). "Use" and
// "Run full" commit the draft first, so every strategy in a view has a stable
// id: a preset id, or a saved strategy's id.
//
// Share links: "#lab=CODE" (lab.ts encodeShare). The hash is captured when
// this module loads, before the platform rewrites the address bar, and the
// Lab opens with that strategy as a draft (see StrategyLab.svelte).
import { setLevel, setStrategy } from '../app/actions';
import { app, type StrategyEntry } from '../app/store.svelte';
import type { Preset, StrategySpec } from '../backend/types';
import { plain, presetEntry, presets, schemas } from '../panes/services';
import { currentLevel } from '../panes/state.svelte';
import { attempt } from '../panes/util';
import { fillDefaults, labCodeFromHash, newSavedId, nextColour, parseImport, type ImportResult, uniqueLabel } from './lab';

export interface Draft {
  label: string;
  colour: string;
  spec: StrategySpec;
  /** The saved strategy this draft edits, or null (a new strategy or a preset copy). */
  savedId: string | null;
  /** The preset this draft started from, or null. */
  presetId: string | null;
}

export type EditorMode = 'form' | 'phases';

export const labState = $state({
  draft: null as Draft | null,
  /** docKey of the draft when it was loaded or last saved (for the unsaved-changes mark). */
  base: '',
  /** Bumps whenever the draft is replaced wholesale (editors re-initialise). */
  draftVersion: 0,
  mode: 'form' as EditorMode,
  /** Short status line ("Saved.", "Link copied."). */
  notice: '',
  /** Keep the current draft on the next opening (a shared link loaded it). */
  pinned: false,
});

/** The address bar hash when the app loaded (before the platform rewrites it). */
export const initialHash = typeof location !== 'undefined' ? location.hash : '';

/** Canonical JSON (keys sorted) for comparing specs. */
export function specKey(spec: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(o)
          .filter((k) => o[k] !== undefined)
          .sort()
          .map((k) => [k, sort(o[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(spec));
}

/** Identity of a draft's content (label, colour, spec). */
export function docKey(d: Pick<Draft, 'label' | 'colour' | 'spec'>): string {
  return specKey({ label: d.label, colour: d.colour, spec: d.spec });
}

/** Load a draft into the editor. */
export function loadDraft(d: Draft, mode: EditorMode = 'form'): void {
  const draft = plain({ ...d, spec: fillDefaults(plain(d.spec), schemas()) });
  labState.draft = draft;
  labState.base = docKey(draft);
  labState.draftVersion++;
  labState.mode = mode;
  labState.notice = '';
}

/** Whether the draft has edits since it was loaded or saved. */
export function hasEdits(): boolean {
  const d = labState.draft;
  return !!d && docKey(d) !== labState.base;
}

export function draftFromPreset(p: Preset): Draft {
  return { label: p.label, colour: p.colour, spec: p.spec, savedId: null, presetId: p.id };
}

export function draftFromSaved(e: StrategyEntry): Draft {
  return { label: e.label, colour: e.colour, spec: e.spec, savedId: e.id, presetId: null };
}

/** A new strategy draft (information-proportional, a fresh colour). */
export function newDraft(spec: StrategySpec = { kind: 'info_proportional', beta: 1, pool: 'candidates' }, label = 'My strategy'): Draft {
  return {
    label: uniqueLabel(label, takenLabels()),
    colour: nextColour(app.saved.map((s) => s.colour)),
    spec,
    savedId: null,
    presetId: null,
  };
}

/** A draft for the strategy in focus (the saved entry or preset it is, else a new copy). */
export function draftForFocus(): Draft {
  const f = app.focus.strategy;
  if (f) {
    const saved = app.saved.find((s) => s.id === f.id);
    if (saved) return draftFromSaved(saved);
    const preset = presets().find((p) => p.id === f.id);
    if (preset) return draftFromPreset(preset);
    return { label: f.label, colour: f.colour, spec: f.spec, savedId: null, presetId: null };
  }
  const p = presets()[0];
  return p ? draftFromPreset(p) : newDraft();
}

export function takenLabels(exceptId: string | null = null): string[] {
  return [...presets().map((p) => p.label), ...app.saved.filter((s) => s.id !== exceptId).map((s) => s.label)];
}

/** Draft from imported text (JSON, a share link or code); null with an error message on failure. */
export function draftFromImport(text: string): { draft: Draft | null; error: string } {
  const r: ImportResult = parseImport(text);
  if (!r.ok) return { draft: null, error: r.error };
  const d = newDraft(r.doc.spec, r.doc.label ?? 'Imported strategy');
  if (r.doc.colour) d.colour = r.doc.colour;
  return { draft: d, error: '' };
}

/** The share code in the address bar at load, if any. */
export function sharedDraft(): Draft | null {
  const code = labCodeFromHash(initialHash);
  if (!code) return null;
  return draftFromImport(code).draft;
}

/** Whether the draft differs from what it was loaded from. */
export function isDirty(d: Draft): boolean {
  if (d.savedId) {
    const s = app.saved.find((x) => x.id === d.savedId);
    return !s || s.label !== d.label || s.colour !== d.colour || specKey(s.spec) !== specKey(d.spec);
  }
  return true;
}

/** The preset the draft is identical to (same spec and label), if any. */
function unchangedPreset(d: Draft): Preset | undefined {
  if (d.savedId || !d.presetId) return undefined;
  const p = presets().find((x) => x.id === d.presetId);
  return p && specKey(fillDefaults(plain(p.spec), schemas())) === specKey(d.spec) && p.label === d.label ? p : undefined;
}

/** Replace copies of a saved entry held by the atlas and the focus. */
function propagate(entry: StrategyEntry): void {
  const cols = app.atlas.columns;
  if (cols.some((c) => c.id === entry.id)) app.atlas.columns = cols.map((c) => (c.id === entry.id ? plain(entry) : c));
  if (app.focus.strategy?.id === entry.id && specKey(app.focus.strategy.spec) !== specKey(entry.spec)) attempt(() => setStrategy(plain(entry)), undefined);
  else if (app.focus.strategy?.id === entry.id) app.focus.strategy = plain(entry);
}

/** Save the draft: update the saved entry it edits, or add a new one. Returns the entry. */
export function saveDraft(asNew = false): StrategyEntry | null {
  const d = labState.draft;
  if (!d) return null;
  const label = d.label.trim() || 'Untitled strategy';
  if (d.savedId && !asNew) {
    const entry: StrategyEntry = plain({ id: d.savedId, label: uniqueLabel(label, takenLabels(d.savedId)), colour: d.colour, spec: d.spec });
    const i = app.saved.findIndex((s) => s.id === d.savedId);
    if (i >= 0) app.saved[i] = entry;
    else app.saved.push(entry);
    d.label = entry.label;
    labState.base = docKey(d);
    propagate(entry);
    labState.notice = `Saved ${entry.label}.`;
    return entry;
  }
  const entry: StrategyEntry = plain({ id: newSavedId(), label: uniqueLabel(label, takenLabels()), colour: d.colour, spec: d.spec });
  app.saved.push(entry);
  d.savedId = entry.id;
  d.presetId = null;
  d.label = entry.label;
  labState.base = docKey(d);
  labState.notice = `Saved ${entry.label} to your library.`;
  return entry;
}

/** The entry to use for the draft: an unchanged preset as is, else the saved entry (saving first). */
export function commitDraft(): StrategyEntry | null {
  const d = labState.draft;
  if (!d) return null;
  const p = unchangedPreset(d);
  if (p) return presetEntry(p);
  if (d.savedId && !isDirty(d)) return plain(app.saved.find((s) => s.id === d.savedId)!);
  return saveDraft();
}

export function deleteSaved(id: string): void {
  const i = app.saved.findIndex((s) => s.id === id);
  if (i < 0) return;
  const [gone] = app.saved.splice(i, 1);
  const d = labState.draft;
  if (d && d.savedId === id) d.savedId = null;
  labState.notice = `Deleted ${gone.label}.`;
}

/** Use the draft in the views (focus it) and close the Lab. */
export function useDraft(): void {
  const e = commitDraft();
  if (!e) return;
  attempt(() => setStrategy(e), undefined);
  app.ui.lab = false;
}

/**
 * Run full: add the strategy as an Atlas column (seeding the grid with the
 * focused card first), focus it, and show the cards.
 */
export function runFull(): void {
  const e = commitDraft();
  if (!e) return;
  const a = app.atlas;
  const f = app.focus.strategy;
  if (!a.columns.length && f && f.id !== e.id) a.columns = [plain(f)];
  if (!a.rows.length) a.rows = [app.focus.opener];
  if (a.columns.some((c) => c.id === e.id)) a.columns = a.columns.map((c) => (c.id === e.id ? e : c));
  else a.columns = [...a.columns, e];
  attempt(() => setStrategy(e), undefined);
  app.ui.lab = false;
  if (currentLevel() < 2) attempt(() => setLevel(2), undefined);
}
