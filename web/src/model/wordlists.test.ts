import { fs } from './testing';
const readFileSync = fs.readFileSync;
import { describe, expect, it } from 'vitest';
import type { WordListManifest } from '../backend/types';
import { answersSha256, normaliseWords, sha256Hex } from './sha256';
import {
  answerIndexOf,
  answerWord,
  buildWordData,
  LoadedWordData,
  parseWordLines,
  selectAnswers,
  selectionKey,
  targetWeights,
  WordListError,
  wordDataKey,
  type WordListFiles,
} from './wordlists';

const manifest = (len = 5): WordListManifest => ({
  id: 't',
  name: 'test',
  version: '1',
  word_length: len,
  answers: 'answers.txt',
  answers_ranked: 'answers-ranked.txt',
  guesses: 'guesses.txt',
  licence: '',
  credits: [],
  counts: {},
  sha256: {},
});

function files(over: Partial<WordListFiles> = {}): WordListFiles {
  return {
    manifest: manifest(),
    guesses: 'about\nabove\ncrane\n# comment\n\nslate\nzesty\n',
    answers: 'about\ncrane\nzesty\n',
    ranked: 'zesty\ncrane\nabout\nslate\n',
    frequencies: 'about\t5.5\ncrane\t3.25\nzesty\t2\nslate\t4\n',
    ...over,
  };
}

describe('word lists', () => {
  it('parses lines like the Rust loader', () => {
    expect(parseWordLines(' About \r\n#x\n\nCRANE\n')).toEqual(['about', 'crane']);
  });

  it('builds word data with ids, answers and frequencies', () => {
    const w = buildWordData(files());
    expect(w).toBeInstanceOf(LoadedWordData);
    expect(w.guesses).toEqual(['about', 'above', 'crane', 'slate', 'zesty']);
    expect(w.answers).toEqual([0, 2, 4]);
    expect(Array.from(w.answerOf)).toEqual([0, -1, 1, -1, 2]);
    expect(w.index.get('slate')).toBe(3);
    expect(Array.from(w.zipf!)).toEqual([5.5, 0, 3.25, 4, 2]);
    expect(w.ranked).toEqual(['zesty', 'crane', 'about', 'slate']);
    expect(answerWord(w, 1)).toBe('crane');
    expect(answerIndexOf(w, 'ZESTY')).toBe(2);
    expect(answerIndexOf(w, 'slate')).toBe(-1);
    expect(wordDataKey(w)).toBe('t@1/default');
    expect(w.texts.answers).toBe(files().answers);
  });

  it('validates like wl_core::words', () => {
    const bad = (over: Partial<WordListFiles>) => () => buildWordData(files(over));
    expect(bad({ manifest: manifest(3) })).toThrow(WordListError);
    expect(bad({ manifest: manifest(8) })).toThrow(/outside/);
    expect(bad({ guesses: 'about\nabou\n', answers: 'about\n' })).toThrow(/letters/);
    expect(bad({ guesses: 'about\nab-ut\n', answers: 'about\n' })).toThrow(/characters/);
    expect(bad({ guesses: 'about\nabout\n', answers: 'about\n' })).toThrow(/duplicate/);
    expect(bad({ answers: 'about\nabout\n' })).toThrow(/duplicate/);
    expect(bad({ answers: 'about\nquery\n' })).toThrow(/not in the guess list/);
    expect(bad({ answers: '# none\n' })).toThrow(/empty/);
    expect(bad({ frequencies: 'about 5.5\n' })).toThrow(/frequency/);
    expect(bad({ frequencies: 'about\tx\n' })).toThrow(/frequency/);
  });

  it('selects answers: default, a frequency cutoff re-sorted, or a pasted list', () => {
    const f = files();
    expect(selectAnswers(f, { kind: 'default' })).toEqual(['about', 'crane', 'zesty']);
    expect(selectAnswers(f, { kind: 'top', n: 2 })).toEqual(['crane', 'zesty']);
    expect(selectAnswers(f, { kind: 'top', n: 99 })).toEqual(['about', 'crane', 'slate', 'zesty']);
    expect(() => selectAnswers({ ...f, ranked: null }, { kind: 'top', n: 2 })).toThrow(/ranked/);
    const top = buildWordData(f, { kind: 'top', n: 2 });
    expect(top.answers.map((id) => top.guesses[id])).toEqual(['crane', 'zesty']);
    expect(top.texts.answers).toBe('crane\nzesty\n');
    expect(wordDataKey(top)).toBe('t@1/top2');
    const pasted = buildWordData(f, { kind: 'pasted', sha256: '', words: ['Slate', ' about', 'slate'] });
    expect(pasted.answers.map((id) => pasted.guesses[id])).toEqual(['about', 'slate']);
    expect(pasted.selection).toEqual({ kind: 'pasted', sha256: answersSha256(['about', 'slate']), words: ['about', 'slate'] });
    expect(selectionKey(pasted.selection)).toBe(`pasted-${answersSha256(['about', 'slate']).slice(0, 16)}`);
  });

  it('weights targets by frequency share', () => {
    const w = buildWordData(files());
    expect(targetWeights(w, 'equal')).toBeNull();
    const fw = targetWeights(w, 'frequency')!;
    const raw = [10 ** 5.5, 10 ** 3.25, 10 ** 2];
    const total = raw.reduce((a, b) => a + b, 0);
    raw.forEach((r, i) => expect(fw[i]).toBeCloseTo(r / total, 12));
  });

  it('loads the shipped default list', () => {
    const dir = new URL('../../../data/wordlists/open-en-5/', import.meta.url);
    const m = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8')) as WordListManifest;
    const read = (n: string) => readFileSync(new URL(n, dir), 'utf8');
    const w = buildWordData({ manifest: m, guesses: read(m.guesses), answers: read(m.answers), ranked: read(m.answers_ranked!), frequencies: read(m.frequencies!) });
    expect(w.guesses).toHaveLength(m.counts.guesses);
    expect(w.answers).toHaveLength(m.counts.answers);
    expect(w.ranked).toHaveLength(m.counts.answers_ranked);
    expect(sha256Hex(read(m.guesses))).toBe(m.sha256['guesses.txt']);
    const top = buildWordData({ manifest: m, guesses: read(m.guesses), answers: read(m.answers), ranked: read(m.answers_ranked!), frequencies: null }, { kind: 'top', n: 3000 });
    expect(top.answers).toHaveLength(3000);
  });
});

describe('sha256', () => {
  it('hashes like FIPS 180-4', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('a'.repeat(1000))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
  });

  it('normalises pasted words before hashing', () => {
    expect(normaliseWords([' Crane', 'about', 'crane', ''])).toEqual(['about', 'crane']);
    expect(answersSha256(['crane', 'about'])).toBe(sha256Hex('about\ncrane'));
  });
});
