import { describe, expect, it } from 'vitest';
import { makeConfig as appMakeConfig, type MakeConfigOptions } from '../app/config';
import { DEFAULT_RESULT, type ResultSettings, type StrategyEntry } from '../app/store.svelte';
import type { Config } from '../backend/types';
import {
  gameMetric,
  keepCount,
  nextEffort,
  pairedDifference,
  plannedRounds,
  rankOpeners,
  rankStrategies,
  seededOrder,
  type Ranking,
  type RankingDeps,
} from './rankings';
import { createRunManager } from './runs';
import { FakeBackend, tinyWords, until } from './testing';
import type { WordData } from './types';

function deps(words: WordData, backend: FakeBackend, result: Partial<ResultSettings> = {}): RankingDeps {
  const r: ResultSettings = { ...structuredClone(DEFAULT_RESULT), ...result };
  const makeConfig = (o: MakeConfigOptions): Config => {
    const c = appMakeConfig(o);
    return {
      ...c,
      word_list: { id: words.manifest.id, version: words.manifest.version, answers: { kind: 'default' } },
      rules: { max_guesses: r.maxGuesses, hard_mode: r.hardMode },
      replicates: c.replicates === 1 && o.replicates === undefined ? r.replicatesCard : c.replicates,
    };
  };
  return {
    runs: createRunManager(() => backend),
    words,
    result: r,
    makeConfig,
    openerInfo: () => backend.openerInfo(),
    strategies: () => [],
  };
}

function strategies(n: number): StrategyEntry[] {
  // info_proportional with rising beta: the fake backend makes higher beta worse (more guesses).
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    label: `Strategy ${String.fromCharCode(65 + ((i * 7) % n))}`,
    colour: '#000',
    spec: { kind: 'info_proportional', beta: i * 0.8, pool: 'candidates' },
  }));
}

async function done(r: Ranking): Promise<void> {
  await until(() => r.status !== 'running', 10000);
}

describe('successive halving helpers', () => {
  it('halves but keeps at least the full-evaluation count', () => {
    expect(keepCount(20, 10)).toBe(10);
    expect(keepCount(25, 10)).toBe(13);
    expect(keepCount(12, 10)).toBe(10);
    expect(keepCount(7, 10)).toBe(7);
  });

  it('doubles targets, then replicates', () => {
    expect(nextEffort({ targets: 200, reps: 1 }, 2500, 20)).toEqual({ targets: 400, reps: 1 });
    expect(nextEffort({ targets: 1600, reps: 1 }, 2500, 20)).toEqual({ targets: 2500, reps: 1 });
    expect(nextEffort({ targets: 2500, reps: 1 }, 2500, 20)).toEqual({ targets: 2500, reps: 2 });
    expect(nextEffort({ targets: 2500, reps: 16 }, 2500, 20)).toEqual({ targets: 2500, reps: 20 });
  });

  it('plans rounds', () => {
    expect(plannedRounds(20, 10)).toBe(2); // screen, full
    expect(plannedRounds(8, 10)).toBe(1); // full only
    expect(plannedRounds(8, 10, true)).toBe(2); // information, full
    expect(plannedRounds(2500, 10, true)).toBe(9);
  });

  it('seeds a stable permutation', () => {
    const a = seededOrder(50, 1);
    expect([...a].sort((x, y) => x - y)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(seededOrder(50, 1)).toEqual(a);
    expect(seededOrder(50, 2)).not.toEqual(a);
  });

  it('scores games per metric', () => {
    const g = (n: number, solved: boolean) => ({ target: 0, replicate: 0, solved, turns: new Array(n).fill(null) });
    expect(gameMetric('mean', g(4, true), 6)).toBe(4);
    expect(gameMetric('mean', g(6, false), 6)).toBe(6);
    expect(gameMetric('mean_fail_plus', g(6, false), 6)).toBe(7);
    expect(gameMetric('fail_rate', g(6, false), 6)).toBe(1);
    expect(gameMetric('le3', g(3, true), 6)).toBe(1);
    expect(gameMetric('le3', g(4, true), 6)).toBe(0);
  });

  it('computes paired differences with a finite-population correction', () => {
    const a = new Map<number, [number, number, number]>([
      [0, [3, 9, 1]],
      [1, [4, 16, 1]],
      [2, [5, 25, 1]],
    ]);
    const b = new Map<number, [number, number, number]>([
      [0, [3, 9, 1]],
      [1, [3, 9, 1]],
      [2, [3, 9, 1]],
    ]);
    const d = pairedDifference(a, b, 6);
    // diffs 0, 1, 2: mean 1, sample variance 1, fpc 1 − 3/6.
    expect(d.mean).toBe(1);
    expect(d.n).toBe(3);
    expect(d.se).toBeCloseTo(Math.sqrt((0.5 * 1) / 3), 12);
  });
});

describe('rankStrategies', () => {
  it('screens, halves and gives the survivors full cards', async () => {
    const words = tinyWords();
    const backend = new FakeBackend(words);
    const d = deps(words, backend, { rankKeep: 3, replicatesCard: 4 });
    const r = rankStrategies('crane', strategies(7), d);
    expect(r.status).toBe('running');
    expect(r.rounds).toBe(3); // screen (7 → 4), round 2 (4 → 3), full
    await done(r);
    expect(r.status).toBe('done');
    expect(r.entries).toHaveLength(7);
    const full = r.entries.filter((e) => e.stage === 'full');
    expect(full).toHaveLength(3);
    // The best (lowest beta) strategies survive and rank first.
    expect(full.map((e) => e.key).sort()).toEqual(['s0', 's1', 's2']);
    expect(r.entries.slice(0, 3).every((e) => e.stage === 'full')).toBe(true);
    expect(r.entries.map((e) => e.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (let i = 1; i < 3; i++) expect(r.entries[i].value).toBeGreaterThanOrEqual(r.entries[i - 1].value);
    for (const e of full) {
      expect(e.targets).toBe(30);
      expect(e.replicates).toBe(4);
      expect(e.ciLow).toBeLessThanOrEqual(e.value);
      expect(e.ciHigh).toBeGreaterThanOrEqual(e.value);
      expect(e.distribution).toHaveLength(7);
      expect(e.distribution.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
      expect(e.provisional).toBe(false);
      expect(e.run?.status).toBe('done');
    }
    // Screened entries keep their screening score.
    for (const e of r.entries.filter((x) => x.stage === 'screened')) expect(Number.isFinite(e.value)).toBe(true);
    // Every candidate was screened on the same targets (paired), at R = 1.
    const screens = backend.runs.filter((q) => Array.isArray(q.scope.targets));
    const lists = new Set(screens.map((q) => JSON.stringify(q.scope.targets)));
    expect(lists.size).toBe(1);
    expect(r.round).toBe(3);
  });

  it('breaks ties on fail rate, then name', async () => {
    const words = tinyWords();
    const backend = new FakeBackend(words, { skill: () => 3 });
    const set: StrategyEntry[] = ['Zeta', 'Alpha', 'Mid'].map((label, i) => ({
      id: `t${i}`,
      label,
      colour: '#000',
      spec: { kind: 'max_info', pool: 'candidates' },
    }));
    const r = rankStrategies(null, set, deps(words, backend, { rankKeep: 5 }));
    await done(r);
    expect(r.entries.map((e) => e.label)).toEqual(['Alpha', 'Mid', 'Zeta']);
    expect(r.fixedValue).toBe('NA');
    // Identical deterministic results are exact, and equal values are tied.
    expect(r.entries.every((e) => e.ciLow === e.value && e.ciHigh === e.value)).toBe(true);
  });

  it('can be cancelled', async () => {
    const words = tinyWords();
    const backend = new FakeBackend(words, { batch: 1 });
    const r = rankStrategies('crane', strategies(6), deps(words, backend, { rankKeep: 2 }));
    let calls = 0;
    r.onChange(() => calls++);
    await Promise.resolve();
    r.cancel();
    expect(r.status).toBe('cancelled');
    expect(calls).toBeGreaterThan(0);
    const started = backend.runs.length;
    await new Promise((res) => setTimeout(res, 50));
    expect(r.status).toBe('cancelled');
    // No further rounds start after cancelling.
    expect(backend.runs.length).toBe(started);
    expect(r.entries.every((e) => e.stage !== 'full')).toBe(true);
  });
});

describe('rankOpeners', () => {
  it('screens openers by one-step information, then plays the best', async () => {
    const words = tinyWords();
    const backend = new FakeBackend(words);
    const strategy: StrategyEntry = { id: 'ip', label: 'IP', colour: '#000', spec: { kind: 'info_proportional', beta: 1, pool: 'candidates' } };
    const openers = ['crane', 'slate', 'speed', 'abide', 'erase', 'steal', 'crepe', 'zzzzz'];
    const r = rankOpeners(strategy, openers, deps(words, backend, { rankKeep: 2, replicatesCard: 2 }));
    await done(r);
    expect(r.status).toBe('done');
    expect(backend.openerInfoCalls).toBe(1);
    // Unknown words are dropped.
    expect(r.entries.map((e) => e.key)).not.toContain('zzzzz');
    expect(r.entries).toHaveLength(7);
    const full = r.entries.filter((e) => e.stage === 'full');
    expect(full).toHaveLength(2);
    // Openers dropped by the information screen keep their bits as their score.
    const infoOnly = r.entries.filter((e) => e.scoreKind === 'info');
    expect(infoOnly.length).toBeGreaterThan(0);
    for (const e of infoOnly) {
      expect(e.stage).toBe('screened');
      expect(e.value).toBeGreaterThan(2.9);
    }
    // They rank below every entry scored by the metric.
    const firstInfo = r.entries.findIndex((e) => e.scoreKind === 'info');
    expect(r.entries.slice(firstInfo).every((e) => e.scoreKind === 'info')).toBe(true);
    // Among info-screened entries, higher information ranks first.
    for (let i = firstInfo + 1; i < r.entries.length; i++) expect(r.entries[i].value).toBeLessThanOrEqual(r.entries[i - 1].value);
    expect(r.fixedKind).toBe('strategy');
    expect(r.fixedValue).toBe('ip');
  });
});
