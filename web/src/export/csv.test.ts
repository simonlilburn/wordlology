// The browser's CSV writer against the shared export test vectors
// (data/testvectors/export/, also checked by the Rust writer): every file
// must match byte for byte.

import { describe, expect, it } from 'vitest';
import type { Config, Game, WordListManifest } from '../backend/types';
import { fs } from '../model/testing';
import { answerIndexOf, buildWordData } from '../model/wordlists';
import { buildExport } from './build';
import { exportFiles, fmtNum, type ExportConfig, type ExportLevelSpec, type ExportOptions } from './csv';
import { rSnippet, zipName } from './rcode';

const VECTORS = new URL('../../../data/testvectors/export/', import.meta.url);
const LIST = new URL('../../../data/wordlists/ref-en-5/', import.meta.url);

interface VectorConfig {
  config_id: string;
  config: Config;
  strategy_id: string;
  strategy_label: string;
  phases: string[];
  deterministic: boolean;
  complete: boolean;
  targets_finished: number;
  n_targets: number;
  games: Game[];
}

interface Vectors {
  solver_version: string;
  exported_at: string;
  app_version: string;
  configs: VectorConfig[];
  exports: { dir: string; level: 'tree' | 'card' | 'atlas'; configs: number[]; pairs?: [number, number][]; target?: string }[];
}

const read = (u: URL) => fs.readFileSync(u, 'utf8');
const vectors = JSON.parse(read(new URL('games.json', VECTORS))) as Vectors;
const words = buildWordData({
  manifest: JSON.parse(read(new URL('manifest.json', LIST))) as WordListManifest,
  guesses: read(new URL('guesses.txt', LIST)),
  answers: read(new URL('answers.txt', LIST)),
  ranked: null,
  frequencies: read(new URL('frequencies.tsv', LIST)),
});

function exportConfig(v: VectorConfig): ExportConfig {
  return {
    config: v.config,
    configId: v.config_id,
    strategyId: v.strategy_id,
    strategyLabel: v.strategy_label,
    phases: v.phases,
    deterministic: v.deterministic,
    games: v.games,
    complete: v.complete,
    targetsFinished: v.targets_finished,
    nTargets: v.n_targets,
  };
}

const options: ExportOptions = {
  exportedAt: vectors.exported_at,
  appVersion: vectors.app_version,
  solverVersion: vectors.solver_version,
  filter: null,
  onlyMatching: false,
};

function levelOf(e: Vectors['exports'][number]): ExportLevelSpec {
  if (e.level === 'tree') return { kind: 'tree', target: answerIndexOf(words, e.target!) };
  if (e.level === 'atlas') return { kind: 'atlas', pairs: e.pairs ?? [] };
  return { kind: 'card' };
}

describe('export test vectors', () => {
  for (const e of vectors.exports) {
    it(`writes the ${e.dir} export byte for byte`, () => {
      const configs = e.configs.map((i) => exportConfig(vectors.configs[i]));
      const files = exportFiles(words, levelOf(e), configs, options);
      const expected = fs.readdirSync(new URL(`${e.dir}/`, VECTORS)).filter((f) => f.endsWith('.csv'));
      expect(files.map(([n]) => n).sort()).toEqual(expected.sort());
      for (const [name, text] of files) expect(text, `${e.dir}/${name}`).toBe(read(new URL(`${e.dir}/${name}`, VECTORS)));
    });
  }

  it('lists exactly the tables the specification gives each level', () => {
    const card = exportConfig(vectors.configs[0]);
    const partial = exportConfig(vectors.configs[1]);
    const names = (level: ExportLevelSpec, cs: ExportConfig[], rows = true) => exportFiles(words, level, cs, options, { rows }).map(([n]) => n);
    expect(names({ kind: 'tree', target: answerIndexOf(words, 'began') }, [partial])).toEqual(['configs.csv', 'games.csv', 'plays.csv', 'nodes.csv', 'distribution.csv']);
    expect(names({ kind: 'card' }, [card])).toEqual(['configs.csv', 'games.csv', 'plays.csv', 'distribution.csv', 'summary.csv']);
    expect(names({ kind: 'atlas', pairs: [[0, 1]] }, [card, partial])).toEqual(['configs.csv', 'games.csv', 'plays.csv', 'distribution.csv', 'summary.csv', 'paired.csv']);
    // The size guard's summary-only export drops the row tables.
    expect(names({ kind: 'card' }, [card], false)).toEqual(['configs.csv', 'distribution.csv', 'summary.csv']);
  });

  it('records partial exports in configs.csv', () => {
    const [, text] = exportFiles(words, { kind: 'card' }, [exportConfig(vectors.configs[1])], options)[0];
    const [header, row] = text.trim().split('\n');
    const cols = header.split(',');
    const cells = row.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    expect(cells[cols.indexOf('complete')]).toBe('FALSE');
    expect(cells[cols.indexOf('targets_finished')]).toBe('3');
  });

  it('flags filter matches and can keep only games that touch one', () => {
    const cfg = exportConfig(vectors.configs[0]);
    const filter = { text: () => '?A??? +E', matches: (w: string) => w[1] === 'a' && w.includes('e') };
    const all = exportFiles(words, { kind: 'card' }, [cfg], { ...options, filter });
    const only = exportFiles(words, { kind: 'card' }, [cfg], { ...options, filter, onlyMatching: true });
    const table = (files: [string, string][], name: string) => files.find(([n]) => n === name)![1].trim().split('\n');
    expect(table(all, 'configs.csv')[1]).toContain(',?A??? +E,');
    const plays = table(all, 'plays.csv').slice(1);
    expect(plays.every((l) => l.endsWith(',TRUE') || l.endsWith(',FALSE'))).toBe(true);
    const onlyGames = table(only, 'games.csv').slice(1);
    expect(onlyGames.length).toBeGreaterThan(0);
    expect(onlyGames.length).toBeLessThan(table(all, 'games.csv').length - 1);
    for (const g of onlyGames) expect(g.split(',')[7].split('>').some((w) => filter.matches(w))).toBe(true);
    // Distribution and summary still describe the whole card.
    expect(table(only, 'summary.csv')).toEqual(table(all, 'summary.csv'));
  });

  it('names zips wordlology-<level>-<yyyymmdd-hhmm>.zip', () => {
    const when = new Date(2026, 8, 30, 15, 33, 12);
    expect(zipName('card', when)).toBe('wordlology-card-20260930-1533.zip');
    const built = buildExport(words, { kind: 'card' }, [exportConfig(vectors.configs[0])], options, false, when);
    expect(built.fileName).toBe('wordlology-card-20260930-1533.zip');
    expect(built.files.map(([n]) => n)).toContain('summary.csv');
  });

  it('formats numbers with 6 significant digits', () => {
    expect(fmtNum(1 / 3)).toBe('0.333333');
    expect(fmtNum(1234567)).toBe('1234570');
    expect(fmtNum(0.00000015)).toBe('0.00000015');
    expect(fmtNum(5.87)).toBe('5.87');
    expect(fmtNum(1)).toBe('1');
    expect(fmtNum(0)).toBe('0');
    expect(fmtNum(NaN)).toBe('NA');
  });
});

describe('R snippet', () => {
  const spec = read(new URL('../../../docs/specification.md', import.meta.url));
  const specSnippet = /```r\n([\s\S]*?)```/.exec(spec)![1];
  const cardFiles = ['configs.csv', 'games.csv', 'plays.csv', 'distribution.csv', 'summary.csv'];

  it('is the specification snippet for a card export', () => {
    expect(rSnippet({ fileName: 'wordlology-card-20260930-1533.zip', files: cardFiles, maxGuesses: 6 })).toBe(specSnippet);
  });

  it('names the exact zip and reads the tables it holds', () => {
    const tree = rSnippet({ fileName: 'wordlology-tree-20261001-0907.zip', files: ['configs.csv', 'games.csv', 'plays.csv', 'nodes.csv', 'distribution.csv'], maxGuesses: 8 });
    expect(tree).toContain('"~/Downloads/wordlology-tree-20261001-0907.zip"');
    expect(tree).toContain('outcome_levels <- c(as.character(1:8), "X")');
    expect(tree).toContain('nodes <- read_csv(file.path(dir, "nodes.csv")');
    expect(tree).toContain('distribution <- read_csv(file.path(dir, "distribution.csv")');
    const atlas = rSnippet({ fileName: 'wordlology-atlas-20261001-0907.zip', files: [...cardFiles, 'paired.csv'] });
    expect(atlas).toContain('paired <- read_csv(file.path(dir, "paired.csv"), show_col_types = FALSE)');
  });

  it('has a base-R variant without the tidyverse', () => {
    const base = rSnippet({ fileName: 'wordlology-card-20260930-1533.zip', files: cardFiles, base: true });
    expect(base).not.toMatch(/library\(|read_csv|\|>/);
    expect(base).toContain('"~/Downloads/wordlology-card-20260930-1533.zip"');
    expect(base).toContain('games <- read.csv(file.path(dir, "games.csv"), stringsAsFactors = FALSE');
    expect(base).toContain('games$outcome <- factor(games$outcome, levels = outcome_levels, ordered = TRUE)');
    expect(base).toContain('summary <- read.csv(file.path(dir, "summary.csv"), stringsAsFactors = FALSE');
  });
});
