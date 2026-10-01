import { describe, expect, it } from 'vitest';
import type { Game } from '../../backend/types';
import { compileRules, parseFilter } from '../../model/filter';
import type { TargetTree, TrieNode } from '../../model/types';
import {
  draftsToText,
  draftToRule,
  draftToSlot,
  emptyDraft,
  filterReadout,
  gamesTouching,
  lettersOnly,
  ruleToDraft,
  slotLabel,
  textToDrafts,
  type RuleDraft,
} from './builder';

function compiled(text: string, opts: Parameters<typeof compileRules>[1] = {}) {
  const r = parseFilter(text, 5);
  if (!r.ok) throw new Error(r.error);
  return compileRules(r.rules, opts);
}

describe('drafts', () => {
  it('normalises letters', () => {
    expect(lettersOnly('e, A a!z')).toBe('aez');
  });

  it('round-trips text through drafts', () => {
    for (const t of ['?A??Y', '{v}{v}???', '!S????', '?A??Y +E -S', '[AE]{^c}!Q?? *', 'S???? | ????E']) {
      expect(draftsToText(textToDrafts(t, 5))).toBe(t);
    }
  });

  it('turns empty or invalid text into one blank draft', () => {
    expect(textToDrafts('', 5)).toEqual([emptyDraft(5)]);
    expect(textToDrafts('???', 5)).toEqual([emptyDraft(5)]);
    expect(emptyDraft(4).slots).toHaveLength(4);
  });

  it('drops rules that constrain nothing', () => {
    const drafts: RuleDraft[] = [emptyDraft(5), textToDrafts('????Y', 5)[0], emptyDraft(5)];
    expect(draftsToText(drafts)).toBe('????Y');
    expect(draftsToText([emptyDraft(5)])).toBe('');
  });

  it('builds slots from the builder fields', () => {
    expect(draftToSlot({ mode: 'letter', negate: false, letters: '' })).toEqual({ negate: false, value: { kind: 'any' } });
    expect(draftToSlot({ mode: 'letter', negate: true, letters: 'Q' })).toEqual({ negate: true, value: { kind: 'letter', letter: 'q' } });
    expect(draftToSlot({ mode: 'set', negate: false, letters: 'ee' })).toEqual({ negate: false, value: { kind: 'letter', letter: 'e' } });
    expect(draftToSlot({ mode: 'set', negate: true, letters: 'sae' })).toEqual({ negate: true, value: { kind: 'set', letters: 'aes' } });
    expect(draftToSlot({ mode: 'vowel', negate: true, letters: 'x' })).toEqual({ negate: true, value: { kind: 'class', class: 'vowel' } });
    expect(draftToSlot({ mode: 'any', negate: true, letters: 'x' })).toEqual({ negate: false, value: { kind: 'any' } });
  });

  it('keeps extras sorted and deduped', () => {
    const d = { ...emptyDraft(5), contains: 'se e', excludes: 'zA', repeated: true };
    expect(draftToRule(d)).toMatchObject({ contains: ['e', 's'], excludes: ['a', 'z'], repeated: true });
    const r = parseFilter('????? +S +E -Z *', 5);
    expect(r.ok && ruleToDraft(r.rules[0])).toMatchObject({ contains: 'ES', excludes: 'Z', repeated: true });
  });

  it('labels slots', () => {
    expect(slotLabel({ mode: 'any', negate: false, letters: '' })).toBe('any');
    expect(slotLabel({ mode: 'letter', negate: true, letters: 's' })).toBe('not S');
    expect(slotLabel({ mode: 'set', negate: false, letters: 'ae' })).toBe('{A,E}');
    expect(slotLabel({ mode: 'consonant', negate: false, letters: '' })).toBe('consonant');
  });
});

// A tiny tree against target "happy" (word ids index into `guesses`).
const guesses = ['crane', 'daisy', 'happy', 'nasty', 'slate'];
const HAPPY = 2;

function turn(guess: number) {
  return { guess, pattern: 0, candsBefore: 1, candsAfter: 1, pChosen: 1, bitsExpected: 0, phase: 0, isCandidate: true };
}

function game(ids: number[], solved = true, isPlayer = false): Game {
  return { target: 0, replicate: 0, turns: ids.map(turn), solved, isPlayer };
}

function buildTree(games: Game[]): TargetTree {
  const root: TrieNode = { id: 0, parent: null, depth: 0, guess: -1, pattern: 0, mass: 0, endSolved: 0, endFailed: 0, children: [], player: false, sampleGames: [], pEdge: 1 };
  const nodes = [root];
  for (const g of games) {
    if (!g.isPlayer) root.mass++;
    let n = root;
    for (const t of g.turns) {
      let c = n.children.find((x) => x.guess === t.guess);
      if (!c) {
        c = { id: nodes.length, parent: n, depth: n.depth + 1, guess: t.guess, pattern: 0, mass: 0, endSolved: 0, endFailed: 0, children: [], player: false, sampleGames: [], pEdge: 1 };
        nodes.push(c);
        n.children.push(c);
      }
      if (!g.isPlayer) c.mass++;
      n = c;
    }
  }
  return {
    target: 0,
    root,
    nodes,
    games,
    totalMass: root.mass,
    version: 1,
    ingest() {},
    addPlayer: () => root,
    pathTo: () => [],
    sortedChildren: (n) => n.children,
  };
}

describe('readout', () => {
  const games = [
    game([0, 3, HAPPY]), // crane nasty happy
    game([0, 3, HAPPY]),
    game([0, 1, HAPPY]), // crane daisy happy
    game([4, HAPPY]), // slate happy
    game([4, 1, 3, 0, 4, 1], false), // a failure
    game([1, HAPPY], true, true), // a player game: no mass
  ];
  const tree = buildTree(games);

  it('counts nodes, games touching a match and matches per row', () => {
    const f = compiled('?A??Y'); // daisy, happy, nasty
    const r = filterReadout(tree, guesses, HAPPY, f, 6);
    expect(r.totalGames).toBe(5);
    expect(r.games).toBe(5);
    expect(r.share).toBeCloseTo(1);
    // Row 1: the player's DAISY (drawn, no mass). Row 2: NASTY, DAISY ×2, HAPPY ×2.
    // Row 3: HAPPY ×2, NASTY. Row 6: DAISY at the end of the failure.
    expect(r.perRow.map((x) => x.nodes)).toEqual([1, 5, 3, 0, 0, 1]);
    expect(r.perRow.map((x) => x.games)).toEqual([0, 5, 4, 0, 0, 1]);
    expect(r.nodes).toBe(10);
  });

  it('honours the final-guess scope', () => {
    const f = compiled('?A??Y', { includeFinal: false });
    const r = filterReadout(tree, guesses, HAPPY, f, 6);
    // HAPPY nodes are final solving guesses and drop out.
    expect(r.perRow.map((x) => x.nodes)).toEqual([1, 3, 1, 0, 0, 1]);
    expect(r.games).toBe(4); // slate→happy no longer touches a match
  });

  it('honours chosen rows', () => {
    const f = compiled('{c}????', { rows: [1] });
    const r = filterReadout(tree, guesses, HAPPY, f, 6);
    expect(r.nodes).toBe(3); // CRANE, SLATE and the player's DAISY at guess 1
    expect(r.games).toBe(5);
    expect(r.perRow[0]).toEqual({ row: 1, nodes: 3, games: 5 });
    expect(r.perRow[1].nodes).toBe(0);
  });

  it('counts games touching a match, skipping player games', () => {
    const f = compiled('S????');
    expect(gamesTouching(games, guesses, f)).toEqual({ touching: 2, total: 5 });
  });
});
