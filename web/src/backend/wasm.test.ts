// Integration tests with the real WASM solver, run in-process: the worker
// host, the pool (sharding, priorities), LocalWasmBackend, the cache and the
// run manager. Skipped while web/src/wasm/pkg has not been built.

import { fs } from '../model/testing';
const { existsSync, readFileSync } = fs;
import { beforeAll, describe, expect, it } from 'vitest';
import { cardStats } from '../model/card';
import { feedback, allCorrect } from '../model/feedback';
import { createRunManager } from '../model/runs';
import type { WordData } from '../model/types';
import { buildWordData, wordDataKey } from '../model/wordlists';
import { CacheBackend, MemoryStore } from './cache';
import { decodeBatches } from './decode';
import { LocalWasmBackend } from './local';
import type { WorkerLike } from './pool';
import type { FromWorker, ToWorker } from './protocol';
import { StaticBackend } from './static';
import type { Config, Game, WordListManifest } from './types';
import { createWorkerHost, type WasmModule } from './worker-host';

const WASM = new URL('../wasm/pkg/wl_wasm_bg.wasm', import.meta.url);
const hasWasm = existsSync(WASM);
const LIST = new URL('../../../data/wordlists/ref-en-5/', import.meta.url);

let wasm: WasmModule;
let words: WordData;

async function loadWasm(): Promise<WasmModule> {
  if (!wasm) {
    const mod = (await import('../wasm/pkg/wl_wasm.js')) as WasmModule;
    mod.initSync({ module: readFileSync(WASM) });
    wasm = mod;
  }
  return wasm;
}

function readList(): WordData {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', LIST), 'utf8')) as WordListManifest;
  return buildWordData({
    manifest,
    guesses: readFileSync(new URL('guesses.txt', LIST), 'utf8'),
    answers: readFileSync(new URL('answers.txt', LIST), 'utf8'),
    ranked: null,
    frequencies: readFileSync(new URL('frequencies.tsv', LIST), 'utf8'),
  });
}

function config(strategy: Config['strategy'], opener: string | null, replicates: number): Config {
  return {
    word_list: { id: 'ref-en-5', version: '1.0.0', answers: { kind: 'default' } },
    rules: { max_guesses: 6, hard_mode: false },
    strategy,
    opener,
    replicates,
    base_seed: 1,
    weighting: 'equal',
  };
}

/** A worker that runs the host in this thread (messages cloned, delivered asynchronously). */
function inProcessWorker(): WorkerLike & { host: ReturnType<typeof createWorkerHost> } {
  const w = {
    onmessage: null as ((ev: MessageEvent<FromWorker>) => void) | null,
    onerror: null as ((ev: ErrorEvent) => void) | null,
    postMessage(msg: ToWorker) {
      const copy = structuredClone(msg);
      setTimeout(() => host.onmessage(copy), 0);
    },
    terminate() {},
    host: null as unknown as ReturnType<typeof createWorkerHost>,
  };
  const host = createWorkerHost({
    post: (msg) => setTimeout(() => w.onmessage?.({ data: msg } as MessageEvent<FromWorker>), 0),
    loadWasm,
  });
  w.host = host;
  return w;
}

function checkGames(games: Game[]): void {
  const win = allCorrect(5);
  for (const g of games) {
    const target = words.guesses[words.answers[g.target]];
    expect(g.turns.length).toBeGreaterThan(0);
    for (const t of g.turns) expect(t.pattern).toBe(feedback(words.guesses[t.guess], target));
    const last = g.turns[g.turns.length - 1];
    expect(g.solved).toBe(last.pattern === win);
    if (!g.solved) expect(g.turns.length).toBe(6);
  }
}

describe.skipIf(!hasWasm)('the WASM solver in-process', () => {
  beforeAll(async () => {
    await loadWasm();
    words = readList();
  });

  it('speaks the worker protocol', async () => {
    const got: FromWorker[] = [];
    const host = createWorkerHost({ post: (m) => got.push(m), loadWasm });
    const key = wordDataKey(words);
    host.onmessage({ type: 'load', key, manifest: words.manifest, guesses: words.texts.guesses, answers: words.texts.answers, frequencies: words.texts.frequencies });
    host.onmessage({ type: 'configId', reqId: 1, key, config: config({ kind: 'max_info' }, 'crane', 20) });
    host.onmessage({ type: 'run', runId: 7, key, config: config({ kind: 'max_info' }, 'crane', 1), scope: { targets: 'all' } });
    const start = Date.now();
    while (!got.some((m) => m.type === 'summary') && Date.now() - start < 20000) await new Promise((r) => setTimeout(r, 5));
    expect(got[0]).toMatchObject({ type: 'loaded', key });
    const id = got.find((m) => m.type === 'result') as Extract<FromWorker, { type: 'result' }>;
    expect(id.data).toMatch(/^[0-9a-f]{16}$/);
    const games: Game[] = [];
    for (const m of got) if (m.type === 'games') decodeBatches(m.buffer, games);
    expect(games).toHaveLength(300);
    expect(new Set(games.map((g) => g.target)).size).toBe(300);
    checkGames(games);
    for (const g of games) expect(words.guesses[g.turns[0].guess]).toBe('crane');
    const summary = got.find((m) => m.type === 'summary') as Extract<FromWorker, { type: 'summary' }>;
    expect(summary.deterministic).toBe(true);
    expect(summary.nGames).toBe(300);
    const progress = got.filter((m) => m.type === 'progress') as Extract<FromWorker, { type: 'progress' }>[];
    expect(progress.at(-1)).toMatchObject({ done: 300, total: 300 });
    // Deterministic runs settle top-down.
    expect(progress.some((p) => p.settledDepth !== undefined)).toBe(true);
    // The first progress event names the phases (partial exports need them before the summary).
    expect(progress[0].phases).toEqual(summary.phases);
    expect(progress.slice(1).every((p) => p.phases === undefined)).toBe(true);
    const card = cardStats(games, 6, 300, true);
    expect(card.mean).toBeGreaterThan(2.5);
    expect(card.mean).toBeLessThan(5);
    expect(host.activeRuns()).toBe(0);
  });

  it('runs sharded stochastic cards through the pool, the cache and the run manager', async () => {
    const local = new LocalWasmBackend(() => inProcessWorker(), 3);
    const store = new MemoryStore();
    const notFound = (async () => new Response('', { status: 404 })) as typeof fetch;
    const backend = new CacheBackend(new StaticBackend(local, '/precomputed/', notFound), store);
    await local.setWords(words);
    const caps = await backend.capabilities();
    expect(caps.presets.length).toBeGreaterThan(0);
    expect(caps.solverVersion).toBeTruthy();

    const manager = createRunManager(() => backend);
    const cfg = config({ kind: 'info_proportional', beta: 1, pool: 'candidates' }, 'crane', 20);
    const run = manager.request(cfg, { targets: 'all' }, 'focused');
    const t0 = Date.now();
    while (run.status !== 'done' && run.status !== 'error' && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 10));
    expect(run.error).toBeNull();
    expect(run.status).toBe('done');
    expect(run.games).toHaveLength(6000);
    // 6,000 games: sharded across the idle workers by replicate range.
    expect(local.pool.slots.filter((s) => s.loaded.size > 0).length).toBe(3);
    const keys = new Set(run.games.map((g) => `${g.target}/${g.replicate}`));
    expect(keys.size).toBe(6000);
    checkGames(run.games.slice(0, 500));
    expect(run.configId).toMatch(/^[0-9a-f]{16}$/);
    expect(run.progress).toMatchObject({ done: 6000, total: 6000, targetsDone: 300, targetsTotal: 300 });

    // Replicate r of target t is the same game in a tree run of that target.
    const tree = manager.request({ ...cfg, replicates: 200 }, { targets: [5] }, 'focused');
    while (tree.status !== 'done' && tree.status !== 'error') await new Promise((r) => setTimeout(r, 10));
    expect(tree.games).toHaveLength(200);
    const byRep = new Map(tree.games.map((g) => [g.replicate, g]));
    for (const g of run.games.filter((x) => x.target === 5)) expect(byRep.get(g.replicate)).toEqual(g);

    // Complete runs are cached: a new manager gets the same games from the store.
    await new Promise((r) => setTimeout(r, 50));
    expect(store.runs.size).toBeGreaterThanOrEqual(1);
    const again = createRunManager(() => backend).request(cfg, { targets: 'all' }, 'visible');
    while (again.status !== 'done' && again.status !== 'error') await new Promise((r) => setTimeout(r, 5));
    expect(again.games).toHaveLength(6000);
    const sortKey = (g: Game) => g.target * 1000 + g.replicate;
    const a = [...run.games].sort((x, y) => sortKey(x) - sortKey(y));
    const b = [...again.games].sort((x, y) => sortKey(x) - sortKey(y));
    expect(b).toEqual(a);

    // Opener information, scores and continuing a game.
    const info = await backend.openerInfo(cfg);
    expect(info).toHaveLength(words.guesses.length);
    expect(info[words.index.get('crane')!]).toBeGreaterThan(3);
    const scores = await backend.scores({ config: cfg, history: [], topK: 3 });
    expect(scores.entries.length).toBeGreaterThan(0);
    const target = 5;
    const g5 = byRep.get(3)!;
    const cont = await backend.continueGame({ config: cfg, target, history: [g5.turns[0].guess], replicate: 3, oneStep: false });
    expect(cont.turns.map((t) => t.guess)).toEqual(g5.turns.map((t) => t.guess));
    local.pool.dispose();
  }, 90000);
});
