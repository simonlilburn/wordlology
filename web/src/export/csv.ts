// Tidy CSV writers (docs/specification.md, "Data export"). Owned by the platform agent.
//
// A port of crates/wl-engine/src/export.rs: the browser and the CLI write the
// same bytes for the same games (data/testvectors/export/ pins it down).
// Conventions: UTF-8, comma separated, "\n" line ends, a header row,
// snake_case names, lowercase words, TRUE/FALSE, NA for missing, ISO 8601
// times, no comments. Fields are quoted only when they contain a comma, a
// double quote or a line break (quotes doubled). Numbers: 6 significant
// digits, plain decimal notation, no trailing zeros.

import { PHASE_OPENER, PHASE_PLAYER, type Config, type Game, type StrategySpec } from '../backend/types';
import { cardStats, pairRows, type CardStats } from '../model/card';
import { patternLetters } from '../model/feedback';
import type { WordData } from '../model/types';

/**
 * Format a number: rounded to 6 significant digits (half away from zero on
 * the exact binary value, as `toExponential(5)`), in plain decimal notation
 * without trailing zeros or a trailing point. Zero is `0`; NaN and
 * infinities are `NA`. Mirrors `wl_engine::export::fmt_num`.
 */
export function fmtNum(x: number): string {
  if (!Number.isFinite(x)) return 'NA';
  if (x === 0) return '0';
  const e = Math.abs(x).toExponential(5); // "d.ddddde±x"
  const [mant, expText] = e.split('e');
  const exp = Number(expText);
  let digits = mant.replace('.', '');
  digits = digits.replace(/0+$/, '');
  if (digits === '') digits = '0';
  const point = exp + 1;
  let body: string;
  if (point <= 0) body = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) body = digits + '0'.repeat(point - digits.length);
  else body = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return x < 0 ? `-${body}` : body;
}

export function fmtBool(b: boolean): string {
  return b ? 'TRUE' : 'FALSE';
}

function optBool(b: boolean | null | undefined): string {
  return b == null ? 'NA' : fmtBool(b);
}

/** Quote a field if it contains a comma, a double quote or a line break. */
export function escapeField(s: string): string {
  return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A CSV table being written. */
export class Table {
  private out: string[] = [];
  constructor(header: readonly string[]) {
    this.row(header);
  }
  row(fields: readonly string[]): void {
    this.out.push(fields.map(escapeField).join(',') + '\n');
  }
  /** Rows written so far, including the header. */
  get length(): number {
    return this.out.length;
  }
  finish(): string {
    return this.out.join('');
  }
}

/** Matches guesses against the active letter filter; with no filter, matches_filter is NA. */
export interface RowFilter {
  /** The filter as recorded in configs.csv. */
  text(): string;
  /** Whether a guess matches. `turn` is 1-based; `solving` is true for the guess that found the target. */
  matches(word: string, turn: number, solving: boolean): boolean;
}

export interface ExportOptions {
  /** ISO 8601 time of the export. */
  exportedAt: string;
  appVersion: string;
  solverVersion: string;
  filter: RowFilter | null;
  /** Keep only games that touch a filter match in games, plays and nodes. */
  onlyMatching: boolean;
}

/** One configuration and its games, as exported. */
export interface ExportConfig {
  /** The canonical configuration (replicates 1 for deterministic strategies). */
  config: Config;
  configId: string;
  strategyId: string;
  strategyLabel: string;
  /** Phase labels, indexed by Turn.phase. */
  phases: string[];
  deterministic: boolean;
  /** Strategy games (and player games, flagged isPlayer). */
  games: readonly Game[];
  complete: boolean;
  targetsFinished: number;
  /** Targets in the run's scope. */
  nTargets: number;
}

export type ExportLevelSpec = { kind: 'tree'; target: number } | { kind: 'card' } | { kind: 'atlas'; pairs: [number, number][] };

// ---------------------------------------------------------------------------
// Strategy JSON as the solver writes it (serde_json floats keep a ".0").

const FLOAT_KEYS = new Set(['beta', 'h', 'weights']);

function rustFloat(x: number): string {
  if (!Number.isFinite(x)) return 'null';
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return `${x}.0`;
  return String(x);
}

function canonical(v: unknown, float: boolean): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return float ? rustFloat(v) : JSON.stringify(v);
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => canonical(x, float)).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k], FLOAT_KEYS.has(k))}`).join(',')}}`;
}

/**
 * Canonical JSON of a (defaults-filled) strategy spec as `strategy_canonical_json`
 * writes it: keys sorted, no whitespace, f64 fields (beta, h, weights) with a ".0".
 */
export function strategyCanonicalJson(spec: StrategySpec): string {
  return canonical(spec, false);
}

// ---------------------------------------------------------------------------

function answerWordOf(words: WordData, target: number): string {
  return words.guesses[words.answers[target]] ?? String(target);
}

/** `{config_id}-{target}-{replicate}`, or `{config_id}-{target}-p{n}` for player games. */
export function gameId(configId: string, words: WordData, g: Game): string {
  const w = answerWordOf(words, g.target);
  return g.isPlayer ? `${configId}-${w}-p${g.replicate}` : `${configId}-${w}-${g.replicate}`;
}

/** Games in export order: by target, strategy games by replicate, then player games by number. */
export function exportOrder(games: readonly Game[]): Game[] {
  return games
    .map((g, i) => ({ g, i }))
    .sort((a, b) => a.g.target - b.g.target || Number(!!a.g.isPlayer) - Number(!!b.g.isPlayer) || a.g.replicate - b.g.replicate || a.i - b.i)
    .map((x) => x.g);
}

/** "1".."max" or "X". */
export function outcomeLabel(g: Game): string {
  return g.solved ? String(g.turns.length) : 'X';
}

export function gamePath(words: WordData, g: Game): string {
  return g.turns.map((t) => words.guesses[t.guess]).join('>');
}

/** Label of a phase index given the strategy's phase labels. */
export function phaseLabel(phases: readonly string[], phase: number): string {
  if (phase === PHASE_OPENER) return 'opener';
  if (phase === PHASE_PLAYER) return 'player';
  return phases[phase] ?? String(phase);
}

/** Information observed by a turn: log2(before / after), 0 when either is 0. */
export function observedInfo(before: number, after: number): number {
  if (before === 0 || after === 0) return 0;
  return Math.log2(before / after);
}

/** Whether a game touches a filter match. */
export function touchesMatch(words: WordData, g: Game, filter: RowFilter): boolean {
  const n = g.turns.length;
  return g.turns.some((t, i) => filter.matches(words.guesses[t.guess], i + 1, g.solved && i + 1 === n));
}

export const CONFIGS_HEADER = [
  'config_id',
  'strategy_id',
  'strategy_label',
  'strategy_json',
  'opener',
  'word_list_id',
  'word_list_version',
  'hard_mode',
  'max_guesses',
  'replicates',
  'base_seed',
  'filter',
  'solver_version',
  'app_version',
  'exported_at',
  'complete',
  'targets_finished',
  'answers',
  'weighting',
] as const;

/** The answer selection as recorded in configs.csv: `default`, `top:N` or `pasted:{sha256}`. */
export function answersLabel(sel: Config['word_list']['answers']): string {
  switch (sel.kind) {
    case 'default':
      return 'default';
    case 'top':
      return `top:${sel.n}`;
    case 'pasted':
      return `pasted:${sel.sha256}`;
  }
}

/** configs.csv: the spec's columns, then `complete` and `targets_finished` (partial exports), then `answers` and `weighting`. */
export function configsCsv(configs: readonly ExportConfig[], opts: ExportOptions): string {
  const t = new Table(CONFIGS_HEADER);
  for (const c of configs) {
    const cfg = c.config;
    t.row([
      c.configId,
      c.strategyId,
      c.strategyLabel,
      strategyCanonicalJson(cfg.strategy),
      cfg.opener ?? 'NA',
      cfg.word_list.id,
      cfg.word_list.version,
      fmtBool(cfg.rules.hard_mode),
      String(cfg.rules.max_guesses),
      String(cfg.replicates),
      String(cfg.base_seed),
      opts.filter ? opts.filter.text() : 'NA',
      opts.solverVersion,
      opts.appVersion,
      opts.exportedAt,
      fmtBool(c.complete),
      String(c.targetsFinished),
      answersLabel(cfg.word_list.answers),
      cfg.weighting,
    ]);
  }
  return t.finish();
}

export const GAMES_HEADER = ['game_id', 'config_id', 'target', 'replicate', 'n_guesses', 'solved', 'outcome', 'path', 'is_player'] as const;

export function gamesCsv(words: WordData, rows: readonly [ExportConfig, readonly Game[]][]): string {
  const t = new Table(GAMES_HEADER);
  for (const [c, games] of rows) {
    for (const g of games) {
      t.row([
        gameId(c.configId, words, g),
        c.configId,
        answerWordOf(words, g.target),
        g.isPlayer ? 'NA' : String(g.replicate),
        String(g.turns.length),
        fmtBool(g.solved),
        outcomeLabel(g),
        gamePath(words, g),
        fmtBool(!!g.isPlayer),
      ]);
    }
  }
  return t.finish();
}

export const PLAYS_HEADER = [
  'game_id',
  'config_id',
  'turn',
  'guess',
  'feedback',
  'feedback_code',
  'candidates_before',
  'candidates_after',
  'bits_expected',
  'bits_observed',
  'p_chosen',
  'is_candidate',
  'phase',
  'matches_filter',
] as const;

export function playsCsv(words: WordData, rows: readonly [ExportConfig, readonly Game[]][], filter: RowFilter | null): string {
  const t = new Table(PLAYS_HEADER);
  const len = words.wordLength;
  for (const [c, games] of rows) {
    for (const g of games) {
      const id = gameId(c.configId, words, g);
      const n = g.turns.length;
      g.turns.forEach((turn, i) => {
        const word = words.guesses[turn.guess];
        const solving = g.solved && i + 1 === n;
        t.row([
          id,
          c.configId,
          String(i + 1),
          word,
          patternLetters(turn.pattern, len),
          String(turn.pattern),
          String(turn.candsBefore),
          String(turn.candsAfter),
          fmtNum(turn.bitsExpected),
          fmtNum(observedInfo(turn.candsBefore, turn.candsAfter)),
          fmtNum(turn.pChosen),
          fmtBool(turn.isCandidate),
          phaseLabel(c.phases, turn.phase),
          optBool(filter ? filter.matches(word, i + 1, solving) : null),
        ]);
      });
    }
  }
  return t.finish();
}

/** A node of an export trie (port of wl_engine::trie::TrieNode). */
export interface ExportNode {
  id: number;
  parent: number | null;
  depth: number;
  guess: number | null;
  pattern: number;
  mass: number;
  terminal: boolean;
  player: boolean;
  children: number[];
}

/** The target trie of games in the given order (node ids follow insertion), as wl_engine::trie::TargetTrie. */
export function exportTrie(target: number, games: readonly Game[]): ExportNode[] {
  const nodes: ExportNode[] = [{ id: 0, parent: null, depth: 0, guess: null, pattern: 0, mass: 0, terminal: false, player: false, children: [] }];
  const mark = (n: ExportNode, strategy: boolean) => {
    if (strategy) n.mass++;
    else n.player = true;
  };
  for (const g of games) {
    if (g.target !== target) continue;
    const strategy = !g.isPlayer;
    let cur = nodes[0];
    mark(cur, strategy);
    g.turns.forEach((turn, i) => {
      let next: ExportNode | undefined;
      for (const c of cur.children) {
        if (nodes[c].guess === turn.guess) {
          next = nodes[c];
          break;
        }
      }
      if (!next) {
        next = { id: nodes.length, parent: cur.id, depth: i + 1, guess: turn.guess, pattern: turn.pattern, mass: 0, terminal: false, player: false, children: [] };
        nodes.push(next);
        cur.children.push(next.id);
      }
      cur = next;
      mark(cur, strategy);
    });
    cur.terminal = true;
  }
  return nodes;
}

export const NODES_HEADER = [
  'node_id',
  'parent_id',
  'config_id',
  'target',
  'depth',
  'guess',
  'feedback',
  'n_games',
  'share',
  'is_terminal',
  'outcome',
  'matches_filter',
] as const;

export function nodesCsv(words: WordData, target: number, rows: readonly [ExportConfig, readonly Game[]][], filter: RowFilter | null): string {
  const t = new Table(NODES_HEADER);
  const targetWord = answerWordOf(words, target);
  const targetId = words.answers[target];
  const len = words.wordLength;
  for (const [c, games] of rows) {
    const nodes = exportTrie(target, games);
    const total = nodes[0].mass;
    const nodeId = (id: number) => `${c.configId}-${targetWord}-n${id}`;
    for (const n of nodes) {
      const solving = n.guess === targetId;
      const outcome = solving ? String(n.depth) : n.terminal ? 'X' : 'NA';
      t.row([
        nodeId(n.id),
        n.parent === null ? 'NA' : nodeId(n.parent),
        c.configId,
        targetWord,
        String(n.depth),
        n.guess === null ? 'NA' : words.guesses[n.guess],
        n.guess === null ? 'NA' : patternLetters(n.pattern, len),
        String(n.mass),
        fmtNum(total > 0 ? n.mass / total : NaN),
        fmtBool(n.terminal),
        outcome,
        n.guess !== null && filter ? fmtBool(filter.matches(words.guesses[n.guess], n.depth, solving)) : 'NA',
      ]);
    }
  }
  return t.finish();
}

/** Raw card weights per answer index for a weighting (as wl_engine::card::target_weights). */
export function exportWeights(words: WordData, weighting: Config['weighting']): Float64Array {
  const n = words.answers.length;
  const w = new Float64Array(n).fill(1);
  if (weighting === 'frequency' && words.zipf) for (let a = 0; a < n; a++) w[a] = Math.pow(10, words.zipf[words.answers[a]]);
  return w;
}

/** Card of a configuration's games (player games skipped). */
export function cardOf(words: WordData, c: ExportConfig, games: readonly Game[], nTargets: number): CardStats {
  return cardStats(games, c.config.rules.max_guesses, nTargets, c.deterministic, exportWeights(words, c.config.weighting));
}

function outcomeName(k: number, max: number): string {
  return k < max ? String(k + 1) : 'X';
}

export const DISTRIBUTION_HEADER = ['config_id', 'outcome', 'n_games', 'share', 'share_se'] as const;

export function distributionCsv(cards: readonly [ExportConfig, CardStats][]): string {
  const t = new Table(DISTRIBUTION_HEADER);
  for (const [c, card] of cards) {
    for (let k = 0; k < card.shares.length; k++) {
      t.row([c.configId, outcomeName(k, card.maxGuesses), String(card.counts[k]), fmtNum(card.shares[k]), card.shareSe ? fmtNum(card.shareSe[k]) : 'NA']);
    }
  }
  return t.finish();
}

export const SUMMARY_HEADER = ['config_id', 'n_targets', 'n_games', 'mean_guesses', 'sd_guesses', 'se_mean', 'median', 'solve_rate', 'p95'] as const;

export function summaryCsv(cards: readonly [ExportConfig, CardStats][]): string {
  const t = new Table(SUMMARY_HEADER);
  for (const [c, card] of cards) {
    t.row([
      c.configId,
      String(card.nTargetsSeen),
      String(card.nGames),
      fmtNum(card.mean),
      fmtNum(card.sd),
      card.meanSe === null ? 'NA' : fmtNum(card.meanSe),
      fmtNum(card.median),
      fmtNum(card.solveRate),
      fmtNum(card.p95),
    ]);
  }
  return t.finish();
}

export const PAIRED_HEADER = ['target', 'config_a', 'config_b', 'mean_a', 'mean_b', 'diff'] as const;

export function pairedCsv(words: WordData, configs: readonly ExportConfig[], pairs: readonly [number, number][]): string {
  const t = new Table(PAIRED_HEADER);
  for (const [a, b] of pairs) {
    const ca = configs[a];
    const cb = configs[b];
    if (!ca || !cb) continue;
    for (const r of pairRows(ca.games, cb.games)) {
      t.row([answerWordOf(words, r.target), ca.configId, cb.configId, fmtNum(r.meanA), fmtNum(r.meanB), fmtNum(r.diff)]);
    }
  }
  return t.finish();
}

/** One ranked entry of a ranking panel. */
export interface RankingRow {
  rankingId: string;
  /** "opener" (a row ranking strategies) or "strategy" (a column ranking openers). */
  fixedKind: string;
  fixedValue: string;
  entry: string;
  rank: number;
  metric: string;
  value: number;
  ciLow: number;
  ciHigh: number;
  failRate: number;
  /** "full" or "screened". */
  stage: string;
}

export const RANKING_HEADER = ['ranking_id', 'fixed_kind', 'fixed_value', 'entry', 'rank', 'metric', 'value', 'ci_low', 'ci_high', 'fail_rate', 'stage'] as const;

export function rankingCsv(rows: readonly RankingRow[]): string {
  const t = new Table(RANKING_HEADER);
  for (const r of rows) {
    t.row([r.rankingId, r.fixedKind, r.fixedValue, r.entry, String(r.rank), r.metric, fmtNum(r.value), fmtNum(r.ciLow), fmtNum(r.ciHigh), fmtNum(r.failRate), r.stage]);
  }
  return t.finish();
}

export function levelName(level: ExportLevelSpec): 'tree' | 'card' | 'atlas' {
  return level.kind;
}

/** Row counts per table of a level's export (for the size guard), without writing it. */
export function countRows(level: ExportLevelSpec, configs: readonly ExportConfig[], opts: Pick<ExportOptions, 'filter' | 'onlyMatching'>, words: WordData): {
  games: number;
  plays: number;
  total: number;
} {
  let games = 0;
  let plays = 0;
  for (const c of configs) {
    for (const g of c.games) {
      if (level.kind === 'tree' && g.target !== level.target) continue;
      if (opts.filter && opts.onlyMatching && !touchesMatch(words, g, opts.filter)) continue;
      games++;
      plays += g.turns.length;
    }
  }
  return { games, plays, total: games + plays };
}

/** Which tables to write. */
export interface ExportTables {
  /** false: summary tables only (configs, distribution, summary, paired) — the size guard's choice. */
  rows: boolean;
}

/** Every file of a level's export, as [file name, contents], in a fixed order (as export_files). */
export function exportFiles(
  words: WordData,
  level: ExportLevelSpec,
  configs: readonly ExportConfig[],
  opts: ExportOptions,
  tables: ExportTables = { rows: true },
): [string, string][] {
  const treeTarget = level.kind === 'tree' ? level.target : null;
  const all: [ExportConfig, Game[]][] = configs.map((c) => [c, exportOrder(c.games).filter((g) => treeTarget === null || g.target === treeTarget)]);
  const filter = opts.filter;
  const rows: [ExportConfig, Game[]][] =
    filter && opts.onlyMatching ? all.map(([c, games]) => [c, games.filter((g) => touchesMatch(words, g, filter))]) : all;
  const cards: [ExportConfig, CardStats][] = all.map(([c, games]) => [c, cardOf(words, c, games, treeTarget !== null ? 1 : c.nTargets)]);
  const files: [string, string][] = [['configs.csv', configsCsv(configs, opts)]];
  if (tables.rows) {
    files.push(['games.csv', gamesCsv(words, rows)]);
    files.push(['plays.csv', playsCsv(words, rows, filter)]);
  }
  switch (level.kind) {
    case 'tree':
      if (tables.rows) files.push(['nodes.csv', nodesCsv(words, level.target, rows, filter)]);
      files.push(['distribution.csv', distributionCsv(cards)]);
      break;
    case 'card':
      files.push(['distribution.csv', distributionCsv(cards)]);
      files.push(['summary.csv', summaryCsv(cards)]);
      break;
    case 'atlas':
      files.push(['distribution.csv', distributionCsv(cards)]);
      files.push(['summary.csv', summaryCsv(cards)]);
      files.push(['paired.csv', pairedCsv(words, configs, level.pairs)]);
      break;
  }
  return files;
}
