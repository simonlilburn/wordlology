import { describe, expect, it } from 'vitest';
import {
  clampCursor,
  drawReplicate,
  endedAt,
  nextAction,
  openPath,
  phaseLabel,
  playAtCursor,
  scrubTo,
  startsNewBranch,
  stepCursor,
  type TurnMeta,
} from './replay';

const SOLVED = 242;
const MAX = 6;
const player: TurnMeta = { source: 'player', pChosen: null, phase: 'player' };
const strat: TurnMeta = { source: 'strategy', pChosen: 0.25, phase: 'explore' };

// A solved four-guess path: word ids 10, 20, 30, 40, the last one correct.
const solvedPath = () => openPath([10, 20, 30, 40], [5, 17, 80, SOLVED]);

describe('cursor', () => {
  it('opens at the end of the path', () => {
    const p = solvedPath();
    expect(p.cursor).toBe(4);
    expect(p.branchAt).toBe(-1);
    expect(p.meta).toHaveLength(4);
    expect(p.meta.every((m) => m.source === 'path')).toBe(true);
  });
  it('clamps to 0..n', () => {
    expect(clampCursor(-3, 4)).toBe(0);
    expect(clampCursor(9, 4)).toBe(4);
    expect(clampCursor(2.4, 4)).toBe(2);
    expect(clampCursor(NaN, 4)).toBe(4);
  });
  it('scrubs and steps within bounds', () => {
    let p = solvedPath();
    p = stepCursor(p, 1);
    expect(p.cursor).toBe(4);
    p = stepCursor(p, -1);
    expect(p.cursor).toBe(3);
    p = scrubTo(p, 0);
    expect(p.cursor).toBe(0);
    p = stepCursor(p, -1);
    expect(p.cursor).toBe(0);
  });
  it('ignores mismatched pattern arrays', () => {
    const p = openPath([1, 2, 3], [0, 0]);
    expect(p.guesses).toEqual([1, 2]);
    expect(p.cursor).toBe(2);
  });
});

describe('endedAt', () => {
  it('won after the solving row, open before it', () => {
    const p = solvedPath();
    expect(endedAt(p, 4, SOLVED, MAX)).toBe('won');
    expect(endedAt(p, 3, SOLVED, MAX)).toBeNull();
    expect(endedAt(p, 0, SOLVED, MAX)).toBeNull();
  });
  it('lost at max guesses', () => {
    const p = openPath([1, 2, 3, 4, 5, 6], [0, 0, 0, 0, 0, 0]);
    expect(endedAt(p, 6, SOLVED, MAX)).toBe('lost');
    expect(endedAt(p, 5, SOLVED, MAX)).toBeNull();
  });
});

describe('playAtCursor (branching)', () => {
  it("the path's own next guess just advances the cursor", () => {
    const p = scrubTo(solvedPath(), 1);
    expect(startsNewBranch(p, 20)).toBe(false);
    const q = playAtCursor(p, 20, 17, player);
    expect(q.cursor).toBe(2);
    expect(q.guesses).toEqual([10, 20, 30, 40]);
    expect(q.branchAt).toBe(-1);
  });
  it('a different guess cuts the path and starts a branch', () => {
    const p = scrubTo(solvedPath(), 2);
    expect(startsNewBranch(p, 99)).toBe(true);
    const q = playAtCursor(p, 99, 3, player);
    expect(q.guesses).toEqual([10, 20, 99]);
    expect(q.patterns).toEqual([5, 17, 3]);
    expect(q.meta.map((m) => m.source)).toEqual(['path', 'path', 'player']);
    expect(q.cursor).toBe(3);
    expect(q.branchAt).toBe(2);
  });
  it('continuing a branch keeps its branch point', () => {
    let p = playAtCursor(scrubTo(solvedPath(), 1), 99, 3, player);
    expect(p.branchAt).toBe(1);
    expect(startsNewBranch(p, 77)).toBe(false);
    p = playAtCursor(p, 77, 8, strat);
    expect(p.guesses).toEqual([10, 99, 77]);
    expect(p.branchAt).toBe(1);
    expect(p.meta[2]).toEqual(strat);
  });
  it('branching again before the branch point moves it', () => {
    let p = playAtCursor(scrubTo(solvedPath(), 2), 99, 3, player);
    p = scrubTo(p, 1);
    expect(startsNewBranch(p, 55)).toBe(true);
    p = playAtCursor(p, 55, 4, player);
    expect(p.guesses).toEqual([10, 55]);
    expect(p.branchAt).toBe(1);
  });
  it('branching from the start replaces the opener', () => {
    const p = playAtCursor(scrubTo(solvedPath(), 0), 99, 3, player);
    expect(p.guesses).toEqual([99]);
    expect(p.branchAt).toBe(0);
    expect(p.cursor).toBe(1);
  });
});

describe('nextAction', () => {
  it("advances along the path's own guesses", () => {
    expect(nextAction(scrubTo(solvedPath(), 2), SOLVED, MAX)).toEqual({ kind: 'advance' });
  });
  it('draws from the strategy past the end of an unfinished path', () => {
    const p = playAtCursor(scrubTo(solvedPath(), 2), 99, 3, player);
    expect(nextAction(p, SOLVED, MAX)).toEqual({ kind: 'draw', history: [10, 20, 99] });
  });
  it('does nothing once the game is over', () => {
    expect(nextAction(solvedPath(), SOLVED, MAX).kind).toBe('none');
    const lost = openPath([1, 2, 3, 4, 5, 6], [0, 0, 0, 0, 0, 0]);
    expect(nextAction(lost, SOLVED, MAX).kind).toBe('none');
    expect(nextAction(scrubTo(lost, 5), SOLVED, MAX)).toEqual({ kind: 'advance' });
  });
});

describe('drawReplicate', () => {
  it('lies beyond R and differs per branch', () => {
    expect(drawReplicate(200, 0)).toBe(200);
    expect(drawReplicate(200, 3)).toBe(203);
    expect(drawReplicate(1, 0)).toBe(1);
    expect(drawReplicate(0, 0)).toBe(1);
  });
});

describe('phaseLabel', () => {
  it('names openers, players and strategy phases', () => {
    expect(phaseLabel(255, [])).toBe('opener');
    expect(phaseLabel(254, null)).toBe('player');
    expect(phaseLabel(1, ['coverage', 'max info'])).toBe('max info');
    expect(phaseLabel(4, ['coverage'])).toBe('phase 4');
    expect(phaseLabel(0, undefined)).toBeNull();
  });
});
