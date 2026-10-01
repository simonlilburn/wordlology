import { describe, expect, it } from 'vitest';
import { DEFAULT_DISPLAY, DEFAULT_RESULT } from '../../app/store.svelte';
import {
  GROUPS,
  SETTINGS,
  answerSummary,
  checkPastedWords,
  clampCutoff,
  cutoffRange,
  exportWarnText,
  listSome,
  optionIndex,
  pastedMessage,
  settingsIn,
  splitWords,
} from './settings';
import { extraShortcuts, keyName, SPEC_SHORTCUTS } from './help';

const lexicon = (words: string[]) => ({ wordLength: 5, index: new Map(words.map((w, i) => [w, i])) });

describe('the settings table', () => {
  it('has a row for every result and display setting, once', () => {
    const result = SETTINGS.filter((s) => s.kind === 'result').map((s) => s.key);
    const display = SETTINGS.filter((s) => s.kind === 'display').map((s) => s.key);
    expect(new Set(result).size).toBe(result.length);
    expect(new Set(display).size).toBe(display.length);
    expect([...result].sort()).toEqual(Object.keys(DEFAULT_RESULT).sort());
    expect([...display].sort()).toEqual(Object.keys(DEFAULT_DISPLAY).sort());
  });

  it('matches the specification: 26 rows in seven groups', () => {
    expect(SETTINGS).toHaveLength(26);
    expect(GROUPS.map((g) => settingsIn(g).length)).toEqual([6, 6, 4, 2, 2, 4, 2]);
  });

  it('offers each default among its options', () => {
    for (const s of SETTINGS) {
      const def = (s.kind === 'result' ? DEFAULT_RESULT : DEFAULT_DISPLAY) as unknown as Record<string, unknown>;
      const v = def[s.key];
      const c = s.control;
      if (c.type === 'choice' || c.type === 'select') expect(optionIndex(c.options, v), s.label).toBeGreaterThanOrEqual(0);
      if (c.type === 'toggle') expect(typeof v, s.label).toBe('boolean');
      if (c.type === 'range') {
        expect(v as number, s.label).toBeGreaterThanOrEqual(c.min);
        expect(v as number, s.label).toBeLessThanOrEqual(c.max);
        expect(((v as number) - c.min) % c.step, s.label).toBe(0);
      }
    }
  });

  it('spec ranges: max guesses 4 to 10, replicates 50/200/1,000 and 5 to 100, labels 8 to 16 px, kept 5 to 50', () => {
    const find = (k: string) => SETTINGS.find((s) => s.key === k)!.control;
    const mg = find('maxGuesses');
    expect(mg.type === 'select' && mg.options.map((o) => o.value)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    const rt = find('replicatesTree');
    expect(rt.type === 'choice' && rt.options.map((o) => o.value)).toEqual([50, 200, 1000]);
    expect(find('replicatesCard')).toMatchObject({ type: 'range', min: 5, max: 100 });
    expect(find('labelThreshold')).toMatchObject({ type: 'range', min: 8, max: 16 });
    expect(find('rankKeep')).toMatchObject({ type: 'range', min: 5, max: 50 });
    const cf = find('counterfactualBranches');
    expect(cf.type === 'select' && cf.options.map((o) => o.value)).toEqual([0, 2, 3, 4, 5]);
  });
});

describe('answer lists', () => {
  it('the cutoff runs from 1,000 to the ranked list length', () => {
    expect(cutoffRange(3416)).toEqual({ min: 1000, max: 3416 });
    expect(cutoffRange(null)).toEqual({ min: 1000, max: 3416 });
    expect(cutoffRange(800)).toEqual({ min: 800, max: 800 });
    const r = cutoffRange(3416);
    expect(clampCutoff(12, r)).toBe(1000);
    expect(clampCutoff(99999, r)).toBe(3416);
    expect(clampCutoff(2750.4, r)).toBe(2750);
    expect(clampCutoff(Number.NaN, r)).toBe(2500);
  });

  it('summaries', () => {
    expect(answerSummary({ kind: 'default' })).toBe('2,500 most frequent words');
    expect(answerSummary({ kind: 'top', n: 3000 })).toBe('3,000 most frequent words');
    expect(answerSummary({ kind: 'pasted', words: ['crane'] })).toBe('A pasted list of 1 word');
  });

  it('pasted lists are split on spaces, commas, semicolons and new lines', () => {
    expect(splitWords(' crane, slate;\nTRACE\t\n')).toEqual(['crane', 'slate', 'TRACE']);
    expect(splitWords('   ')).toEqual([]);
  });

  it('pasted lists are validated against the guess list', () => {
    const c = checkPastedWords('slate CRANE crane zzzzz cat trace1 trace', lexicon(['crane', 'slate', 'trace']));
    expect(c.words).toEqual(['crane', 'slate', 'trace']);
    expect(c.unknown).toEqual(['zzzzz']);
    expect(c.malformed).toEqual(['cat', 'trace1']);
    expect(c.duplicates).toBe(1);
    expect(pastedMessage(c, 5)).toBe('3 words in the guess list, 1 not in the guess list, 2 not 5-letter words, 1 repeated');
  });

  it('lists a few rejected words', () => {
    expect(listSome(['abcde', 'fghij'])).toBe('ABCDE, FGHIJ');
    expect(listSome(['a', 'b', 'c'], 2)).toBe('A, B and 1 more');
  });
});

describe('export warning', () => {
  it('describes thresholds', () => {
    expect(exportWarnText(1_000_000)).toBe('1 million rows');
    expect(exportWarnText(250_000)).toBe('250,000 rows');
    expect(exportWarnText(0)).toBe('Never warn');
  });
});

describe('help', () => {
  it('names keys as shown on a keyboard', () => {
    expect(keyName('ArrowLeft')).toBe('←');
    expect(keyName('Escape')).toBe('Esc');
    expect(keyName('f')).toBe('F');
    expect(keyName('-')).toBe('−');
    expect(keyName('Tab')).toBe('Tab');
  });

  it('lists the specification table', () => {
    const keys = SPEC_SHORTCUTS.flatMap((r) => r.keys);
    for (const k of ['←', '→', '−', '=', ',', '.', '/', 'F', 'S', 'O', 'E', '?']) expect(keys).toContain(k);
  });

  it('adds only registered shortcuts the table does not cover', () => {
    const extra = extraShortcuts([
      { keys: ['f', 'F'], description: 'Letter filter' },
      { keys: ['ArrowLeft'], description: 'Replay: previous turn' },
      { keys: ['-', '_'], description: 'Zoom out' },
      { keys: ['l', 'L'], description: 'Strategy Lab' },
      { keys: ['l'], description: 'Strategy Lab' },
    ]);
    expect(extra).toEqual([{ keys: ['L'], action: 'Strategy Lab' }]);
  });
});
