import { describe, expect, it } from 'vitest';
import type { Game } from '../backend/types';
import { SAMPLE_GAMES_CAP, TargetTrie } from './trie';

function game(guesses: number[], solved: boolean, opts: { player?: boolean; target?: number; p?: number } = {}): Game {
  return {
    target: opts.target ?? 7,
    replicate: 0,
    solved,
    isPlayer: opts.player,
    turns: guesses.map((g) => ({ guess: g, pattern: g % 243, candsBefore: 10, candsAfter: 5, pChosen: opts.p ?? 0.5, bitsExpected: 1, phase: 0, isCandidate: true })),
  };
}

describe('TargetTrie', () => {
  it('builds a prefix trie with masses and ends', () => {
    const t = new TargetTrie(7, 6);
    t.ingest([game([1, 2, 7], true), game([1, 3, 7], true), game([1, 2, 7], true), game([4, 5, 6, 8, 9, 10], false)]);
    expect(t.totalMass).toBe(4);
    expect(t.root.mass).toBe(4);
    const guesses = t.nodes.map((n) => n.guess);
    expect(guesses).toEqual([-1, 1, 2, 7, 3, 7, 4, 5, 6, 8, 9, 10]);
    const n127 = t.find([1, 2, 7])!;
    expect(n127.mass).toBe(2);
    expect(n127.endSolved).toBe(2);
    expect(n127.depth).toBe(3);
    const fail = t.find([4, 5, 6, 8, 9, 10])!;
    expect(fail.endFailed).toBe(1);
    expect(t.isTerminal(fail)).toBe(true);
    expect(t.isTerminal(t.find([1])!)).toBe(false);
    expect(t.breadth()).toBe(3);
    expect(t.pathTo(n127).map((n) => n.guess)).toEqual([1, 2, 7]);
    expect(t.guessesTo(n127)).toEqual([1, 2, 7]);
    expect(t.find([9])).toBeNull();
  });

  it('sorts children by mass, then word id', () => {
    const t = new TargetTrie(7, 6);
    t.ingest([game([5, 7], true), game([3, 7], true), game([9, 7], true), game([9, 7], true)]);
    expect(t.sortedChildren(t.root).map((n) => n.guess)).toEqual([9, 3, 5]);
    // The cached order refreshes when the trie changes.
    t.ingest([game([3, 7], true), game([3, 7], true)]);
    expect(t.sortedChildren(t.root).map((n) => n.guess)).toEqual([3, 9, 5]);
  });

  it('inserts player paths with no mass', () => {
    const t = new TargetTrie(7, 6);
    t.ingest([game([1, 7], true)]);
    const v0 = t.version;
    const leaf = t.addPlayer(game([1, 2, 7], true, { player: true }));
    expect(t.version).toBeGreaterThan(v0);
    expect(leaf.player).toBe(true);
    expect(leaf.mass).toBe(0);
    expect(t.find([1])!.player).toBe(true);
    expect(t.find([1])!.mass).toBe(1);
    expect(t.totalMass).toBe(1);
    // Player games in a batch are routed to addPlayer; duplicates are kept once.
    t.ingest([game([1, 2, 7], true, { player: true })]);
    expect(t.games.filter((g) => g.isPlayer)).toHaveLength(1);
    expect(t.playerCount).toBe(1);
  });

  it('skips other targets, averages edge probabilities and caps sample games', () => {
    const t = new TargetTrie(7, 6);
    t.ingest([game([1, 7], true, { target: 8 })]);
    expect(t.totalMass).toBe(0);
    t.ingest([game([1, 7], true, { p: 0.25 }), game([1, 7], true, { p: 0.75 })]);
    expect(t.find([1])!.pEdge).toBeCloseTo(0.5, 12);
    t.ingest(Array.from({ length: 40 }, () => game([1, 7], true)));
    expect(t.find([1, 7])!.sampleGames).toHaveLength(SAMPLE_GAMES_CAP);
    expect(t.find([1, 7])!.sampleGames[0]).toBe(0);
  });

  it('indexes wide fan-outs', () => {
    const t = new TargetTrie(7, 6);
    t.ingest(Array.from({ length: 50 }, (_, i) => game([100 + i, 7], true)));
    expect(t.root.children).toHaveLength(50);
    expect(t.find([149, 7])!.mass).toBe(1);
    t.ingest([game([149, 7], true)]);
    expect(t.root.children).toHaveLength(50);
    expect(t.find([149])!.mass).toBe(2);
  });
});
