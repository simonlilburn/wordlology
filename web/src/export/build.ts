// Assembling an export from the app's runs. Owned by the platform agent.
//
// What each level exports (docs/specification.md, "Data export"):
//   Tree:  configs, that target's games and plays (R games plus player paths),
//          nodes, and that target's distribution.
//   Card:  configs, games, plays, distribution and summary for every target.
//   Atlas: the same for every configuration in the grid, plus paired.csv for
//          each compared pair.

import { strToU8, zipSync } from 'fflate';
import { fillSpecDefaults, isDeterministicSpec } from '../app/config';
import type { Config, Game } from '../backend/types';
import { compileFilter, matchesNode } from '../model/filter';
import { playerGame } from '../model/player';
import type { Run, WordData } from '../model/types';
import type { FilterState, BoardGame } from '../app/store.svelte';
import { countRows, exportFiles, levelName, type ExportConfig, type ExportLevelSpec, type ExportOptions, type RowFilter } from './csv';
import { rSnippet, zipName } from './rcode';

export interface ExportSource {
  run: Run | null;
  config: Config;
  strategyId: string;
  strategyLabel: string;
  /** Targets in the run's scope. */
  nTargets: number;
  /** Player games to include (tree exports). */
  playerGames?: Game[];
}

/** The configuration as exported: defaults filled, replicates 1 for deterministic strategies. */
export function canonicalConfig(config: Config): Config {
  const strategy = fillSpecDefaults(config.strategy);
  const c: Config = JSON.parse(JSON.stringify({ ...config, strategy })) as Config;
  if (isDeterministicSpec(strategy)) c.replicates = 1;
  if (c.word_list.answers.kind === 'pasted') c.word_list.answers = { kind: 'pasted', sha256: c.word_list.answers.sha256, words: [] };
  return c;
}

/** Targets finished by a (possibly partial) run. */
export function targetsFinished(run: Run | null, nTargets: number): number {
  if (!run) return 0;
  if (run.status === 'done') return nTargets;
  if (run.progress) return Math.min(nTargets, run.progress.targetsDone);
  const reps = run.deterministic ? 1 : Math.max(1, run.config.replicates);
  const per = new Map<number, number>();
  for (const g of run.games) if (!g.isPlayer) per.set(g.target, (per.get(g.target) ?? 0) + 1);
  let n = 0;
  for (const c of per.values()) if (c >= reps) n++;
  return n;
}

/** An ExportConfig from a run (its games so far). */
export function exportConfigOf(src: ExportSource, configId: string): ExportConfig {
  const run = src.run;
  const config = canonicalConfig(run?.config ?? src.config);
  const games: Game[] = run ? run.games.slice() : [];
  if (src.playerGames) games.push(...src.playerGames);
  return {
    config,
    configId,
    strategyId: src.strategyId,
    strategyLabel: src.strategyLabel,
    phases: run?.phases ?? [],
    deterministic: run?.deterministic ?? isDeterministicSpec(config.strategy),
    games,
    complete: run?.status === 'done',
    targetsFinished: targetsFinished(run, src.nTargets),
    nTargets: src.nTargets,
  };
}

/** Player games against a target from the history (numbered by their place in the history, as the tree numbers them). */
export function playerGamesFor(words: WordData, history: readonly BoardGame[], target: number): Game[] {
  const out: Game[] = [];
  history.forEach((h, i) => {
    if (h.target === target && h.guesses.length) out.push(playerGame(words, h.target, h.guesses, i + 1));
  });
  return out;
}

/** A RowFilter for the store's filter state (null when none is active). */
export function rowFilterOf(state: FilterState | null, words: WordData, yIsVowel: boolean): RowFilter | null {
  const f = compileFilter(state, words.wordLength, yIsVowel);
  if (!f) return null;
  return { text: () => f.text, matches: (word, turn, solving) => matchesNode(f, word, turn, solving) };
}

export interface BuiltExport {
  fileName: string;
  files: [string, string][];
  zip: Uint8Array;
  level: 'tree' | 'card' | 'atlas';
  maxGuesses: number;
  rows: number;
}

/** ISO 8601 time without milliseconds, in UTC. */
export function isoNow(when: Date = new Date()): string {
  return when.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Build the zip of an export. */
export function buildExport(
  words: WordData,
  level: ExportLevelSpec,
  configs: ExportConfig[],
  opts: ExportOptions,
  summaryOnly = false,
  when: Date = new Date(),
): BuiltExport {
  const files = exportFiles(words, level, configs, opts, { rows: !summaryOnly });
  const zipped: Record<string, Uint8Array> = {};
  let rows = 0;
  for (const [name, text] of files) {
    zipped[name] = strToU8(text);
    rows += Math.max(0, text.split('\n').length - 2);
  }
  const lvl = levelName(level);
  return {
    fileName: zipName(lvl, when),
    files,
    zip: zipSync(zipped, { level: 6, mtime: when }),
    level: lvl,
    maxGuesses: configs[0]?.config.rules.max_guesses ?? 6,
    rows,
  };
}

/** Estimated rows of an export (games + plays + paired rows), for the size guard. */
export function estimateRows(words: WordData, level: ExportLevelSpec, configs: ExportConfig[], opts: Pick<ExportOptions, 'filter' | 'onlyMatching'>): number {
  const { total } = countRows(level, configs, opts, words);
  let paired = 0;
  if (level.kind === 'atlas') paired = level.pairs.length * words.answers.length;
  return total + paired;
}

/** The R snippet for a built export. */
export function snippetFor(built: Pick<BuiltExport, 'fileName' | 'files' | 'maxGuesses'>, base = false): string {
  return rSnippet({ fileName: built.fileName, files: built.files.map(([n]) => n), maxGuesses: built.maxGuesses, base });
}
