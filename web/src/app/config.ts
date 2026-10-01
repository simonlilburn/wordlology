// Building configurations from the current settings. Owned by the platform agent.
import type { AnswerSelection, Config, Pool, StrategySpec, SwitchRule } from '../backend/types';
import { answersSha256, normaliseWords } from '../model/sha256';
import { DEFAULT_LIST_ID } from '../model/wordlists';
import { app, type ResultSettings } from './store.svelte';

export interface MakeConfigOptions {
  strategy: StrategySpec;
  opener: string | null;
  /** 'tree' uses the Tree view replicate count, 'card' the card/atlas count. */
  kind: 'tree' | 'card';
  /** Override replicates (e.g. Quick check). */
  replicates?: number;
}

/** The answer selection of a configuration from the result settings (pasted lists carry their sha256). */
export function answerSelection(result: ResultSettings = app.result): AnswerSelection {
  const a = result.answers;
  switch (a.kind) {
    case 'default':
      return { kind: 'default' };
    case 'top':
      return { kind: 'top', n: a.n };
    case 'pasted': {
      const words = normaliseWords(a.words);
      return { kind: 'pasted', sha256: a.sha256 || answersSha256(words), words };
    }
  }
}

/**
 * Apply the "Stochastic guess pool" setting: the full allowed pool is opt-in,
 * so when the setting is 'allowed' every information-based stochastic
 * strategy (info_proportional, recursively through combinators) uses it;
 * with the default 'candidates' specs keep their own pool.
 */
export function applyPoolSetting(spec: StrategySpec, pool: Pool): StrategySpec {
  if (pool !== 'allowed') return spec;
  switch (spec.kind) {
    case 'info_proportional':
      return spec.pool === 'allowed' ? spec : { ...spec, pool };
    case 'coverage_then':
      return { ...spec, then: applyPoolSetting(spec.then, pool) };
    case 'sequence_then':
      return { ...spec, then: applyPoolSetting(spec.then, pool) };
    case 'switch':
      return { ...spec, first: applyPoolSetting(spec.first, pool), then: applyPoolSetting(spec.then, pool) };
    case 'mixture':
      return { ...spec, strategies: spec.strategies.map((s) => applyPoolSetting(s, pool)) };
    case 'solve_when_le':
      return { ...spec, inner: applyPoolSetting(spec.inner, pool) };
    default:
      return spec;
  }
}

/** A configuration from the store's result settings. */
export function makeConfig(opts: MakeConfigOptions): Config {
  const r = app.result;
  const m = app.words?.manifest;
  const strategy = applyPoolSetting(opts.strategy, r.stochasticPool);
  const deterministic = isDeterministicSpec(strategy);
  const reps = opts.replicates ?? (opts.kind === 'tree' ? r.replicatesTree : r.replicatesCard);
  return {
    word_list: { id: m?.id ?? DEFAULT_LIST_ID, version: m?.version ?? '1.0.0', answers: answerSelection(r) },
    rules: { max_guesses: r.maxGuesses, hard_mode: r.hardMode },
    strategy,
    opener: opts.opener ? opts.opener.toLowerCase() : null,
    replicates: deterministic ? 1 : Math.max(1, Math.round(reps)),
    base_seed: r.baseSeed,
    weighting: r.weighting,
  };
}

/** Whether a spec is deterministic (mirrors Strategy::is_deterministic). */
export function isDeterministicSpec(spec: StrategySpec): boolean {
  switch (spec.kind) {
    case 'max_info':
    case 'most_frequent':
    case 'fixed_sequence':
      return true;
    case 'random':
    case 'info_proportional':
    case 'freq_proportional':
      return false;
    case 'coverage_then':
    case 'sequence_then':
      return isDeterministicSpec(spec.then);
    case 'switch':
      return isDeterministicSpec(spec.first) && isDeterministicSpec(spec.then);
    case 'mixture': {
      const live = spec.strategies.filter((_, i) => (spec.weights[i] ?? 0) > 0);
      return live.length <= 1 && live.every(isDeterministicSpec);
    }
    case 'solve_when_le':
      return isDeterministicSpec(spec.inner);
  }
}

function fmtBeta(b: number | undefined): string {
  return String(b ?? 1);
}

function ruleLabel(r: SwitchRule): string {
  switch (r.when) {
    case 'after_turns':
      return `after ${r.k} ${r.k === 1 ? 'guess' : 'guesses'}`;
    case 'candidates_le':
      return `at ≤ ${r.n} candidates`;
    case 'bits_le':
      return `at ≤ ${r.h} bits`;
    case 'sequence_exhausted':
      return 'when the sequence ends';
  }
}

function listWords(words: string[]): string {
  const w = words.map((x) => x.toUpperCase());
  return w.length <= 3 ? w.join(', ') : `${w.slice(0, 3).join(', ')}, …`;
}

/** A short human label for a spec, e.g. "Info-proportional β=1". */
export function specLabel(spec: StrategySpec): string {
  switch (spec.kind) {
    case 'max_info':
      return spec.pool === 'allowed' ? 'Max information (all guesses)' : 'Max information';
    case 'most_frequent':
      return 'Most frequent';
    case 'fixed_sequence':
      return `Sequence ${listWords(spec.words)}`;
    case 'random':
      return spec.pool === 'allowed' ? 'Random (all guesses)' : 'Random candidate';
    case 'info_proportional':
      return `Info-proportional β=${fmtBeta(spec.beta)}${spec.pool === 'allowed' ? ' (all guesses)' : ''}`;
    case 'freq_proportional':
      return `Frequency-proportional β=${fmtBeta(spec.beta)}`;
    case 'coverage_then':
      return `Coverage, then ${specLabel(spec.then)} ${ruleLabel(spec.switch)}`;
    case 'sequence_then':
      return `${listWords(spec.words)}, then ${specLabel(spec.then)}`;
    case 'switch':
      return `${specLabel(spec.first)}, then ${specLabel(spec.then)} ${ruleLabel(spec.when)}`;
    case 'mixture':
      return `Mixture of ${spec.strategies.map(specLabel).join(' / ')}`;
    case 'solve_when_le':
      return `${specLabel(spec.inner)}, solve at ≤ ${spec.n}`;
  }
}

/**
 * Fill serde defaults into a spec (mirrors the Rust StrategySpec round-trip),
 * so equal configurations share one local run key before the solver has
 * computed their config ID.
 */
export function fillSpecDefaults(spec: StrategySpec): StrategySpec {
  switch (spec.kind) {
    case 'max_info':
      return { kind: 'max_info', pool: spec.pool ?? 'candidates' };
    case 'most_frequent':
      return { kind: 'most_frequent' };
    case 'fixed_sequence':
      return { kind: 'fixed_sequence', words: spec.words.map((w) => w.toLowerCase()), solve_when_one: spec.solve_when_one ?? true };
    case 'random':
      return { kind: 'random', pool: spec.pool ?? 'candidates' };
    case 'info_proportional':
      return { kind: 'info_proportional', beta: spec.beta ?? 1, pool: spec.pool ?? 'candidates' };
    case 'freq_proportional':
      return { kind: 'freq_proportional', beta: spec.beta ?? 1 };
    case 'coverage_then':
      return { kind: 'coverage_then', switch: spec.switch, then: fillSpecDefaults(spec.then) };
    case 'sequence_then':
      return { kind: 'sequence_then', words: spec.words.map((w) => w.toLowerCase()), switch: spec.switch, then: fillSpecDefaults(spec.then) };
    case 'switch':
      return { kind: 'switch', first: fillSpecDefaults(spec.first), then: fillSpecDefaults(spec.then), when: spec.when };
    case 'mixture':
      return { kind: 'mixture', weights: [...spec.weights], strategies: spec.strategies.map(fillSpecDefaults) };
    case 'solve_when_le':
      return { kind: 'solve_when_le', n: spec.n, inner: fillSpecDefaults(spec.inner) };
  }
}

/** JSON with object keys sorted and no whitespace. */
export function sortedJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${sortedJson(o[k])}`).join(',')}}`;
}

/**
 * A local canonical form of a configuration (defaults filled, replicates 1 when
 * deterministic, pasted words dropped, keys sorted). Not the solver's
 * canonical JSON (float formatting may differ); used only for local keys.
 */
export function localConfigKey(config: Config): string {
  const strategy = fillSpecDefaults(config.strategy);
  const answers = config.word_list.answers;
  const c = {
    ...config,
    strategy,
    replicates: isDeterministicSpec(strategy) ? 1 : config.replicates,
    word_list: {
      ...config.word_list,
      answers: answers.kind === 'pasted' ? { kind: 'pasted', sha256: answers.sha256 } : answers,
    },
  };
  return sortedJson(c);
}

/** A strategy's canonical JSON (sorted keys, defaults filled), as exported in strategy_json. */
export function strategyJson(spec: StrategySpec): string {
  return sortedJson(fillSpecDefaults(spec));
}
