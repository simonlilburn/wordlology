// Binary game batches (docs/architecture.md, "Binary game batches").
//
// header   u32 magic 0x42474C57 ("WLGB")  u16 version = 1  u16 n_games
// game     u16 target  u16 replicate  u8 n_turns  u8 flags (bit 0 solved)
// turn     u16 guess  u16 pattern  u16 cands_before  u16 cands_after
//          f32 p_chosen  f32 bits_expected  u8 phase  u8 flags (bit 0 candidate)
//
// All little-endian. A buffer may hold several batches back to back (cached
// and precomputed files are concatenations of batches).

import type { Game, Turn } from './types';

export const BATCH_MAGIC = 0x42474c57;
export const BATCH_VERSION = 1;
export const HEADER_BYTES = 8;
export const GAME_BYTES = 6;
export const TURN_BYTES = 18;
const MAX_GAMES_PER_BATCH = 0xffff;

export class BatchError extends Error {}

function view(buf: ArrayBuffer | ArrayBufferView): DataView {
  if (buf instanceof ArrayBuffer) return new DataView(buf);
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Number of games in the first batch of a buffer (0 if empty or too short). */
export function batchGameCount(buf: ArrayBuffer | ArrayBufferView): number {
  const dv = view(buf);
  if (dv.byteLength < HEADER_BYTES) return 0;
  if (dv.getUint32(0, true) !== BATCH_MAGIC) throw new BatchError('not a game batch (bad magic)');
  return dv.getUint16(6, true);
}

/** Decode every batch in a buffer, appending games to `out`. */
export function decodeBatches(buf: ArrayBuffer | ArrayBufferView, out: Game[] = []): Game[] {
  const dv = view(buf);
  let o = 0;
  const end = dv.byteLength;
  while (o < end) {
    if (end - o < HEADER_BYTES) throw new BatchError(`truncated batch header at byte ${o}`);
    const magic = dv.getUint32(o, true);
    if (magic !== BATCH_MAGIC) throw new BatchError(`bad batch magic 0x${magic.toString(16)} at byte ${o}`);
    const version = dv.getUint16(o + 4, true);
    if (version !== BATCH_VERSION) throw new BatchError(`unsupported batch version ${version}`);
    const n = dv.getUint16(o + 6, true);
    o += HEADER_BYTES;
    for (let g = 0; g < n; g++) {
      if (end - o < GAME_BYTES) throw new BatchError(`truncated game at byte ${o}`);
      const target = dv.getUint16(o, true);
      const replicate = dv.getUint16(o + 2, true);
      const nTurns = dv.getUint8(o + 4);
      const flags = dv.getUint8(o + 5);
      o += GAME_BYTES;
      if (end - o < nTurns * TURN_BYTES) throw new BatchError(`truncated turns at byte ${o}`);
      const turns: Turn[] = new Array(nTurns);
      for (let t = 0; t < nTurns; t++) {
        turns[t] = {
          guess: dv.getUint16(o, true),
          pattern: dv.getUint16(o + 2, true),
          candsBefore: dv.getUint16(o + 4, true),
          candsAfter: dv.getUint16(o + 6, true),
          pChosen: dv.getFloat32(o + 8, true),
          bitsExpected: dv.getFloat32(o + 12, true),
          phase: dv.getUint8(o + 16),
          isCandidate: (dv.getUint8(o + 17) & 1) === 1,
        };
        o += TURN_BYTES;
      }
      out.push({ target, replicate, turns, solved: (flags & 1) === 1 });
    }
  }
  return out;
}

/** Decode a single worker batch (alias of decodeBatches). */
export function decodeBatch(buf: ArrayBuffer | ArrayBufferView): Game[] {
  return decodeBatches(buf);
}

/** Bytes needed to encode games (including batch headers). */
export function encodedSize(games: Game[]): number {
  let bytes = Math.ceil(games.length / MAX_GAMES_PER_BATCH) * HEADER_BYTES;
  for (const g of games) bytes += GAME_BYTES + g.turns.length * TURN_BYTES;
  return games.length === 0 ? HEADER_BYTES : bytes;
}

/** Encode games as one or more batches (at most 65,535 games each). */
export function encodeGames(games: Game[]): ArrayBuffer {
  const buf = new ArrayBuffer(encodedSize(games));
  const dv = new DataView(buf);
  let o = 0;
  let i = 0;
  do {
    const n = Math.min(MAX_GAMES_PER_BATCH, games.length - i);
    dv.setUint32(o, BATCH_MAGIC, true);
    dv.setUint16(o + 4, BATCH_VERSION, true);
    dv.setUint16(o + 6, n, true);
    o += HEADER_BYTES;
    for (let k = 0; k < n; k++, i++) {
      const g = games[i];
      if (g.turns.length > 255) throw new BatchError('too many turns');
      dv.setUint16(o, g.target, true);
      dv.setUint16(o + 2, g.replicate, true);
      dv.setUint8(o + 4, g.turns.length);
      dv.setUint8(o + 5, g.solved ? 1 : 0);
      o += GAME_BYTES;
      for (const t of g.turns) {
        dv.setUint16(o, t.guess, true);
        dv.setUint16(o + 2, t.pattern, true);
        dv.setUint16(o + 4, t.candsBefore, true);
        dv.setUint16(o + 6, t.candsAfter, true);
        dv.setFloat32(o + 8, t.pChosen, true);
        dv.setFloat32(o + 12, t.bitsExpected, true);
        dv.setUint8(o + 16, t.phase);
        dv.setUint8(o + 17, t.isCandidate ? 1 : 0);
        o += TURN_BYTES;
      }
    }
  } while (i < games.length);
  return buf;
}

/** Concatenate buffers. */
export function concatBuffers(parts: ArrayBuffer[]): ArrayBuffer {
  let n = 0;
  for (const p of parts) n += p.byteLength;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(new Uint8Array(p), o);
    o += p.byteLength;
  }
  return out.buffer;
}
