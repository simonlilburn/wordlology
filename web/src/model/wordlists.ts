// Loading word lists on the main thread. Owned by the platform agent.
//
// A word list is a directory under /wordlists/<id>/ with manifest.json and
// plain files (docs/architecture.md, "Word lists"). Validation mirrors the
// Rust loader (wl_core::words): word length 4 to 7, every word the stated
// length, only a-z, no duplicates, answers a subset of guesses, at least one
// answer.

import type { AnswerSelection, WordListManifest } from '../backend/types';
import { answersSha256, normaliseWords } from './sha256';
import type { WordData } from './types';

export const DEFAULT_LIST_ID = 'open-en-5';

export class WordListError extends Error {}

/** Raw files of a list, as served. */
export interface WordListFiles {
  manifest: WordListManifest;
  guesses: string;
  answers: string;
  ranked: string | null;
  frequencies: string | null;
}

/** Words of a file: trimmed lines, blank and '#' lines skipped, lowercased (as wl_core::words::parse_words). */
export function parseWordLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    out.push(l.toLowerCase());
  }
  return out;
}

function checkWord(w: string, len: number): void {
  if (w.length !== len) throw new WordListError(`word "${w}" has ${w.length} letters, expected ${len}`);
  if (!/^[a-z]+$/.test(w)) throw new WordListError(`word "${w}" contains characters other than a to z`);
}

/** A stable key for an answer selection, used in worker load keys and caches. */
export function selectionKey(sel: AnswerSelection): string {
  switch (sel.kind) {
    case 'default':
      return 'default';
    case 'top':
      return `top${sel.n}`;
    case 'pasted':
      return `pasted-${(sel.sha256 || answersSha256(sel.words)).slice(0, 16)}`;
  }
}

/** Worker load key: list id + answer selection. */
export function wordDataKey(words: Pick<WordData, 'manifest' | 'selection'>): string {
  return `${words.manifest.id}@${words.manifest.version}/${selectionKey(words.selection)}`;
}

/** The answer words (sorted) for a selection. */
export function selectAnswers(files: WordListFiles, sel: AnswerSelection): string[] {
  switch (sel.kind) {
    case 'default':
      return parseWordLines(files.answers);
    case 'top': {
      if (!files.ranked) throw new WordListError(`word list ${files.manifest.id} has no ranked answers for a frequency cutoff`);
      const ranked = parseWordLines(files.ranked);
      if (!Number.isInteger(sel.n) || sel.n < 1) throw new WordListError(`answer cutoff ${sel.n} must be a positive integer`);
      return ranked.slice(0, Math.min(sel.n, ranked.length)).sort();
    }
    case 'pasted':
      return normaliseWords(sel.words);
  }
}

/** Build and validate word data from file texts (no network). */
export function buildWordData(files: WordListFiles, selection: AnswerSelection = { kind: 'default' }): WordData {
  const m = files.manifest;
  const len = m.word_length;
  if (!Number.isInteger(len) || len < 4 || len > 7) throw new WordListError(`word length ${len} is outside the supported range 4 to 7`);
  const guesses = parseWordLines(files.guesses);
  if (guesses.length >= 0xffff) throw new WordListError(`too many words (${guesses.length}); at most 65,534 are supported`);
  const index = new Map<string, number>();
  for (let i = 0; i < guesses.length; i++) {
    const w = guesses[i];
    checkWord(w, len);
    if (index.has(w)) throw new WordListError(`duplicate word "${w}"`);
    index.set(w, i);
  }
  const answerWords = selectAnswers(files, selection);
  const answerOf = new Int32Array(guesses.length).fill(-1);
  const answers: number[] = [];
  for (const a of answerWords) {
    const id = index.get(a);
    if (id === undefined) {
      if (a.length !== len) throw new WordListError(`word "${a}" has ${a.length} letters, expected ${len}`);
      throw new WordListError(`answer "${a}" is not in the guess list`);
    }
    if (answerOf[id] !== -1) throw new WordListError(`duplicate word "${a}"`);
    answerOf[id] = answers.length;
    answers.push(id);
  }
  if (answers.length === 0) throw new WordListError('the answer list is empty');

  let zipf: Float32Array | null = null;
  if (files.frequencies != null) {
    zipf = new Float32Array(guesses.length);
    for (const raw of files.frequencies.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const tab = line.indexOf('\t');
      if (tab < 0) throw new WordListError(`bad frequency line "${line}"`);
      const w = line.slice(0, tab).trim();
      const z = Number(line.slice(tab + 1).trim());
      if (!Number.isFinite(z) || line.slice(tab + 1).trim() === '') throw new WordListError(`bad frequency line "${line}"`);
      const id = index.get(w);
      if (id !== undefined) zipf[id] = z;
    }
  }

  const sel: AnswerSelection =
    selection.kind === 'pasted' ? { kind: 'pasted', sha256: answersSha256(answerWords), words: answerWords } : selection;
  return new LoadedWordData({
    manifest: m,
    selection: sel,
    wordLength: len,
    guesses,
    answers,
    answerOf,
    index,
    zipf,
    ranked: files.ranked != null ? parseWordLines(files.ranked) : null,
    texts: {
      guesses: files.guesses,
      answers: selection.kind === 'default' ? files.answers : answerWords.join('\n') + '\n',
      frequencies: files.frequencies,
    },
  });
}

/**
 * Word data as a class instance: Svelte's $state does not proxy class
 * instances, so assigning it to `app.words` keeps its large arrays plain
 * (fast to read every frame) while `app.words` itself stays reactive.
 */
export class LoadedWordData implements WordData {
  manifest!: WordData['manifest'];
  selection!: WordData['selection'];
  wordLength!: number;
  guesses!: string[];
  answers!: number[];
  answerOf!: Int32Array;
  index!: Map<string, number>;
  zipf!: Float32Array | null;
  ranked!: string[] | null;
  texts!: WordData['texts'];
  constructor(d: WordData) {
    Object.assign(this, d);
  }
}

const fileCache = new Map<string, Promise<WordListFiles>>();

function baseUrl(): string {
  let b = '/';
  try {
    b = import.meta.env?.BASE_URL ?? '/';
  } catch {
    /* not under Vite */
  }
  return b.endsWith('/') ? b : b + '/';
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new WordListError(`could not load ${url} (${res.status})`);
  return res.text();
}

/** Fetch a list's manifest and files (cached per list id). */
export function fetchWordListFiles(id: string): Promise<WordListFiles> {
  let p = fileCache.get(id);
  if (!p) {
    p = (async () => {
      const dir = `${baseUrl()}wordlists/${encodeURIComponent(id)}/`;
      const res = await fetch(dir + 'manifest.json');
      if (!res.ok) throw new WordListError(`could not load word list ${id} (${res.status})`);
      const manifest = (await res.json()) as WordListManifest;
      const [guesses, answers, ranked, frequencies] = await Promise.all([
        fetchText(dir + manifest.guesses),
        fetchText(dir + manifest.answers),
        manifest.answers_ranked ? fetchText(dir + manifest.answers_ranked) : Promise.resolve(null),
        manifest.frequencies ? fetchText(dir + manifest.frequencies) : Promise.resolve(null),
      ]);
      return { manifest, guesses, answers, ranked, frequencies };
    })();
    p.catch(() => fileCache.delete(id));
    fileCache.set(id, p);
  }
  return p;
}

/** Fetch the NOTICE text of a list (for the About screen), or null. */
export async function fetchNotice(id: string): Promise<string | null> {
  const files = await fetchWordListFiles(id);
  if (!files.manifest.notice) return null;
  return fetchText(`${baseUrl()}wordlists/${encodeURIComponent(id)}/${files.manifest.notice}`);
}

export async function loadWordData(id: string, selection: AnswerSelection = { kind: 'default' }): Promise<WordData> {
  const files = await fetchWordListFiles(id);
  return buildWordData(files, selection);
}

/** The word of an answer index. */
export function answerWord(words: WordData, answerIdx: number): string {
  return words.guesses[words.answers[answerIdx]];
}

/** Answer index of a word, or -1. */
export function answerIndexOf(words: WordData, word: string): number {
  const id = words.index.get(word.toLowerCase());
  return id === undefined ? -1 : words.answerOf[id];
}

/**
 * Per-answer-index target weights for a weighting: null for equal weights,
 * otherwise each target's share of total frequency 10^zipf.
 */
export function targetWeights(words: WordData, weighting: 'equal' | 'frequency'): Float64Array | null {
  if (weighting === 'equal' || !words.zipf) return null;
  const w = new Float64Array(words.answers.length);
  let total = 0;
  for (let a = 0; a < w.length; a++) {
    w[a] = Math.pow(10, words.zipf[words.answers[a]]);
    total += w[a];
  }
  for (let a = 0; a < w.length; a++) w[a] /= total;
  return w;
}
