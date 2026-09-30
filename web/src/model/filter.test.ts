import { describe, expect, it } from 'vitest';
import {
  canonicalFilterText,
  compileFilter,
  compileRules,
  emptyRule,
  formatFilter,
  formatRule,
  isEmptyRule,
  matchesNode,
  matchesWord,
  parseFilter,
  type FilterRule,
  type Slot,
} from './filter';

function rules(text: string, len = 5): FilterRule[] {
  const r = parseFilter(text, len);
  if (!r.ok) throw new Error(`${text}: ${r.error} at ${r.at}`);
  return r.rules;
}

function matcher(text: string, opts: Parameters<typeof compileRules>[1] = {}, len = 5) {
  const f = compileRules(rules(text, len), opts);
  return (w: string) => matchesWord(f, w);
}

describe('parseFilter', () => {
  it('parses letters and blanks', () => {
    const [r] = rules('?A??Y');
    expect(r.slots.map((s) => s.value.kind)).toEqual(['any', 'letter', 'any', 'any', 'letter']);
    expect(r.slots[1]).toEqual({ negate: false, value: { kind: 'letter', letter: 'a' } });
    expect(r.contains).toEqual([]);
    expect(r.excludes).toEqual([]);
    expect(r.repeated).toBe(false);
  });

  it('parses classes, sets and negations', () => {
    const [r] = rules('{v}{^c}[ab][^xy]!q');
    expect(r.slots).toEqual<Slot[]>([
      { negate: false, value: { kind: 'class', class: 'vowel' } },
      { negate: true, value: { kind: 'class', class: 'consonant' } },
      { negate: false, value: { kind: 'set', letters: 'ab' } },
      { negate: true, value: { kind: 'set', letters: 'xy' } },
      { negate: true, value: { kind: 'letter', letter: 'q' } },
    ]);
  });

  it('parses extras, deduped and sorted', () => {
    const [r] = rules('?A??Y +s +E -S -b +e *');
    expect(r.contains).toEqual(['e', 's']);
    expect(r.excludes).toEqual(['b', 's']);
    expect(r.repeated).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(formatFilter(rules('{V}{c}[^s]?y +e'))).toBe('{v}{c}!S?Y +E');
  });

  it('splits rules on |', () => {
    const rs = rules('?A??Y | {v}{v}??? +e');
    expect(rs).toHaveLength(2);
    expect(formatFilter(rs)).toBe('?A??Y | {v}{v}??? +E');
    expect(rules('?A??Y|S????')).toHaveLength(2);
  });

  it('respects the word length', () => {
    expect(parseFilter('????', 4).ok).toBe(true);
    expect(parseFilter('???????', 7).ok).toBe(true);
    expect(parseFilter('????', 5).ok).toBe(false);
  });

  it.each([
    ['', 0],
    ['????', 4],
    ['??????', 5],
    ['???? +E', 5],
    ['?A??Y +', 7],
    ['?A??Y +1', 7],
    ['?A??Y E', 6],
    ['?A??Y #', 6],
    ['[ab????', 3],
    ['[ab', 0],
    ['[]????', 0],
    ['[a1]????', 2],
    ['{x}????', 0],
    ['{v????', 0],
    ['!?????', 1],
    ['#????', 0],
    ['????? | ', 8],
    ['????? | ????', 12],
  ])('rejects %j at %i', (text, at) => {
    const r = parseFilter(text, 5);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.at).toBe(at);
      expect(r.error.length).toBeGreaterThan(0);
    }
  });
});

describe('formatRule', () => {
  it.each([
    ['?a??y', '?A??Y'],
    ['{v}{v}???', '{v}{v}???'],
    ['[^S]????', '!S????'],
    ['[s]????', 'S????'],
    ['[cba][^zyx]{^v}{^c}!e', '[ABC][^XYZ]{^v}{^c}!E'],
    ['[aab]????', '[AB]????'],
    ['?A??Y +E -S', '?A??Y +E -S'],
    ['????? * -b +z +a -a', '????? +A +Z -A -B *'],
    ['  ?  A ? ? Y   +E  ', '?A??Y +E'],
  ])('%j formats as %j', (text, canonical) => {
    expect(formatFilter(rules(text))).toBe(canonical);
  });

  it('formats a builder rule with an empty set as blank', () => {
    const r = emptyRule(5);
    r.slots[0] = { negate: false, value: { kind: 'set', letters: '' } };
    expect(formatRule(r)).toBe('?????');
  });

  it('round-trips canonical text', () => {
    for (const text of ['?A??Y', '{v}{v}???', '!S????', '?A??Y +E -S', '[AEIOU][^XYZ]{c}{^v}? *']) {
      expect(formatFilter(rules(text))).toBe(text);
      expect(canonicalFilterText(text, 5)).toBe(text);
    }
    expect(canonicalFilterText('{q}????', 5)).toBeNull();
  });

  it('knows an empty rule', () => {
    expect(isEmptyRule(emptyRule(5))).toBe(true);
    expect(isEmptyRule(rules('????? *')[0])).toBe(false);
  });
});

describe('matchesWord', () => {
  it('matches letters in positions', () => {
    const m = matcher('?A??Y');
    expect(m('daisy')).toBe(true);
    expect(m('happy')).toBe(true);
    expect(m('crane')).toBe(false);
    expect(m('DAISY')).toBe(true);
  });

  it('matches vowel and consonant classes', () => {
    const m = matcher('{v}{v}???');
    expect(m('audio')).toBe(true);
    expect(m('eerie')).toBe(true);
    expect(m('crane')).toBe(false);
    expect(m('yeast')).toBe(false);
    expect(matcher('{v}{v}???', { yIsVowel: true })('yeast')).toBe(true);
    expect(matcher('{c}????')('yeast')).toBe(true);
    expect(matcher('{c}????', { yIsVowel: true })('yeast')).toBe(false);
    expect(matcher('{^v}????')('crane')).toBe(true);
    expect(matcher('{^c}????')('audio')).toBe(true);
  });

  it('matches sets and negations', () => {
    expect(matcher('[^S]????')('slate')).toBe(false);
    expect(matcher('[^S]????')('crane')).toBe(true);
    expect(matcher('!S????')('crane')).toBe(true);
    expect(matcher('[CS]????')('slate')).toBe(true);
    expect(matcher('[CS]????')('crane')).toBe(true);
    expect(matcher('[CS]????')('trace')).toBe(false);
  });

  it('matches extras', () => {
    const m = matcher('?A??Y +E -S');
    expect(m('happy')).toBe(false); // no E
    expect(matcher('????? +E -S')('crane')).toBe(true);
    expect(matcher('????? +E -S')('slate')).toBe(false);
    expect(matcher('????? *')('eerie')).toBe(true);
    expect(matcher('????? *')('crane')).toBe(false);
    expect(matcher('????? +E +R')('crane')).toBe(true);
    expect(matcher('????? +E +S')('crane')).toBe(false);
  });

  it('combines rules with all or any', () => {
    const rs = rules('S???? | ????E');
    expect(matchesWord(compileRules(rs, { combine: 'all' }), 'slate')).toBe(true);
    expect(matchesWord(compileRules(rs, { combine: 'all' }), 'crane')).toBe(false);
    expect(matchesWord(compileRules(rs, { combine: 'any' }), 'crane')).toBe(true);
    expect(matchesWord(compileRules(rs, { combine: 'any' }), 'stair')).toBe(true);
    expect(matchesWord(compileRules(rs, { combine: 'any' }), 'audio')).toBe(false);
  });

  it('rejects words of the wrong length', () => {
    expect(matcher('?????')('cranes')).toBe(false);
    expect(matcher('?????')('cran')).toBe(false);
  });
});

describe('matchesNode and compileFilter', () => {
  it('honours rows and the final guess', () => {
    const f = compileFilter({ text: '?A???', combine: 'all', mode: 'highlight', rows: [2, 3], includeFinal: false }, 5, false)!;
    expect(matchesNode(f, 'daisy', 2, false)).toBe(true);
    expect(matchesNode(f, 'daisy', 1, false)).toBe(false);
    expect(matchesNode(f, 'daisy', 3, true)).toBe(false);
    const all = compileFilter({ text: '?A???', combine: 'all', mode: 'isolate', rows: [], includeFinal: true }, 5, false)!;
    expect(matchesNode(all, 'daisy', 6, true)).toBe(true);
    expect(all.mode).toBe('isolate');
  });

  it('returns null for no, blank or invalid filters', () => {
    const base = { combine: 'all' as const, mode: 'highlight' as const, rows: [], includeFinal: true };
    expect(compileFilter(null, 5, false)).toBeNull();
    expect(compileFilter({ ...base, text: '  ' }, 5, false)).toBeNull();
    expect(compileFilter({ ...base, text: '?A?' }, 5, false)).toBeNull();
    expect(compileFilter({ ...base, text: '?a??y' }, 5, false)!.text).toBe('?A??Y');
  });
});

// ---------------------------------------------------------------------------
// Property tests against a naive matcher over random rules and words.

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHA = 'abcdefghijklmnopqrstuvwxyz';

function randomRule(r: () => number, len: number): FilterRule {
  const pick = () => ALPHA[Math.floor(r() * 26)];
  const slots: Slot[] = [];
  for (let i = 0; i < len; i++) {
    const k = Math.floor(r() * 5);
    const negate = k > 0 && r() < 0.3;
    if (k === 0) slots.push({ negate: false, value: { kind: 'any' } });
    else if (k === 1) slots.push({ negate, value: { kind: 'letter', letter: pick() } });
    else if (k === 2) {
      let letters = '';
      const n = 2 + Math.floor(r() * 5);
      for (let j = 0; j < n; j++) letters += pick();
      letters = [...new Set(letters)].sort().join('');
      slots.push(letters.length === 1 ? { negate, value: { kind: 'letter', letter: letters } } : { negate, value: { kind: 'set', letters } });
    } else slots.push({ negate, value: { kind: 'class', class: k === 3 ? 'vowel' : 'consonant' } });
  }
  const contains = [...new Set(Array.from({ length: Math.floor(r() * 3) }, pick))].sort();
  const excludes = [...new Set(Array.from({ length: Math.floor(r() * 3) }, pick))].sort();
  return { slots, contains, excludes, repeated: r() < 0.2 };
}

function naiveSlot(slot: Slot, ch: string, y: boolean): boolean {
  const vowels = y ? 'aeiouy' : 'aeiou';
  let m: boolean;
  const v = slot.value;
  if (v.kind === 'any') return true;
  if (v.kind === 'letter') m = ch === v.letter;
  else if (v.kind === 'set') m = v.letters.includes(ch);
  else m = v.class === 'vowel' ? vowels.includes(ch) : !vowels.includes(ch);
  return slot.negate ? !m : m;
}

function naiveRule(rule: FilterRule, word: string, y: boolean): boolean {
  if (word.length !== rule.slots.length) return false;
  for (let i = 0; i < word.length; i++) if (!naiveSlot(rule.slots[i], word[i], y)) return false;
  if (!rule.contains.every((l) => word.includes(l))) return false;
  if (rule.excludes.some((l) => word.includes(l))) return false;
  if (rule.repeated && new Set(word).size === word.length) return false;
  return true;
}

describe('properties', () => {
  const r = rng(12345);
  const words = Array.from({ length: 400 }, () => {
    // Bias toward vowels and repeats so rules match sometimes.
    let w = '';
    for (let i = 0; i < 5; i++) w += r() < 0.35 ? 'aeiouy'[Math.floor(r() * 6)] : ALPHA[Math.floor(r() * 26)];
    return w;
  });

  it('format then parse is the identity on rules', () => {
    for (let i = 0; i < 500; i++) {
      const len = 4 + (i % 4);
      const rule = randomRule(r, len);
      const text = formatRule(rule);
      const back = rules(text, len);
      expect(back).toHaveLength(1);
      expect(formatRule(back[0])).toBe(text);
      expect(back[0]).toEqual(rule);
    }
  });

  it('agrees with a naive matcher', () => {
    for (let i = 0; i < 300; i++) {
      const rs = [randomRule(r, 5), randomRule(r, 5)];
      const y = i % 2 === 0;
      const all = compileRules(rs, { combine: 'all', yIsVowel: y });
      const any = compileRules(rs, { combine: 'any', yIsVowel: y });
      for (const w of words) {
        const a = naiveRule(rs[0], w, y);
        const b = naiveRule(rs[1], w, y);
        expect(matchesWord(all, w)).toBe(a && b);
        expect(matchesWord(any, w)).toBe(a || b);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Shared vectors written by the Rust side (wl_core::filter).

// A glob resolves to nothing while the Rust side has not written the file yet.
const vectorFiles = import.meta.glob('../../../data/testvectors/filter.json', { eager: true, import: 'default' });
const vectorData = Object.values(vectorFiles)[0] as Record<string, unknown> | undefined;
const haveVectors = !!vectorData;

interface VectorCase {
  text: string;
  rules?: FilterRule[];
  word_length?: number;
  canonical?: string;
  y_vowel?: boolean;
  combine?: 'all' | 'any';
  matches?: unknown;
  non_matches?: string[];
  rejects?: string[];
}

/** Normalise the several plausible shapes of `matches` into [word, expected] pairs. */
function expectations(c: VectorCase): [string, boolean][] {
  const out: [string, boolean][] = [];
  const m = c.matches;
  if (Array.isArray(m)) {
    for (const e of m) {
      if (typeof e === 'string') out.push([e, true]);
      else if (Array.isArray(e)) out.push([String(e[0]), Boolean(e[1])]);
      else if (e && typeof e === 'object') {
        const o = e as Record<string, unknown>;
        out.push([String(o.word), Boolean(o.matches ?? o.match ?? o.expected)]);
      }
    }
  } else if (m && typeof m === 'object') {
    for (const [w, v] of Object.entries(m as Record<string, unknown>)) out.push([w, Boolean(v)]);
  }
  for (const w of c.non_matches ?? c.rejects ?? []) out.push([w, false]);
  return out;
}

describe.skipIf(!haveVectors)('shared vectors (data/testvectors/filter.json)', () => {
  const data = (vectorData ?? {}) as Record<string, unknown>;
  const cases = (data.cases ?? []) as VectorCase[];
  const errors = (data.errors ?? data.parse_errors ?? data.invalid ?? []) as { text: string; word_length?: number; at?: number; error?: string }[];

  it('has cases', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    it(`case ${JSON.stringify(c.text)}`, () => {
      const len = c.word_length ?? 5;
      const parsed = parseFilter(c.text, len);
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
      if (!parsed.ok) return;
      if (c.canonical !== undefined) expect(formatFilter(parsed.rules)).toBe(c.canonical);
      if (c.rules !== undefined) expect(parsed.rules).toEqual(c.rules);
      const f = compileRules(parsed.rules, { yIsVowel: !!c.y_vowel, combine: c.combine ?? 'all' });
      for (const [word, want] of expectations(c)) expect(matchesWord(f, word), `${c.text} vs ${word}`).toBe(want);
    });
  }

  const scopeCases = (data.scope_cases ?? []) as {
    text: string;
    word_length?: number;
    combine?: 'all' | 'any';
    rows: number[];
    include_final: boolean;
    y_vowel?: boolean;
    nodes: { word: string; turn: number; is_final: boolean; matches: boolean }[];
  }[];
  for (const sc of scopeCases) {
    it(`scope ${JSON.stringify(sc.text)} rows=${JSON.stringify(sc.rows)} final=${sc.include_final}`, () => {
      const f = compileFilter(
        { text: sc.text, combine: sc.combine ?? 'all', mode: 'highlight', rows: sc.rows, includeFinal: sc.include_final },
        sc.word_length ?? 5,
        !!sc.y_vowel,
      );
      expect(f).not.toBeNull();
      for (const n of sc.nodes) expect(matchesNode(f!, n.word, n.turn, n.is_final), JSON.stringify(n)).toBe(n.matches);
    });
  }

  for (const e of errors) {
    it(`error ${JSON.stringify(e.text)}`, () => {
      const r = parseFilter(e.text, e.word_length ?? 5);
      expect(r.ok).toBe(false);
      if (!r.ok && typeof e.at === 'number') expect(r.at).toBe(e.at);
    });
  }
});
