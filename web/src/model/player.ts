// Player games as Game objects (turns with candidates and expected bits), so
// they can be inserted into trees as player paths and exported.

import { PHASE_PLAYER, type Game, type Turn } from '../backend/types';
import { allCorrect, feedback } from './feedback';
import type { WordData } from './types';

/** Entropy (bits) of a guess's partition of the candidates. */
export function expectedBits(words: WordData, guess: number, candidates: number[]): number {
  if (candidates.length <= 1) return 0;
  const g = words.guesses[guess];
  const counts = new Map<number, number>();
  for (const a of candidates) {
    const p = feedback(g, words.guesses[words.answers[a]]);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const n = candidates.length;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * A player's game against `target` (answer index) from guess word ids, with
 * candidates before and after each turn recomputed from the answer list.
 * `index` becomes the game's replicate field (player game n → game_id "-p{n}").
 */
export function playerGame(words: WordData, target: number, guesses: number[], index = 0): Game {
  const targetWord = words.guesses[words.answers[target]];
  let cands: number[] = words.answers.map((_, a) => a);
  const turns: Turn[] = [];
  const win = allCorrect(words.wordLength);
  let solved = false;
  for (const guess of guesses) {
    const gw = words.guesses[guess];
    const pattern = feedback(gw, targetWord);
    const before = cands.length;
    const ansIdx = words.answerOf[guess];
    const isCandidate = ansIdx >= 0 && cands.includes(ansIdx);
    const bits = expectedBits(words, guess, cands);
    cands = cands.filter((a) => feedback(gw, words.guesses[words.answers[a]]) === pattern);
    turns.push({
      guess,
      pattern,
      candsBefore: before,
      candsAfter: cands.length,
      pChosen: NaN,
      bitsExpected: bits,
      phase: PHASE_PLAYER,
      isCandidate,
    });
    if (pattern === win) {
      solved = true;
      break;
    }
  }
  return { target, replicate: index, turns, solved, isPlayer: true };
}
