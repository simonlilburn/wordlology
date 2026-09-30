// @vitest-environment jsdom
//
// Proxy safety: Svelte 5 $state proxies cannot be structured-cloned, so every
// backend entry point that posts to a worker must copy its config/request into
// plain data first. The fake worker below structured-clones every message it
// is sent, exactly as a real Worker's postMessage does, and would throw a
// DataCloneError on a proxy. (This file is compiled with runes in the browser
// build, hence `.svelte.test.ts` and the jsdom environment: under the node
// environment $state compiles to a plain object.)

import { describe, expect, it } from 'vitest';
import { createRunManager } from '../model/runs';
import { tinyWords, until } from '../model/testing';
import { CacheBackend, MemoryStore } from './cache';
import { encodeGames } from './decode';
import { LocalWasmBackend } from './local';
import type { WorkerLike } from './pool';
import type { FromWorker, ToWorker } from './protocol';
import { StaticBackend } from './static';
import { plain } from './stream';
import type { Config, Game, RunEvent } from './types';

const words = tinyWords();

function baseConfig(): Config {
  return {
    word_list: { id: 'tiny-5', version: '0.0.1', answers: { kind: 'default' } },
    rules: { max_guesses: 6, hard_mode: false },
    strategy: { kind: 'info_proportional', beta: 1, pool: 'candidates' },
    opener: 'crane',
    replicates: 2,
    base_seed: 1,
    weighting: 'equal',
  };
}

function oneGame(target: number, replicate: number): Game {
  const guess = words.answers[target];
  return {
    target,
    replicate,
    solved: true,
    turns: [{ guess, pattern: 242, candsBefore: 30, candsAfter: 1, pChosen: 0.5, bitsExpected: 2, phase: 0, isCandidate: true }],
  };
}

/** A worker that structured-clones every message (as postMessage does) and answers like the solver. */
class CloningWorker implements WorkerLike {
  onmessage: ((ev: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  received: ToWorker[] = [];

  postMessage(msg: ToWorker): void {
    const m = structuredClone(msg); // throws DataCloneError on a $state proxy
    this.received.push(m);
    setTimeout(() => this.answer(m), 0);
  }

  private send(data: FromWorker): void {
    this.onmessage?.({ data } as MessageEvent<FromWorker>);
  }

  private answer(m: ToWorker): void {
    switch (m.type) {
      case 'load':
        return this.send({ type: 'loaded', key: m.key, matrixMs: 1 });
      case 'meta':
        return this.send({ type: 'result', reqId: m.reqId, data: { solverVersion: 'test', schemas: [], presets: [] } });
      case 'configId':
        return this.send({ type: 'result', reqId: m.reqId, data: 'c0ffee00c0ffee00' });
      case 'scores':
        return this.send({ type: 'result', reqId: m.reqId, data: { entries: [], deterministic: false, phase: 'info', candidates: 30 } });
      case 'openerInfo':
        return this.send({ type: 'result', reqId: m.reqId, data: new Float64Array(words.guesses.length) });
      case 'continue':
        return this.send({ type: 'result', reqId: m.reqId, data: encodeGames([oneGame(m.target, m.replicate)]) });
      case 'run': {
        const [a, b] = m.scope.replicates ?? [0, m.config.replicates];
        const games: Game[] = [];
        for (let r = a; r < b; r++) games.push(oneGame(0, r), oneGame(1, r));
        this.send({ type: 'games', runId: m.runId, buffer: encodeGames(games) });
        this.send({ type: 'progress', runId: m.runId, done: games.length, total: games.length, targetsDone: 2, targetsTotal: 2 });
        this.send({ type: 'summary', runId: m.runId, configId: 'c0ffee00c0ffee00', nGames: games.length, elapsedMs: 1, phases: ['info'], deterministic: false });
        return;
      }
      default:
        return;
    }
  }

  terminate(): void {}
}

async function setup() {
  const workers: CloningWorker[] = [];
  const local = new LocalWasmBackend(() => {
    const w = new CloningWorker();
    workers.push(w);
    return w;
  }, 2);
  await local.setWords(words);
  return { local, workers };
}

async function drain(stream: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe('proxy safety', () => {
  it('uses real $state proxies, which cannot be structured-cloned', () => {
    const config = $state(baseConfig());
    expect(() => structuredClone(config)).toThrow();
    expect(() => structuredClone(plain(config))).not.toThrow();
    expect(plain(config)).toEqual(baseConfig());
  });

  it('LocalWasmBackend copies proxies before posting to a worker', async () => {
    const { local, workers } = await setup();
    const config = $state(baseConfig());
    const scope = $state({ targets: [0, 1] as number[] });
    const history = $state([{ guess: words.index.get('crane')!, pattern: 0 }]);

    expect(await local.configId(config)).toBe('c0ffee00c0ffee00');

    const events = await drain(local.run({ config, scope, priority: 'focused' }, new AbortController().signal));
    const games = events.flatMap((e) => (e.type === 'games' ? e.games : []));
    expect(games).toHaveLength(4);
    expect(events.at(-1)?.type).toBe('summary');

    const scores = await local.scores({ config, history, topK: 5 });
    expect(scores.candidates).toBe(30);

    const info = await local.openerInfo(config);
    expect(info).toBeInstanceOf(Float64Array);

    const prefix = $state([words.index.get('crane')!]);
    const game = await local.continueGame({ config, target: 3, history: prefix, replicate: 1, oneStep: false });
    expect(game.target).toBe(3);
    expect(game.replicate).toBe(1);

    const types = new Set(workers.flatMap((w) => w.received.map((m) => m.type)));
    for (const t of ['load', 'configId', 'run', 'scores', 'openerInfo', 'continue']) expect(types.has(t as ToWorker['type'])).toBe(true);
  });

  it('CacheBackend over StaticBackend forwards plain copies', async () => {
    const { local } = await setup();
    const notFound = (async () => new Response('', { status: 404 })) as typeof fetch;
    const cache = new CacheBackend(new StaticBackend(local, '/precomputed/', notFound), new MemoryStore());
    const config = $state(baseConfig());
    const scope = $state({ targets: 'all' as const });

    const first = await drain(cache.run({ config, scope }, new AbortController().signal));
    expect(first.some((e) => e.type === 'summary')).toBe(true);
    expect(await cache.configId(config)).toBe('c0ffee00c0ffee00');
    expect(await cache.openerInfo(config)).toBeInstanceOf(Float64Array);
    const history = $state([] as { guess: number; pattern: number }[]);
    expect((await cache.scores({ config, history, topK: 3 })).phase).toBe('info');
    const prefix = $state([] as number[]);
    expect((await cache.continueGame({ config, target: 2, history: prefix, replicate: 0, oneStep: true })).target).toBe(2);
  });

  it('runs.request accepts proxied configs and scopes', async () => {
    const { local } = await setup();
    const manager = createRunManager(() => local);
    const config = $state(baseConfig());
    const scope = $state({ targets: [0, 1] as number[] });
    const run = manager.request(config, scope, 'focused');
    await until(() => run.status === 'done' || run.status === 'error');
    expect(run.error).toBeNull();
    expect(run.status).toBe('done');
    expect(run.games).toHaveLength(4);
    expect(run.configId).toBe('c0ffee00c0ffee00');
    // The run holds plain copies, so later edits to the proxy do not leak into it.
    config.opener = 'slate';
    expect(run.config.opener).toBe('crane');
    expect(() => structuredClone(run.config)).not.toThrow();
  });
});
