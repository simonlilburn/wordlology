import { describe, expect, it } from 'vitest';
import vectors from '../../../../data/testvectors/feedback.json';
import { feedback } from '../../model/feedback';
import {
  checkGuess,
  decodePattern,
  endMessage,
  handleKey,
  hardModeViolation,
  keyFromEvent,
  keyLabel,
  keyStates,
  rowAnnouncement,
  solvedCode,
  statusAfter,
  tileLabel,
  type InputContext,
  type KeyInput,
  type Lexicon,
  type Row,
} from './logic';

const WORDS = ['crane', 'crate', 'trace', 'slate', 'caret', 'react', 'speed', 'erase', 'reset', 'geese', 'abide', 'eerie'];
const lexicon: Lexicon = { wordLength: 5, index: new Map(WORDS.map((w, i) => [w, i])) };
const row = (word: string, target: string): Row => ({ word, pattern: feedback(word, target) });

function ctx(over: Partial<InputContext> = {}): InputContext {
  return { lexicon, hardMode: false, history: [], blocked: null, ...over };
}

/** Feed a sequence of keys through the state machine. */
function type(keys: string, c = ctx()): { input: string; effects: string[] } {
  let input = '';
  const effects: string[] = [];
  for (const k of keys.split(' ')) {
    const key: KeyInput = k === '⏎' ? { kind: 'enter' } : k === '⌫' ? { kind: 'backspace' } : { kind: 'letter', letter: k };
    const r = handleKey(input, key, c);
    input = r.input;
    effects.push(r.effect.kind);
  }
  return { input, effects };
}

describe('decodePattern', () => {
  it('matches the shared feedback test vectors', () => {
    for (const v of vectors.cases) {
      const cells = decodePattern(v.code, v.guess.length);
      expect(cells.map((c) => 'byg'[c]).join('')).toBe(v.letters);
    }
  });
  it('all-correct code', () => {
    expect(decodePattern(solvedCode(5), 5)).toEqual([2, 2, 2, 2, 2]);
    expect(solvedCode(5)).toBe(242);
  });
});

describe('keyFromEvent', () => {
  it('maps letters, Enter and Backspace', () => {
    expect(keyFromEvent('a')).toEqual({ kind: 'letter', letter: 'a' });
    expect(keyFromEvent('Q')).toEqual({ kind: 'letter', letter: 'q' });
    expect(keyFromEvent('Enter')).toEqual({ kind: 'enter' });
    expect(keyFromEvent('Backspace')).toEqual({ kind: 'backspace' });
  });
  it('ignores everything else', () => {
    for (const k of ['Shift', '1', ' ', 'é', 'ArrowLeft', 'Escape', '?', '-', 'Tab']) expect(keyFromEvent(k)).toBeNull();
  });
});

describe('handleKey (input state machine)', () => {
  it('types up to the word length and ignores extra letters', () => {
    const r = type('c r a n e s');
    expect(r.input).toBe('crane');
    expect(r.effects).toEqual(['edit', 'edit', 'edit', 'edit', 'edit', 'edit']);
  });
  it('backspace deletes, and is harmless on an empty row', () => {
    expect(type('c r ⌫').input).toBe('c');
    expect(type('⌫ ⌫').input).toBe('');
  });
  it('Enter on an empty row is reported (replay plays Next)', () => {
    expect(type('⏎').effects).toEqual(['empty-enter']);
  });
  it('Enter on a short word is invalid and keeps the letters', () => {
    const r = handleKey('cra', { kind: 'enter' }, ctx());
    expect(r.input).toBe('cra');
    expect(r.effect).toEqual({ kind: 'invalid', reason: 'short', message: 'Not enough letters' });
  });
  it('Enter on an unknown word is invalid with a message', () => {
    const r = handleKey('zzzzz', { kind: 'enter' }, ctx());
    expect(r.input).toBe('zzzzz');
    expect(r.effect.kind).toBe('invalid');
    if (r.effect.kind === 'invalid') {
      expect(r.effect.reason).toBe('unknown');
      expect(r.effect.message).toBe('ZZZZZ is not in the word list');
    }
  });
  it('Enter on a valid word submits it and clears the row', () => {
    const r = handleKey('slate', { kind: 'enter' }, ctx());
    expect(r.input).toBe('');
    expect(r.effect).toEqual({ kind: 'submit', word: 'slate', id: WORDS.indexOf('slate') });
  });
  it('a blocked board ignores keys and says why', () => {
    const c = ctx({ blocked: 'This game is over: start a new game' });
    const r = handleKey('', { kind: 'letter', letter: 'a' }, c);
    expect(r.input).toBe('');
    expect(r.effect).toEqual({ kind: 'blocked', message: 'This game is over: start a new game' });
  });
  it('hard mode rejects a guess that ignores a hint', () => {
    const history = [row('trace', 'crate')];
    const r = handleKey('slate', { kind: 'enter' }, ctx({ hardMode: true, history }));
    expect(r.effect.kind).toBe('invalid');
    if (r.effect.kind === 'invalid') {
      expect(r.effect.reason).toBe('hard');
      expect(r.effect.message).toBe('Hard mode: 2nd letter must be R');
    }
    expect(handleKey('crate', { kind: 'enter' }, ctx({ hardMode: true, history })).effect.kind).toBe('submit');
    // Without hard mode the same guess is fine.
    expect(handleKey('slate', { kind: 'enter' }, ctx({ history })).effect.kind).toBe('submit');
  });
});

describe('hardModeViolation (mirrors wl_core::hard)', () => {
  it('accepts guesses that use every hint', () => {
    expect(hardModeViolation('crate', [row('trace', 'crate')])).toBeNull();
    expect(hardModeViolation('slate', [])).toBeNull();
  });
  it('explains a misplaced correct letter first', () => {
    expect(hardModeViolation('caret', [row('trace', 'crate')])).toBe('2nd letter must be R');
    expect(hardModeViolation('react', [row('crane', 'crate')])).toBe('1st letter must be C');
  });
  it('explains a missing present letter', () => {
    // TRACE vs REACT: T and R present, A and C correct, E present.
    const h = [row('trace', 'react')];
    expect(decodePattern(h[0].pattern, 5)).toEqual([1, 1, 2, 2, 1]);
    expect(hardModeViolation('slate', h)).toBe('4th letter must be C');
    // SPEED vs ABIDE: E and D present.
    expect(hardModeViolation('caret', [row('speed', 'abide')])).toBe('guess must contain D');
    expect(hardModeViolation('bread', [row('speed', 'abide')])).toBeNull();
  });
  it('counts repeated letters', () => {
    // SPEED vs ERASE: S present, both Es present.
    const h = [row('speed', 'erase')];
    expect(h[0].pattern).toBe(37);
    expect(hardModeViolation('crane', h)).toBe('guess must contain S');
    expect(hardModeViolation('reset', h)).toBeNull();
    expect(hardModeViolation('slate', h)).toBe('guess must contain 2 Es');
  });
  it('agrees with the Rust rule on every word pair of a small list', () => {
    // Property: the target itself never violates hard mode against its own feedback history.
    for (const target of WORDS) {
      const history = WORDS.slice(0, 3).map((w) => row(w, target));
      expect(hardModeViolation(target, history)).toBeNull();
    }
  });
});

describe('checkGuess', () => {
  it('is case-insensitive', () => {
    expect(checkGuess('CRANE', { lexicon, hardMode: false, history: [] })).toEqual({ ok: true, word: 'crane', id: 0 });
  });
});

describe('keyStates', () => {
  it('keeps the best state per letter', () => {
    // CRATE vs TRACE: C present, R correct, A correct, T present, E correct.
    const states = keyStates([row('slate', 'trace'), row('crate', 'trace')]);
    expect(states.get('s')).toBe(0);
    expect(states.get('l')).toBe(0);
    expect(states.get('a')).toBe(2);
    expect(states.get('t')).toBe(1); // present in both rows
    expect(states.get('c')).toBe(1);
    expect(states.get('r')).toBe(2);
    expect(states.get('e')).toBe(2);
    expect(states.has('z')).toBe(false);
  });
  it('a later correct upgrades an earlier present', () => {
    const states = keyStates([row('trace', 'crate'), row('crate', 'crate')]);
    expect(states.get('t')).toBe(2);
    expect(states.get('c')).toBe(2);
  });
});

describe('text', () => {
  it('tile and key labels', () => {
    expect(tileLabel('s', 2)).toBe('S, correct');
    expect(tileLabel('s', 1)).toBe('S, present');
    expect(tileLabel('s', 0)).toBe('S, absent');
    expect(tileLabel('s', null)).toBe('S');
    expect(tileLabel('', null)).toBe('empty');
    expect(keyLabel('a', undefined)).toBe('A');
    expect(keyLabel('a', 2)).toBe('A, correct');
  });
  it('row announcement', () => {
    expect(rowAnnouncement(1, row('speed', 'abide'))).toBe(
      'Guess 1, SPEED: S absent, P absent, E present, E absent, D present.',
    );
  });
  it('end messages', () => {
    expect(endMessage(true, 1, 'crane')).toBe('Unbelievable! Solved in 1 guess.');
    expect(endMessage(true, 4, 'crane')).toBe('Nicely done! Solved in 4 guesses.');
    expect(endMessage(true, 9, 'crane')).toMatch(/Solved in 9 guesses/);
    expect(endMessage(false, 6, 'crane')).toBe('Out of guesses. The word was CRANE.');
  });
  it('status after a guess', () => {
    expect(statusAfter(242, 3, 5, 6)).toBe('won');
    expect(statusAfter(242, 6, 5, 6)).toBe('won');
    expect(statusAfter(10, 6, 5, 6)).toBe('lost');
    expect(statusAfter(10, 5, 5, 6)).toBe('playing');
  });
});
