// Letter filter: parser, formatter and matcher (mirrors wl_core::filter). Owned by the panes agent.
// Grammar: docs/architecture.md, "Letter filter".
//
//   rule    := slot{L} extra*          L = word length
//   slot    := '?' | letter | '[' letters ']' | '[^' letters ']'
//            | '{v}' | '{c}' | '{^v}' | '{^c}' | '!' letter
//   extra   := '+' letter | '-' letter | '*'
//   filter  := rule (' | ' rule)*
//
// Parsing is case-insensitive and skips whitespace between tokens. Letters are
// stored lowercase in the parsed structure; the canonical text (formatRule /
// formatFilter) spells them uppercase, sorts and dedupes sets, writes a
// one-letter set as the letter itself ("[A]" -> "A", "[^A]" -> "!A"), keeps
// class tokens lowercase ("{v}", "{^c}"), and lists extras as the sorted "+"
// letters, then the sorted "-" letters, then "*", each preceded by a space.
//
// Vowels are a, e, i, o, u, plus y when the "Y counts as a vowel" setting is on;
// a consonant is any other letter.
import type { FilterState } from '../app/store.svelte';

export type SlotKind =
  | { kind: 'any' }
  | { kind: 'letter'; letter: string }
  | { kind: 'set'; letters: string }
  | { kind: 'class'; class: 'vowel' | 'consonant' };

export interface Slot {
  /** Negation of the value. Ignored for `any` (a negated "any" still matches any letter). */
  negate: boolean;
  value: SlotKind;
}

export interface FilterRule {
  slots: Slot[];
  /** Letters the word must contain somewhere (lowercase). */
  contains: string[];
  /** Letters the word must not contain (lowercase). */
  excludes: string[];
  /** The word has a letter at least twice. */
  repeated: boolean;
}

export type ParseResult = { ok: true; rules: FilterRule[] } | { ok: false; error: string; at: number };

const A = 97; // 'a'

function isLetterCode(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function lower(ch: string): string {
  return ch.toLowerCase();
}

/** Sorted, deduplicated lowercase letters of a string. */
function normLetters(s: string): string {
  const seen = new Set<string>();
  for (const ch of s.toLowerCase()) if (ch >= 'a' && ch <= 'z') seen.add(ch);
  return [...seen].sort().join('');
}

class ParseError extends Error {
  constructor(
    message: string,
    public at: number,
  ) {
    super(message);
  }
}

/** Parse one rule from text[start, end). Positions in errors are absolute. */
function parseRule(text: string, start: number, end: number, wordLength: number): FilterRule {
  let i = start;
  const skip = () => {
    while (i < end && isSpace(text[i])) i++;
  };
  const slots: Slot[] = [];
  const contains = new Set<string>();
  const excludes = new Set<string>();
  let repeated = false;

  skip();
  if (i >= end) throw new ParseError('Empty rule: expected a pattern such as ' + '?'.repeat(wordLength), i);

  // Slots.
  while (slots.length < wordLength) {
    skip();
    if (i >= end) {
      throw new ParseError(`Expected ${wordLength} letter positions, found ${slots.length}`, i);
    }
    const ch = text[i];
    const code = text.charCodeAt(i);
    if (ch === '?') {
      slots.push({ negate: false, value: { kind: 'any' } });
      i++;
    } else if (isLetterCode(code)) {
      slots.push({ negate: false, value: { kind: 'letter', letter: lower(ch) } });
      i++;
    } else if (ch === '!') {
      const next = text[i + 1];
      if (i + 1 >= end || next === undefined || !isLetterCode(text.charCodeAt(i + 1))) {
        throw new ParseError('Expected a letter after !', i + 1);
      }
      slots.push({ negate: true, value: { kind: 'letter', letter: lower(next) } });
      i += 2;
    } else if (ch === '[') {
      const open = i;
      i++;
      let negate = false;
      if (i < end && text[i] === '^') {
        negate = true;
        i++;
      }
      let letters = '';
      while (i < end && text[i] !== ']') {
        if (!isLetterCode(text.charCodeAt(i))) throw new ParseError('Only letters may appear in a set', i);
        letters += lower(text[i]);
        i++;
      }
      if (i >= end) throw new ParseError('Unclosed set: expected ]', open);
      if (letters.length === 0) throw new ParseError('Empty set', open);
      i++; // ']'
      const norm = normLetters(letters);
      slots.push(
        norm.length === 1
          ? { negate, value: { kind: 'letter', letter: norm } }
          : { negate, value: { kind: 'set', letters: norm } },
      );
    } else if (ch === '{') {
      const open = i;
      const close = text.indexOf('}', i);
      if (close < 0 || close >= end) throw new ParseError('Unclosed class: expected }', open);
      const body = text.slice(i + 1, close).toLowerCase();
      let negate = false;
      let cls: 'vowel' | 'consonant';
      if (body === 'v' || body === '^v') cls = 'vowel';
      else if (body === 'c' || body === '^c') cls = 'consonant';
      else throw new ParseError('Unknown class: use {v}, {c}, {^v} or {^c}', open);
      if (body.startsWith('^')) negate = true;
      slots.push({ negate, value: { kind: 'class', class: cls } });
      i = close + 1;
    } else if (ch === '+' || ch === '-' || ch === '*') {
      throw new ParseError(`Expected ${wordLength} letter positions, found ${slots.length}`, i);
    } else {
      throw new ParseError(`Unexpected character ${JSON.stringify(ch)}`, i);
    }
  }

  // Extras.
  for (;;) {
    skip();
    if (i >= end) break;
    const ch = text[i];
    if (ch === '+' || ch === '-') {
      if (i + 1 >= end || !isLetterCode(text.charCodeAt(i + 1))) {
        throw new ParseError(`Expected a letter after ${ch}`, i + 1);
      }
      (ch === '+' ? contains : excludes).add(lower(text[i + 1]));
      i += 2;
    } else if (ch === '*') {
      repeated = true;
      i++;
    } else if (isLetterCode(text.charCodeAt(i)) || ch === '?' || ch === '[' || ch === '{' || ch === '!') {
      throw new ParseError(`Too many letter positions: words have ${wordLength} letters`, i);
    } else {
      throw new ParseError(`Unexpected character ${JSON.stringify(ch)}: expected +letter, -letter or *`, i);
    }
  }

  return { slots, contains: [...contains].sort(), excludes: [...excludes].sort(), repeated };
}

export function parseFilter(text: string, wordLength: number): ParseResult {
  try {
    if (text.trim() === '') return { ok: false, error: 'Empty filter', at: 0 };
    const rules: FilterRule[] = [];
    let start = 0;
    for (;;) {
      const bar = text.indexOf('|', start);
      const end = bar < 0 ? text.length : bar;
      rules.push(parseRule(text, start, end, wordLength));
      if (bar < 0) break;
      start = bar + 1;
    }
    return { ok: true, rules };
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, error: e.message, at: e.at };
    throw e;
  }
}

function formatSlot(slot: Slot): string {
  const v = slot.value;
  switch (v.kind) {
    case 'any':
      return '?';
    case 'letter':
      return (slot.negate ? '!' : '') + v.letter.toUpperCase();
    case 'set': {
      const letters = normLetters(v.letters);
      if (letters.length === 0) return '?'; // an empty set constrains nothing
      if (letters.length === 1) return (slot.negate ? '!' : '') + letters.toUpperCase();
      return '[' + (slot.negate ? '^' : '') + letters.toUpperCase() + ']';
    }
    case 'class':
      return '{' + (slot.negate ? '^' : '') + (v.class === 'vowel' ? 'v' : 'c') + '}';
  }
}

/** Canonical text of one rule. */
export function formatRule(rule: FilterRule): string {
  let s = rule.slots.map(formatSlot).join('');
  for (const l of normLetters(rule.contains.join(''))) s += ' +' + l.toUpperCase();
  for (const l of normLetters(rule.excludes.join(''))) s += ' -' + l.toUpperCase();
  if (rule.repeated) s += ' *';
  return s;
}

/** Canonical text of several rules, separated by " | ". */
export function formatFilter(rules: FilterRule[]): string {
  return rules.map(formatRule).join(' | ');
}

/** The canonical form of a filter text, or null if it does not parse. */
export function canonicalFilterText(text: string, wordLength: number): string | null {
  const r = parseFilter(text, wordLength);
  return r.ok ? formatFilter(r.rules) : null;
}

/** A rule that matches every word: all slots blank, no extras. */
export function emptyRule(wordLength: number): FilterRule {
  return {
    slots: Array.from({ length: wordLength }, () => ({ negate: false, value: { kind: 'any' } as SlotKind })),
    contains: [],
    excludes: [],
    repeated: false,
  };
}

/** Whether a rule constrains nothing (every slot blank, no extras). */
export function isEmptyRule(rule: FilterRule): boolean {
  return (
    rule.slots.every((s) => s.value.kind === 'any') &&
    rule.contains.length === 0 &&
    rule.excludes.length === 0 &&
    !rule.repeated
  );
}

// ---------------------------------------------------------------------------
// Matching

const ALL_LETTERS = (1 << 26) - 1;

function maskOf(letters: string): number {
  let m = 0;
  for (let i = 0; i < letters.length; i++) {
    const c = letters.charCodeAt(i) | 32;
    if (c >= A && c < A + 26) m |= 1 << (c - A);
  }
  return m;
}

export function vowelMask(yIsVowel: boolean): number {
  return maskOf(yIsVowel ? 'aeiouy' : 'aeiou');
}

/** Whether a letter counts as a vowel under the setting. */
export function isVowel(letter: string, yIsVowel: boolean): boolean {
  return (vowelMask(yIsVowel) & maskOf(letter)) !== 0 && letter.length === 1;
}

/** Bitmask (bit i = letter 'a' + i) of the letters a slot accepts. */
export function slotMask(slot: Slot, yIsVowel: boolean): number {
  const v = slot.value;
  let m: number;
  switch (v.kind) {
    case 'any':
      return ALL_LETTERS;
    case 'letter':
      m = maskOf(v.letter);
      break;
    case 'set':
      m = maskOf(v.letters);
      if (m === 0) return ALL_LETTERS; // an empty set constrains nothing (formats as "?")
      break;
    case 'class': {
      const vm = vowelMask(yIsVowel);
      m = v.class === 'vowel' ? vm : ALL_LETTERS & ~vm;
      break;
    }
  }
  return slot.negate ? ALL_LETTERS & ~m : m;
}

interface CompiledRule {
  slots: Int32Array;
  contains: number;
  excludes: number;
  repeated: boolean;
}

/** A filter ready for matching nodes. */
export interface CompiledFilter {
  rules: FilterRule[];
  combine: 'all' | 'any';
  /** Guess numbers the filter applies to; empty = all. */
  rows: number[];
  includeFinal: boolean;
  mode: 'highlight' | 'isolate';
  yIsVowel: boolean;
  /** Canonical text of the rules (for export and cache keys). */
  text: string;
  /** Bitmask form of the rules (internal). */
  compiled: CompiledRule[];
  /** Guess numbers as a set, for fast scope checks (internal). */
  rowSet: Set<number> | null;
}

function compileRule(rule: FilterRule, yIsVowel: boolean): CompiledRule {
  return {
    slots: Int32Array.from(rule.slots.map((s) => slotMask(s, yIsVowel))),
    contains: maskOf(rule.contains.join('')),
    excludes: maskOf(rule.excludes.join('')),
    repeated: rule.repeated,
  };
}

/** Build a compiled filter from parsed rules and scope (for tests and the builder). */
export function compileRules(
  rules: FilterRule[],
  opts: Partial<Pick<CompiledFilter, 'combine' | 'rows' | 'includeFinal' | 'mode' | 'yIsVowel'>> = {},
): CompiledFilter {
  const yIsVowel = opts.yIsVowel ?? false;
  const rows = opts.rows ?? [];
  return {
    rules,
    combine: opts.combine ?? 'all',
    rows,
    includeFinal: opts.includeFinal ?? true,
    mode: opts.mode ?? 'highlight',
    yIsVowel,
    text: formatFilter(rules),
    compiled: rules.map((r) => compileRule(r, yIsVowel)),
    rowSet: rows.length ? new Set(rows) : null,
  };
}

/**
 * The filter in the store, compiled; null when there is no filter, its text is
 * blank or it does not parse.
 */
export function compileFilter(state: FilterState | null, wordLength: number, yIsVowel: boolean): CompiledFilter | null {
  if (!state || state.text.trim() === '') return null;
  const parsed = parseFilter(state.text, wordLength);
  if (!parsed.ok) return null;
  return compileRules(parsed.rules, {
    combine: state.combine,
    rows: [...state.rows],
    includeFinal: state.includeFinal,
    mode: state.mode,
    yIsVowel,
  });
}

function matchRule(r: CompiledRule, word: string): boolean {
  const n = r.slots.length;
  if (word.length !== n) return false;
  let seen = 0;
  let repeat = false;
  for (let i = 0; i < n; i++) {
    const c = (word.charCodeAt(i) | 32) - A;
    if (c < 0 || c >= 26) return false;
    const bit = 1 << c;
    if ((r.slots[i] & bit) === 0) return false;
    if (seen & bit) repeat = true;
    seen |= bit;
  }
  if ((seen & r.contains) !== r.contains) return false;
  if (seen & r.excludes) return false;
  if (r.repeated && !repeat) return false;
  return true;
}

/** Whether a word matches the rule set (ignoring scope). */
export function matchesWord(f: CompiledFilter, word: string): boolean {
  const rules = f.compiled;
  if (rules.length === 0) return true;
  if (f.combine === 'any') {
    for (const r of rules) if (matchRule(r, word)) return true;
    return false;
  }
  for (const r of rules) if (!matchRule(r, word)) return false;
  return true;
}

/** Whether a guess number is inside the filter's row scope. */
export function inScope(f: CompiledFilter, turn: number, isFinal: boolean): boolean {
  if (isFinal && !f.includeFinal) return false;
  if (f.rowSet && !f.rowSet.has(turn)) return false;
  return true;
}

/** Whether a node (guess `word` at guess number `turn`, `isFinal` if it is a solving guess) matches, honouring scope. */
export function matchesNode(f: CompiledFilter, word: string, turn: number, isFinal: boolean): boolean {
  return inScope(f, turn, isFinal) && matchesWord(f, word);
}

/** Whether a filter state is switched on (has non-blank text). */
export function filterActive(state: FilterState | null): boolean {
  return !!state && state.text.trim() !== '';
}

/** The default filter state when the user first opens the builder. */
export function defaultFilterState(wordLength: number): FilterState {
  return { text: '?'.repeat(wordLength), combine: 'all', mode: 'highlight', rows: [], includeFinal: true };
}
