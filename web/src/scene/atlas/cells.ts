// Card data per (strategy, opener): the run, a CardAccumulator fed from it,
// and the latest snapshot. Shared by the card and atlas layers and by the DOM
// overlays (tables, margins, sorting, compare). No three.js in here.

import type { Config, Priority, StrategySpec } from '../../backend/types';
import { app, type StrategyEntry } from '../../app/store.svelte';
import { makeConfig, isDeterministicSpec } from '../../app/config';
import { runs } from '../../model/runs';
import { CardAccumulator } from '../../model/card';
import { focusData } from '../../model/focus';
import { targetWeights } from '../../model/wordlists';
import type { CardSnapshot, Run } from '../../model/types';
import { displayFromSnapshot, emptyDisplay, type CardDisplay } from '../card/display';
import { gridWithFocus } from './grid';

export function cellKey(strategyId: string, opener: string | null): string {
  return `${strategyId}|${opener ?? ''}`;
}

export function sameSpec(a: StrategySpec | undefined, b: StrategySpec | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Games ingested per poll at most, so a large cached run never stalls a frame. */
const INGEST_BUDGET = 25_000;

export class Cell {
  config: Config | null = null;
  configJson = '';
  run: Run | null = null;
  acc: CardAccumulator | null = null;
  /** The accumulator is the focus module's (it ingests; we only read). */
  external = false;
  ingested = 0;
  seenRunVersion = -1;
  seenAccVersion = -1;
  snapshot: CardSnapshot | null = null;
  display: CardDisplay;
  /** Increments whenever the display changes. */
  version = 0;
  error: string | null = null;
  priority: Priority = 'background';
  deterministic = false;
  /** Time (ms, performance.now) the card completed while being watched; drives the border flash. */
  completedAt = -Infinity;
  private wasComplete = false;
  private retryAt = 0;
  lastUsed = 0;

  constructor(
    public key: string,
    public strategy: StrategyEntry,
    public opener: string | null,
  ) {
    this.display = emptyDisplay(app.result.maxGuesses);
  }

  get label(): string {
    return this.strategy.label;
  }

  get maxGuesses(): number {
    return this.config?.rules.max_guesses ?? app.result.maxGuesses;
  }

  get replicates(): number {
    return this.config?.replicates ?? 1;
  }

  get complete(): boolean {
    return !!this.snapshot?.complete;
  }

  /** Mean guesses of the current estimate (NaN until something arrived). */
  get mean(): number {
    return this.snapshot && this.snapshot.nGames > 0 ? this.snapshot.mean : NaN;
  }

  setPriority(p: Priority): void {
    this.priority = p;
    if (this.run && this.run.priority !== p) {
      try {
        this.run.setPriority(p);
      } catch {
        /* run manager not ready */
      }
    }
  }

  private reset(): void {
    this.config = null;
    this.configJson = '';
    this.run = null;
    this.acc = null;
    this.external = false;
    this.ingested = 0;
    this.seenRunVersion = -1;
    this.seenAccVersion = -1;
    this.snapshot = null;
    this.display = emptyDisplay(app.result.maxGuesses);
    this.wasComplete = false;
    this.completedAt = -Infinity;
    this.version++;
  }

  /** Start (or restart after a settings change) the run. Safe to call every frame. */
  ensureRun(now: number): void {
    const words = app.words;
    if (!words) return;
    let config: Config;
    try {
      config = makeConfig({ strategy: this.strategy.spec, opener: this.opener, kind: 'card' });
    } catch (e) {
      this.error = 'Configuration unavailable';
      return;
    }
    const json = JSON.stringify(config);
    if (json === this.configJson && this.run) return;
    if (json !== this.configJson) this.reset();
    if (now < this.retryAt) return;
    this.config = config;
    this.configJson = json;
    try {
      this.deterministic = isDeterministicSpec(this.strategy.spec);
    } catch {
      this.deterministic = config.replicates <= 1;
    }
    let run: Run;
    try {
      run = runs.request(config, { targets: 'all' }, this.priority);
    } catch (e) {
      this.error = 'Solver not ready';
      this.configJson = '';
      this.retryAt = now + 1000;
      return;
    }
    this.run = run;
    this.error = null;
    if (run.deterministic) this.deterministic = true;
    const fd = focusData;
    if (fd.cardRun && fd.card && fd.cardRun.key === run.key && fd.card.nTargets === words.answers.length) {
      this.acc = fd.card;
      this.external = true;
    } else {
      try {
        this.acc = new CardAccumulator(
          config.rules.max_guesses,
          words.answers.length,
          this.deterministic,
          config.replicates,
          safeWeights(config),
        );
      } catch {
        this.acc = null;
      }
      this.external = false;
    }
  }

  /** Pull new games and progress into the accumulator; returns true if the display changed. */
  poll(now: number): boolean {
    this.lastUsed = now;
    this.ensureRun(now);
    const run = this.run, acc = this.acc;
    if (!run || !acc) return false;
    // The focus module may replace its accumulator; follow it.
    if (this.external && focusData.card !== acc) {
      if (focusData.cardRun?.key === run.key && focusData.card) this.acc = focusData.card;
      else {
        this.configJson = '';
        this.ensureRun(now);
        return false;
      }
    }
    const a = this.acc!;
    let changed = false;
    if (run.version !== this.seenRunVersion || (this.external && a.version !== this.seenAccVersion)) {
      if (!this.external) {
        const games = run.games;
        if (this.ingested < games.length) {
          const end = Math.min(games.length, this.ingested + INGEST_BUDGET);
          try {
            a.ingest(games.slice(this.ingested, end));
          } catch {
            /* accumulator not implemented yet */
          }
          this.ingested = end;
        }
        try {
          if (run.progress) a.progress(run.progress);
          if (run.status === 'done' && this.ingested >= games.length) a.markComplete();
        } catch {
          /* ignore */
        }
        // Only mark the run as seen once every game has been ingested.
        if (this.ingested >= games.length) this.seenRunVersion = run.version;
      } else {
        this.seenRunVersion = run.version;
      }
      this.seenAccVersion = a.version;
      try {
        const s = a.snapshot();
        this.snapshot = s;
        this.display = displayFromSnapshot(s, this.replicates);
        if (run.deterministic) this.deterministic = true;
        this.error = null;
        changed = true;
      } catch {
        this.error = run.status === 'error' ? run.error ?? 'Run failed' : null;
      }
      if (run.status === 'error') this.error = run.error ?? 'Run failed';
    }
    const complete = !!this.snapshot?.complete;
    if (complete && !this.wasComplete) {
      // Flash only when completion is witnessed (not for a card that arrives complete).
      if (this.snapshot && this.version > 1) this.completedAt = now;
      this.wasComplete = true;
    }
    if (changed) this.version++;
    return changed;
  }
}

function safeWeights(config: Config): Float64Array | null {
  const words = app.words;
  if (!words) return null;
  try {
    return targetWeights(words, config.weighting);
  } catch {
    return null;
  }
}

/** All cells by key. Cells unused for a while are dropped. */
class CellStore {
  private map = new Map<string, Cell>();

  get(strategy: StrategyEntry, opener: string | null): Cell {
    const key = cellKey(strategy.id, opener);
    let c = this.map.get(key);
    if (c && !sameSpec(c.strategy.spec, strategy.spec)) {
      // The strategy was edited in the Lab: same id, new spec.
      c = undefined;
    }
    if (!c) {
      c = new Cell(key, strategy, opener);
      this.map.set(key, c);
    } else if (c.strategy !== strategy) {
      c.strategy = strategy;
    }
    return c;
  }

  peek(strategyId: string, opener: string | null): Cell | undefined {
    return this.map.get(cellKey(strategyId, opener));
  }

  /** The cell for the focused configuration, or null. */
  focus(): Cell | null {
    const s = app.focus.strategy;
    if (!s) return null;
    return this.get(s, app.focus.opener);
  }

  /** Drop cells not in `keep` that have not been used for `ageMs`. */
  prune(keep: Set<string>, now: number, ageMs = 60_000): void {
    for (const [k, c] of this.map) {
      if (!keep.has(k) && now - c.lastUsed > ageMs) {
        c.setPriority('background');
        this.map.delete(k);
      }
    }
  }

  all(): Cell[] {
    return [...this.map.values()];
  }
}

export const cells = new CellStore();

/** The strategy columns and opener rows actually shown (falls back to the focus). */
export function gridAxes(): { columns: StrategyEntry[]; rows: (string | null)[] } {
  const cols = app.atlas.columns.length > 0 ? app.atlas.columns : app.focus.strategy ? [app.focus.strategy] : [];
  const rows = app.atlas.rows.length > 0 ? app.atlas.rows : [app.focus.opener];
  return { columns: cols, rows };
}

/** Whether the grid has two or more cells (the Atlas layout at card zoom). */
export function gridActive(): boolean {
  const { columns, rows } = gridAxes();
  return columns.length * rows.length >= 2;
}

/** Index of the focused cell in the grid, or null. */
export function focusCellIndex(): [number, number] | null {
  const s = app.focus.strategy;
  if (!s) return null;
  const { columns, rows } = gridAxes();
  const c = columns.findIndex((x) => x.id === s.id);
  const r = rows.findIndex((x) => x === app.focus.opener);
  return c >= 0 && r >= 0 ? [c, r] : null;
}

/**
 * Seed the atlas from the focus when it is first shown, and keep the focused
 * card in the grid (see grid.ts: a lone column or row follows the focus, a
 * longer one gains the new entry).
 */
export function seedAtlas(): void {
  const s = app.focus.strategy;
  if (!s) return;
  const a = app.atlas;
  const next = gridWithFocus(a.columns, a.rows, s, app.focus.opener);
  if (!next.changed) return;
  const colsChanged = next.columns.length !== a.columns.length || next.columns.some((c, i) => c !== a.columns[i]);
  const rowsChanged = next.rows.length !== a.rows.length || next.rows.some((r, i) => r !== a.rows[i]);
  if (colsChanged) a.columns = next.columns.map((c) => (c === s ? plainEntry(s) : c));
  if (rowsChanged) a.rows = next.rows;
  if (a.selected.length) a.selected = [];
}

function plainEntry(e: StrategyEntry): StrategyEntry {
  return JSON.parse(JSON.stringify(e)) as StrategyEntry;
}

/** Whether the atlas needs seeding to contain the focus. */
export function atlasNeedsSeed(): boolean {
  const s = app.focus.strategy;
  if (!s) return false;
  const a = app.atlas;
  return (
    a.columns.length === 0 ||
    a.rows.length === 0 ||
    !a.columns.some((c) => c.id === s.id) ||
    !a.rows.includes(app.focus.opener)
  );
}
