// Export entry points. Owned by the platform agent.
//
// openExport(level) opens the dialog (ExportDialog.svelte, mounted by
// App.svelte); the dialog calls prepareExport / runExport. copyRCode copies
// the R snippet for the zip just exported (or for the one the current level
// would produce) and confirms with a toast. exportRanking writes a ranking
// panel's ranking.csv (plus configs and distribution rows of full entries).

import { toast } from '../app/actions';
import { localConfigKey, makeConfig } from '../app/config';
import { app, type StrategyEntry } from '../app/store.svelte';
import { currentLevel } from '../app/zoom';
import { fnv1a } from '../backend/stream';
import type { Config } from '../backend/types';
import { focusConfigs, focusData } from '../model/focus';
import type { Ranking } from '../model/rankings';
import { runs } from '../model/runs';
import type { Run, WordData } from '../model/types';
import { strToU8, zipSync } from 'fflate';
import {
  buildExport,
  estimateRows,
  exportConfigOf,
  isoNow,
  playerGamesFor,
  rowFilterOf,
  snippetFor,
  type BuiltExport,
  type ExportSource,
} from './build';
import { cardOf, configsCsv, distributionCsv, rankingCsv, type ExportConfig, type ExportLevelSpec, type ExportOptions, type RankingRow } from './csv';
import { rSnippet, zipName } from './rcode';
import { exportState } from './state.svelte';

export type ExportLevel = 'tree' | 'card' | 'atlas';

/** The app version recorded in configs.csv. */
export const APP_VERSION: string = `wordlology-web ${(import.meta.env?.VITE_APP_VERSION as string | undefined) ?? '0.0.0'}`;

/** The level an export at the current zoom exports. */
export function levelForZoom(): ExportLevel {
  const l = currentLevel();
  return l >= 3 ? 'atlas' : l === 2 ? 'card' : 'tree';
}

/** Open the export dialog for a level (size guard, partial export, filter limit). */
export function openExport(level?: ExportLevel): void {
  exportState.level = level ?? levelForZoom();
  app.ui.exportDialog = true;
}

async function configIdOf(run: Run | null, config: Config): Promise<string> {
  if (run?.configId) return run.configId;
  try {
    return await runs.configId(config);
  } catch {
    return `local-${fnv1a(localConfigKey(config))}`;
  }
}

/** Every configuration of the atlas grid (columns × rows); the focused card when the grid is empty. */
function atlasSources(words: WordData): ExportSource[] {
  const cols = app.atlas.columns.length ? app.atlas.columns : app.focus.strategy ? [app.focus.strategy] : [];
  const rows = app.atlas.rows.length ? app.atlas.rows : [app.focus.opener];
  const out: ExportSource[] = [];
  for (const col of cols) {
    for (const opener of rows) {
      const config = makeConfig({ strategy: col.spec, opener, kind: 'card' });
      const run = runs.getLocal(config, { targets: 'all' }) ?? runs.request(config, { targets: 'all' }, 'visible');
      out.push({ run, config, strategyId: col.id, strategyLabel: col.label, nTargets: words.answers.length });
    }
  }
  return out;
}

function focusEntry(): StrategyEntry | null {
  return app.focus.strategy;
}

/** What an export of a level would contain now. */
export interface PreparedExport {
  level: ExportLevelSpec;
  configs: ExportConfig[];
  options: ExportOptions;
  /** Estimated rows (games, plays and paired rows). */
  rows: number;
  /** Whether some run is still computing (a partial export). */
  partial: boolean;
  targetsFinished: number;
  targetsTotal: number;
  /** A letter filter is active. */
  filterActive: boolean;
  /** Why nothing can be exported, if so. */
  empty: string | null;
}

/** Gather an export of a level from the app's runs. */
export async function prepareExport(level: ExportLevel, onlyMatching = false): Promise<PreparedExport> {
  const words = app.words;
  const filter = words ? rowFilterOf(app.filter, words, app.display.yIsVowel) : null;
  const options: ExportOptions = {
    exportedAt: isoNow(),
    appVersion: APP_VERSION,
    solverVersion: app.catalogue.solverVersion || 'NA',
    filter,
    onlyMatching: onlyMatching && !!filter,
  };
  const none = (why: string): PreparedExport => ({
    level: { kind: 'card' },
    configs: [],
    options,
    rows: 0,
    partial: false,
    targetsFinished: 0,
    targetsTotal: 0,
    filterActive: !!filter,
    empty: why,
  });
  if (!words) return none('The word list has not loaded yet.');
  const entry = focusEntry();
  let spec: ExportLevelSpec;
  let sources: ExportSource[];
  if (level === 'tree') {
    const target = app.focus.target;
    const config = focusConfigs.tree;
    if (!entry || !config || target < 0) return none('Play a game (or pick a target) to grow a tree first.');
    spec = { kind: 'tree', target };
    sources = [
      {
        run: focusData.treeRun,
        config,
        strategyId: entry.id,
        strategyLabel: entry.label,
        nTargets: 1,
        playerGames: playerGamesFor(words, app.game.history, target),
      },
    ];
  } else if (level === 'card') {
    const config = focusConfigs.card;
    if (!entry || !config) return none('There is no card yet: finish a game or choose a strategy.');
    spec = { kind: 'card' };
    sources = [{ run: focusData.cardRun, config, strategyId: entry.id, strategyLabel: entry.label, nTargets: words.answers.length }];
  } else {
    sources = atlasSources(words);
    if (!sources.length) return none('The Atlas is empty.');
    const n = sources.length;
    let pairs: [number, number][] = [];
    const sel = app.atlas.selected;
    if (sel.length === 2) {
      const nRows = app.atlas.rows.length || 1;
      const idx = ([c, r]: [number, number]) => c * nRows + r;
      const a = idx(sel[0]);
      const b = idx(sel[1]);
      if (a < n && b < n && a !== b) pairs = [[Math.min(a, b), Math.max(a, b)]];
    } else for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) pairs.push([a, b]);
    spec = { kind: 'atlas', pairs };
  }
  const configs = await Promise.all(sources.map(async (s) => exportConfigOf(s, await configIdOf(s.run, s.run?.config ?? s.config))));
  const partial = configs.some((c) => !c.complete);
  return {
    level: spec,
    configs,
    options,
    rows: estimateRows(words, spec, configs, options),
    partial,
    targetsFinished: configs.reduce((n, c) => n + c.targetsFinished, 0),
    targetsTotal: configs.reduce((n, c) => n + c.nTargets, 0),
    filterActive: !!filter,
    empty: null,
  };
}

/** Save bytes as a download. */
export function download(bytes: Uint8Array, fileName: string, type = 'application/zip'): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Build and download an export; remembers it for Copy R code. */
export async function runExport(prepared: PreparedExport, summaryOnly = false): Promise<BuiltExport | null> {
  const words = app.words;
  if (!words || prepared.empty) return null;
  const built = buildExport(words, prepared.level, prepared.configs, prepared.options, summaryOnly);
  download(built.zip, built.fileName);
  exportState.last = { fileName: built.fileName, files: built.files.map(([n]) => n), maxGuesses: built.maxGuesses, level: built.level };
  toast(`Exported ${built.fileName}`);
  return built;
}

/** Copy text to the clipboard (with a fallback for insecure contexts). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall back */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** The R snippet for the most recent export, or for what the current level would export. */
export function currentSnippet(base = exportState.baseR): { text: string; fileName: string } {
  const last = exportState.last;
  if (last) return { text: rSnippet({ fileName: last.fileName, files: last.files, maxGuesses: last.maxGuesses, base }), fileName: last.fileName };
  const level = levelForZoom();
  const files =
    level === 'tree'
      ? ['configs.csv', 'games.csv', 'plays.csv', 'nodes.csv', 'distribution.csv']
      : level === 'card'
        ? ['configs.csv', 'games.csv', 'plays.csv', 'distribution.csv', 'summary.csv']
        : ['configs.csv', 'games.csv', 'plays.csv', 'distribution.csv', 'summary.csv', 'paired.csv'];
  const fileName = zipName(level);
  return { text: rSnippet({ fileName, files, maxGuesses: app.result.maxGuesses, base }), fileName };
}

/** Copy the R snippet for the most recent export (or the one the current level would produce). */
export async function copyRCode(): Promise<void> {
  const { text, fileName } = currentSnippet();
  const ok = await copyText(text);
  if (ok) toast(`R code copied for ${fileName}`);
  else toast('Could not copy to the clipboard', 'error');
}

/** Rows of ranking.csv for a ranking. */
export function rankingRows(r: Ranking): RankingRow[] {
  return [...r.entries]
    .sort((a, b) => a.rank - b.rank)
    .map((e) => ({
      rankingId: r.id,
      fixedKind: r.fixedKind,
      fixedValue: r.fixedValue,
      entry: e.key,
      rank: e.rank,
      metric: e.scoreKind === 'info' ? 'info' : r.metric,
      value: e.value,
      ciLow: e.ciLow,
      ciHigh: e.ciHigh,
      failRate: e.failRate,
      stage: e.stage,
    }));
}

/** Export a ranking panel: ranking.csv, plus configs.csv and distribution.csv rows for full entries. */
export async function exportRanking(r: Ranking): Promise<void> {
  const words = app.words;
  if (!words) return;
  const files: Record<string, Uint8Array> = { 'ranking.csv': strToU8(rankingCsvOf(r)) };
  const full = r.entries.filter((e) => e.stage === 'full' && e.config);
  const names = ['ranking.csv'];
  if (full.length) {
    const configs = await Promise.all(
      full.map(async (e) =>
        exportConfigOf(
          { run: e.run ?? null, config: e.config!, strategyId: r.fixedKind === 'opener' ? e.key : r.fixedValue, strategyLabel: e.label, nTargets: words.answers.length },
          await configIdOf(e.run ?? null, e.config!),
        ),
      ),
    );
    const opts: ExportOptions = { exportedAt: isoNow(), appVersion: APP_VERSION, solverVersion: app.catalogue.solverVersion || 'NA', filter: null, onlyMatching: false };
    files['configs.csv'] = strToU8(configsCsv(configs, opts));
    files['distribution.csv'] = strToU8(distributionCsv(configs.map((c) => [c, cardOf(words, c, c.games, c.nTargets)])));
    names.push('configs.csv', 'distribution.csv');
  }
  const fileName = zipName('ranking');
  download(zipSync(files, { level: 6 }), fileName);
  exportState.last = { fileName, files: names, maxGuesses: app.result.maxGuesses, level: exportState.level };
  toast(`Exported ${fileName}`);
}

/** ranking.csv text for a ranking. */
export function rankingCsvOf(r: Ranking): string {
  return rankingCsv(rankingRows(r));
}

export { snippetFor };
