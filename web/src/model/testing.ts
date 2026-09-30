// Test fixtures shared by the platform's unit tests: a tiny word list and a
// fake solver backend that plays deterministic synthetic games. Not imported
// by the app.

import { fillSpecDefaults, isDeterministicSpec, sortedJson } from '../app/config';
import type { Config, Game, RunEvent, RunRequest, SolverBackend, Turn, WordListManifest } from '../backend/types';
import { allCorrect, feedback } from './feedback';
import type { WordData } from './types';
import { buildWordData } from './wordlists';

export const TINY_ANSWERS = [
  'about', 'above', 'abuse', 'actor', 'acute', 'admit', 'adopt', 'adult', 'after', 'again',
  'agent', 'agree', 'ahead', 'alarm', 'album', 'alert', 'alike', 'alive', 'allow', 'alone',
  'along', 'alter', 'among', 'anger', 'angle', 'angry', 'apart', 'apple', 'apply', 'arena',
];
export const TINY_EXTRA = ['abide', 'crane', 'crepe', 'erase', 'slate', 'speed', 'steal'];

export function tinyManifest(): WordListManifest {
  return {
    id: 'tiny-5',
    name: 'Tiny test list',
    version: '0.0.1',
    word_length: 5,
    answers: 'answers.txt',
    guesses: 'guesses.txt',
    frequencies: 'frequencies.tsv',
    licence: 'test',
    credits: [],
    counts: {},
    sha256: {},
  };
}

/** A tiny word list: 30 answers, 37 guesses, frequencies for every guess. */
export function tinyWords(): WordData {
  const guesses = [...TINY_ANSWERS, ...TINY_EXTRA].sort();
  const freq = guesses.map((w, i) => `${w}\t${(3 + (i % 5) * 0.5).toFixed(2)}`).join('\n');
  return buildWordData({
    manifest: tinyManifest(),
    guesses: guesses.join('\n') + '\n',
    answers: TINY_ANSWERS.join('\n') + '\n',
    ranked: null,
    frequencies: freq + '\n',
  });
}

/** A small deterministic hash of a string to [0, 1). */
export function unitHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

export interface FakeOptions {
  /** Expected guesses of a configuration (lower is better); default from the strategy's `beta` or kind. */
  skill?: (config: Config) => number;
  /** Games per emitted batch. */
  batch?: number;
}

/**
 * A fake solver: a game's length is skill + noise(target, replicate) (stochastic)
 * or skill + noise(target) (deterministic); longer than max guesses fails.
 * The guesses are real words, and the game ends on the target when solved.
 */
export class FakeBackend implements SolverBackend {
  readonly id = 'fake';
  runs: RunRequest[] = [];
  openerInfoCalls = 0;
  constructor(
    readonly words: WordData,
    readonly opts: FakeOptions = {},
  ) {}

  async capabilities() {
    return { solverVersion: 'test', strategies: [], presets: [], wordLists: ['tiny-5'], exactMode: false, maxReplicates: 1000 };
  }
  async wordLists() {
    return [this.words.manifest];
  }

  async configId(config: Config): Promise<string> {
    const c = { ...config, strategy: fillSpecDefaults(config.strategy) };
    return unitHash(sortedJson(c)).toString(16).slice(2, 18).padEnd(16, '0');
  }

  skill(config: Config): number {
    if (this.opts.skill) return this.opts.skill(config);
    const s = config.strategy as { beta?: number };
    return 3 + (s.beta ?? 1) * 0.5 + (config.opener ? unitHash(config.opener) : 0.5);
  }

  /** The synthetic game of (config, target, replicate). */
  game(config: Config, target: number, replicate: number): Game {
    const w = this.words;
    const det = isDeterministicSpec(config.strategy);
    const noise = unitHash(`${config.opener}|${target}|${det ? 0 : replicate}`) * 2 - 0.5;
    const n = Math.max(1, Math.round(this.skill(config) + noise));
    const max = config.rules.max_guesses;
    const solved = n <= max;
    const len = solved ? n : max;
    const targetWord = w.guesses[w.answers[target]];
    const turns: Turn[] = [];
    let cands = w.answers.length;
    for (let i = 0; i < len; i++) {
      const last = solved && i === len - 1;
      let guess: number;
      if (last) guess = w.answers[target];
      else if (i === 0 && config.opener) guess = w.index.get(config.opener)!;
      else {
        guess = Math.floor(unitHash(`${target}|${replicate}|${i}`) * w.guesses.length);
        if (guess === w.answers[target]) guess = (guess + 1) % w.guesses.length;
      }
      const pattern = feedback(w.guesses[guess], targetWord);
      const after = pattern === allCorrect(5) ? 1 : Math.max(1, Math.floor(cands / 3));
      turns.push({ guess, pattern, candsBefore: cands, candsAfter: after, pChosen: 0.5, bitsExpected: 1.5, phase: 0, isCandidate: true });
      cands = after;
    }
    return { target, replicate, turns, solved };
  }

  async *run(req: RunRequest, signal: AbortSignal): AsyncIterable<RunEvent> {
    this.runs.push(req);
    const config = req.config;
    const det = isDeterministicSpec(config.strategy);
    const n = this.words.answers.length;
    const targets = req.scope.targets === 'all' ? Array.from({ length: n }, (_, i) => i) : Array.isArray(req.scope.targets) ? req.scope.targets : Array.from({ length: Math.min(n, req.scope.targets.sample) }, (_, i) => i);
    const [a, b] = req.scope.replicates ?? [0, det ? 1 : config.replicates];
    const games: Game[] = [];
    for (let r = a; r < b; r++) for (const t of targets) games.push(this.game(config, t, r));
    const size = this.opts.batch ?? 50;
    for (let i = 0; i < games.length; i += size) {
      if (signal.aborted) return;
      await Promise.resolve();
      yield { type: 'games', games: games.slice(i, i + size) };
      yield { type: 'progress', done: Math.min(games.length, i + size), total: games.length, targetsDone: Math.min(targets.length, i + size), targetsTotal: targets.length };
    }
    yield { type: 'summary', configId: await this.configId(config), nGames: games.length, elapsedMs: 1, phases: ['main'], deterministic: det };
  }

  async openerInfo(): Promise<Float64Array> {
    this.openerInfoCalls++;
    const info = new Float64Array(this.words.guesses.length);
    for (let i = 0; i < info.length; i++) info[i] = 6 - unitHash(this.words.guesses[i]) * 3;
    return info;
  }
}

/** Wait until `cond` holds (polling microtasks and timers), or throw after `ms`. */
export async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 1));
  }
}
