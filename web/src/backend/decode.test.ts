import { describe, expect, it } from 'vitest';
import { BATCH_MAGIC, BatchError, batchGameCount, concatBuffers, decodeBatch, decodeBatches, encodeGames, encodedSize } from './decode';
import { normaliseProgress, normaliseSummary } from './protocol';
import { fnv1a, scopeKey } from './stream';
import type { Game } from './types';

/** A hand-built batch: header, then games and turns, little-endian. */
function handBuilt(): ArrayBuffer {
  const bytes: number[] = [];
  const u8 = (v: number) => bytes.push(v & 0xff);
  const u16 = (v: number) => {
    u8(v);
    u8(v >> 8);
  };
  const u32 = (v: number) => {
    u16(v & 0xffff);
    u16(v >>> 16);
  };
  const f32 = (v: number) => {
    const b = new Uint8Array(new Float32Array([v]).buffer);
    for (const x of b) u8(x);
  };
  u32(0x42474c57); // "WLGB"
  u16(1);
  u16(2);
  // Game 1: target 7, replicate 3, 2 turns, solved.
  u16(7);
  u16(3);
  u8(2);
  u8(1);
  u16(1234); u16(17); u16(2315); u16(80); f32(1); f32(5.25); u8(255); u8(0);
  u16(99); u16(242); u16(80); u16(1); f32(0.5); f32(2.5); u8(0); u8(1);
  // Game 2: target 65535, replicate 0, 1 turn, not solved.
  u16(65535);
  u16(0);
  u8(1);
  u8(0);
  u16(5); u16(0); u16(3); u16(3); f32(0.125); f32(0); u8(2); u8(1);
  return new Uint8Array(bytes).buffer;
}

describe('binary game batches', () => {
  it('decodes a hand-built batch', () => {
    const buf = handBuilt();
    expect(buf.byteLength).toBe(8 + 6 + 2 * 18 + 6 + 18);
    expect(batchGameCount(buf)).toBe(2);
    const games = decodeBatch(buf);
    expect(games).toEqual<Game[]>([
      {
        target: 7,
        replicate: 3,
        solved: true,
        turns: [
          { guess: 1234, pattern: 17, candsBefore: 2315, candsAfter: 80, pChosen: 1, bitsExpected: 5.25, phase: 255, isCandidate: false },
          { guess: 99, pattern: 242, candsBefore: 80, candsAfter: 1, pChosen: 0.5, bitsExpected: 2.5, phase: 0, isCandidate: true },
        ],
      },
      {
        target: 65535,
        replicate: 0,
        solved: false,
        turns: [{ guess: 5, pattern: 0, candsBefore: 3, candsAfter: 3, pChosen: 0.125, bitsExpected: 0, phase: 2, isCandidate: true }],
      },
    ]);
  });

  it('round-trips through the encoder, and reads concatenated batches', () => {
    const games = decodeBatch(handBuilt());
    const enc = encodeGames(games);
    expect(new Uint8Array(enc)).toEqual(new Uint8Array(handBuilt()));
    const two = concatBuffers([enc, encodeGames([]), enc]);
    expect(decodeBatches(two)).toEqual([...games, ...games]);
    expect(encodedSize([])).toBe(8);
    expect(decodeBatches(encodeGames([]))).toEqual([]);
    // A view into a larger buffer.
    const padded = new Uint8Array(enc.byteLength + 4);
    padded.set(new Uint8Array(enc), 2);
    expect(decodeBatches(padded.subarray(2, 2 + enc.byteLength))).toEqual(games);
  });

  it('splits more than 65,535 games into several batches', () => {
    const g: Game = { target: 1, replicate: 0, solved: true, turns: [] };
    const many = new Array<Game>(70000).fill(g);
    const enc = encodeGames(many);
    expect(batchGameCount(enc)).toBe(65535);
    expect(decodeBatches(enc)).toHaveLength(70000);
  });

  it('rejects bad input', () => {
    const buf = handBuilt();
    const bad = new Uint8Array(buf.slice(0));
    bad[0] = 0;
    expect(() => decodeBatches(bad)).toThrow(BatchError);
    const v2 = new Uint8Array(buf.slice(0));
    v2[4] = 2;
    expect(() => decodeBatches(v2)).toThrow(/version/);
    expect(() => decodeBatches(buf.slice(0, buf.byteLength - 1))).toThrow(/truncated/);
    expect(() => decodeBatches(buf.slice(0, 5))).toThrow(/truncated/);
    expect(new DataView(buf).getUint32(0, true)).toBe(BATCH_MAGIC);
  });
});

describe('protocol helpers', () => {
  it('accepts camelCase and snake_case progress and summaries', () => {
    expect(normaliseProgress({ done: 3, total: 9, targets_done: 1, targets_total: 3, settled_depth: 2 })).toEqual({
      done: 3,
      total: 9,
      targetsDone: 1,
      targetsTotal: 3,
      settledDepth: 2,
    });
    expect(normaliseSummary({ config_id: 'abc', n_games: 5, elapsed_ms: 1.5, phases: ['a'], deterministic: true })).toEqual({
      configId: 'abc',
      nGames: 5,
      elapsedMs: 1.5,
      phases: ['a'],
      deterministic: true,
    });
  });

  it('keys scopes canonically', () => {
    expect(scopeKey({ targets: 'all' }, 20)).toBe(scopeKey({ targets: 'all', replicates: [0, 20] }, 20));
    expect(scopeKey({ targets: [3, 1] }, 1)).toBe('t3,1/r0-1');
    expect(scopeKey({ targets: { sample: 200 } }, 5)).toBe('s200/r0-5');
    const long = Array.from({ length: 100 }, (_, i) => i);
    expect(scopeKey({ targets: long }, 1)).toBe(`t100-${fnv1a(long.join(','))}/r0-1`);
  });
});
