import { describe, expect, it } from 'vitest';
import type { Game, StrategySpec } from '../backend/types';
import { FALLBACK_PRESETS, FALLBACK_SCHEMAS } from './catalogue';
import {
  changeKind,
  compilePhases,
  costWarnings,
  decompilePhases,
  defaultSpec,
  encodeShare,
  exportJson,
  fillDefaults,
  frequencyNeeds,
  labCodeFromHash,
  movePhase,
  nextColour,
  parseImport,
  parseWords,
  SAVED_COLOURS,
  shareUrl,
  specDeterministic,
  uniqueLabel,
  unsupportedReason,
  validateSpec,
  type Phase,
} from './lab';
import { miniCard } from './quick';
import { parseSaved, SAVED_KEY, storeSaved } from './saved';

const S = FALLBACK_SCHEMAS;
const guesses = new Set(['crane', 'slate', 'adieu', 'audio', 'raise', 'stare', 'tried']);
const opts = { guesses, wordLength: 5, hasFrequencies: true, maxGuesses: 6 };

describe('defaults', () => {
  it('builds a spec from its schema defaults', () => {
    expect(defaultSpec('info_proportional', S)).toEqual({ kind: 'info_proportional', beta: 1, pool: 'candidates' });
    expect(defaultSpec('most_frequent', S)).toEqual({ kind: 'most_frequent' });
    const sw = defaultSpec('switch', S) as Extract<StrategySpec, { kind: 'switch' }>;
    expect(sw.first.kind).toBe('info_proportional');
    expect(sw.when).toEqual({ when: 'after_turns', k: 2 });
  });

  it('fills missing parameters recursively', () => {
    const s = fillDefaults({ kind: 'coverage_then', switch: { when: 'after_turns', k: 3 }, then: { kind: 'info_proportional' } } as StrategySpec, S);
    expect(s).toEqual({ kind: 'coverage_then', switch: { when: 'after_turns', k: 3 }, then: { kind: 'info_proportional', beta: 1, pool: 'candidates' } });
  });

  it('keeps shared parameters when the kind changes', () => {
    const s = changeKind({ kind: 'info_proportional', beta: 3, pool: 'allowed' }, 'random', S);
    expect(s).toEqual({ kind: 'random', pool: 'allowed' });
    const f = changeKind({ kind: 'info_proportional', beta: 3, pool: 'allowed' }, 'freq_proportional', S);
    expect(f).toEqual({ kind: 'freq_proportional', beta: 3 });
  });
});

describe('determinism and needs', () => {
  it('mirrors is_deterministic', () => {
    expect(specDeterministic({ kind: 'max_info' })).toBe(true);
    expect(specDeterministic({ kind: 'random' })).toBe(false);
    expect(specDeterministic({ kind: 'sequence_then', words: ['crane'], switch: { when: 'sequence_exhausted' }, then: { kind: 'max_info' } })).toBe(true);
    expect(specDeterministic({ kind: 'switch', first: { kind: 'random' }, then: { kind: 'max_info' }, when: { when: 'after_turns', k: 1 } })).toBe(false);
    expect(specDeterministic({ kind: 'mixture', weights: [1, 0], strategies: [{ kind: 'max_info' }, { kind: 'random' }] })).toBe(true);
    expect(specDeterministic({ kind: 'mixture', weights: [1, 1], strategies: [{ kind: 'max_info' }, { kind: 'random' }] })).toBe(false);
  });

  it('finds frequency needs anywhere in the tree', () => {
    const spec: StrategySpec = { kind: 'switch', first: { kind: 'max_info' }, then: { kind: 'freq_proportional', beta: 1 }, when: { when: 'after_turns', k: 2 } };
    expect(frequencyNeeds(spec, S)).toEqual(['Frequency-proportional']);
    expect(unsupportedReason(spec, S, true)).toBeNull();
    expect(unsupportedReason(spec, S, false)).toMatch(/no frequencies/);
    expect(unsupportedReason({ kind: 'max_info' }, S, false)).toBeNull();
  });
});

describe('validateSpec', () => {
  it('accepts every fallback preset and schema default', () => {
    for (const p of FALLBACK_PRESETS) expect(validateSpec(p.spec, S, opts)).toEqual([]);
    for (const s of S) {
      const spec = defaultSpec(s.kind, S);
      expect(validateSpec(spec, S, opts), s.kind).toEqual([]);
    }
  });

  it('checks numbers, integers and choices', () => {
    expect(validateSpec({ kind: 'info_proportional', beta: -1 }, S, opts)[0]).toMatchObject({ path: 'beta' });
    expect(validateSpec({ kind: 'info_proportional', beta: 'x' }, S, opts)[0].message).toMatch(/number/);
    expect(validateSpec({ kind: 'info_proportional', pool: 'nope' }, S, opts)[0]).toMatchObject({ path: 'pool' });
    expect(validateSpec({ kind: 'solve_when_le', n: 2.5, inner: { kind: 'max_info' } }, S, opts)[0]).toMatchObject({ path: 'n' });
  });

  it('checks word lists against the guess list', () => {
    const bad = validateSpec({ kind: 'fixed_sequence', words: ['crane', 'zzzzz'] }, S, opts);
    expect(bad).toHaveLength(1);
    expect(bad[0].message).toContain('ZZZZZ');
    expect(validateSpec({ kind: 'fixed_sequence', words: [] }, S, opts)[0].path).toBe('words');
    expect(validateSpec({ kind: 'fixed_sequence', words: ['cranes'] }, S, { wordLength: 5 })[0].message).toContain('CRANES');
  });

  it('reports nested issues with dotted paths', () => {
    const issues = validateSpec(
      { kind: 'mixture', weights: [1, -1], strategies: [{ kind: 'max_info' }, { kind: 'info_proportional', beta: 99 }] },
      S,
      opts,
    );
    expect(issues.map((i) => i.path).sort()).toEqual(['strategies.1.beta', 'weights']);
    const sw = validateSpec({ kind: 'switch', first: { kind: 'max_info' }, then: { kind: 'max_info' }, when: { when: 'after_turns', k: 0 } }, S, opts);
    expect(sw[0].path).toBe('when.k');
  });

  it('checks weights against the strategy count', () => {
    const issues = validateSpec({ kind: 'mixture', weights: [1], strategies: [{ kind: 'max_info' }, { kind: 'random' }] }, S, opts);
    expect(issues[0].message).toMatch(/one weight per strategy/);
  });

  it('rejects unknown kinds, parameters and frequency needs without frequencies', () => {
    expect(validateSpec({ kind: 'minimax' }, S, opts)[0].message).toMatch(/Unknown strategy kind/);
    expect(validateSpec({ kind: 'max_info', colour: 'red' }, S, opts)[0].path).toBe('colour');
    expect(validateSpec({ kind: 'most_frequent' }, S, { ...opts, hasFrequencies: false })[0].message).toMatch(/no frequencies/);
    expect(validateSpec(null, S, opts)).toHaveLength(1);
  });
});

describe('parseWords', () => {
  it('splits on commas, spaces and newlines', () => {
    expect(parseWords(' CRANE, slate\nadieu;;audio ')).toEqual(['crane', 'slate', 'adieu', 'audio']);
    expect(parseWords('')).toEqual([]);
  });
});

describe('cost guard', () => {
  const env = { nGuesses: 14855, nAnswers: 2500, replicates: 20 };
  it('warns for info_proportional over the allowed pool', () => {
    const w = costWarnings({ kind: 'info_proportional', beta: 1, pool: 'allowed' }, S, env);
    expect(w).toHaveLength(1);
    expect(w[0].fullSeconds).toBeGreaterThan(w[0].quickSeconds);
    expect(w[0].message).toMatch(/14,855 allowed guesses/);
  });

  it('is quiet for candidate pools and other kinds', () => {
    expect(costWarnings({ kind: 'info_proportional', beta: 1, pool: 'candidates' }, S, env)).toEqual([]);
    expect(costWarnings({ kind: 'max_info', pool: 'allowed' }, S, env)).toEqual([]);
  });

  it('follows the global pool setting and nested phases', () => {
    const spec: StrategySpec = { kind: 'switch', first: { kind: 'max_info' }, then: { kind: 'info_proportional', beta: 2 }, when: { when: 'after_turns', k: 1 } };
    expect(costWarnings(spec, S, env)).toEqual([]);
    expect(costWarnings(spec, S, { ...env, globalPool: 'allowed' })).toHaveLength(1);
    // The setting overrides an explicit candidate pool too.
    expect(costWarnings({ kind: 'info_proportional', beta: 1, pool: 'candidates' }, S, { ...env, globalPool: 'allowed' })).toHaveLength(1);
  });
});

describe('hybrid builder', () => {
  const a: StrategySpec = { kind: 'fixed_sequence', words: ['crane'], solve_when_one: true };
  const b: StrategySpec = { kind: 'info_proportional', beta: 1, pool: 'candidates' };
  const c: StrategySpec = { kind: 'max_info', pool: 'candidates' };

  it('compiles one phase to itself', () => {
    expect(compilePhases([{ spec: b, when: null }])).toEqual(b);
  });

  it('compiles phases to nested switch specs', () => {
    const phases: Phase[] = [
      { spec: a, when: { when: 'sequence_exhausted' } },
      { spec: b, when: { when: 'candidates_le', n: 10 } },
      { spec: c, when: null },
    ];
    expect(compilePhases(phases)).toEqual({
      kind: 'switch',
      first: a,
      when: { when: 'sequence_exhausted' },
      then: { kind: 'switch', first: b, when: { when: 'candidates_le', n: 10 }, then: c },
    });
  });

  it('round-trips through decompilePhases', () => {
    const phases: Phase[] = [
      { spec: a, when: { when: 'after_turns', k: 1 } },
      { spec: b, when: { when: 'bits_le', h: 2.5 } },
      { spec: c, when: null },
    ];
    expect(decompilePhases(compilePhases(phases))).toEqual(phases);
    expect(decompilePhases(b)).toEqual([{ spec: b, when: null }]);
  });

  it('throws on no phases', () => {
    expect(() => compilePhases([])).toThrow();
  });

  it('moves phases and keeps rules on all but the last', () => {
    const phases: Phase[] = [
      { spec: a, when: { when: 'after_turns', k: 1 } },
      { spec: b, when: { when: 'candidates_le', n: 5 } },
      { spec: c, when: null },
    ];
    const moved = movePhase(phases, 2, 0);
    expect(moved.map((p) => p.spec)).toEqual([c, a, b]);
    expect(moved[0].when).toEqual({ when: 'after_turns', k: 2 });
    expect(moved[1].when).toEqual({ when: 'after_turns', k: 1 });
    expect(moved[2].when).toBeNull();
    expect(movePhase(phases, 0, 5)).toEqual(phases);
    const compiled = compilePhases(moved);
    expect(compiled.kind).toBe('switch');
  });
});

describe('import, export and share links', () => {
  const doc = { label: 'CRANE then info', colour: '#3a86ff', spec: { kind: 'sequence_then', words: ['crane'], switch: { when: 'sequence_exhausted' }, then: { kind: 'max_info' } } as StrategySpec };

  it('round-trips exported JSON', () => {
    const r = parseImport(exportJson(doc));
    expect(r).toEqual({ ok: true, doc });
  });

  it('imports a bare spec', () => {
    expect(parseImport('{"kind":"random","pool":"allowed"}')).toEqual({ ok: true, doc: { spec: { kind: 'random', pool: 'allowed' } } });
  });

  it('round-trips a share link and a bare code', () => {
    const url = shareUrl(doc, { origin: 'https://example.org', pathname: '/app/' });
    expect(url.startsWith('https://example.org/app/#lab=')).toBe(true);
    expect(parseImport(url)).toEqual({ ok: true, doc });
    expect(parseImport(encodeShare(doc))).toEqual({ ok: true, doc });
    expect(labCodeFromHash('#l=2&lab=' + encodeShare(doc) + '&o=crane')).toBe(encodeShare(doc));
    expect(labCodeFromHash('#l=2')).toBeNull();
  });

  it('keeps non-ASCII labels', () => {
    const d = { ...doc, label: 'β = 2 · ε-greedy' };
    expect(parseImport(encodeShare(d))).toEqual({ ok: true, doc: d });
  });

  it('rejects junk', () => {
    expect(parseImport('').ok).toBe(false);
    expect(parseImport('{nope').ok).toBe(false);
    expect(parseImport('{"label":"x"}').ok).toBe(false);
    expect(parseImport('https://example.org/#l=1').ok).toBe(false);
    expect(parseImport('!!!').ok).toBe(false);
  });

  it('drops invalid colours on import', () => {
    const r = parseImport(JSON.stringify({ label: 'x', colour: 'javascript:alert(1)', spec: { kind: 'max_info' } }));
    expect(r.ok && r.doc.colour).toBeUndefined();
  });
});

describe('saved strategies', () => {
  it('picks unused colours and unique labels', () => {
    expect(nextColour([])).toBe(SAVED_COLOURS[0]);
    expect(nextColour([SAVED_COLOURS[0].toUpperCase()])).toBe(SAVED_COLOURS[1]);
    expect(nextColour(SAVED_COLOURS)).toBe(SAVED_COLOURS[0]);
    expect(uniqueLabel('Mine', [])).toBe('Mine');
    expect(uniqueLabel('Mine', ['Mine', 'Mine 2'])).toBe('Mine 3');
  });

  it('stores and parses the list, dropping invalid entries', () => {
    const store = new Map<string, string>();
    const storage = { setItem: (k: string, v: string) => void store.set(k, v), getItem: (k: string) => store.get(k) ?? null };
    const entries = [{ id: 'saved-1', label: 'A', colour: '#fff', spec: { kind: 'max_info' } as StrategySpec }];
    storeSaved(entries, storage);
    expect(JSON.parse(store.get(SAVED_KEY)!)).toEqual(entries);
    expect(parseSaved(store.get(SAVED_KEY)!)).toEqual(entries);
    expect(parseSaved(JSON.stringify({ entries: [...entries, { id: 3 }] }))).toEqual(entries);
    expect(parseSaved('garbage')).toEqual([]);
    expect(parseSaved(null)).toEqual([]);
  });
});

describe('miniCard', () => {
  const game = (target: number, n: number, solved = true): Game => ({
    target,
    replicate: 0,
    solved,
    turns: Array.from({ length: n }, () => ({ guess: 0, pattern: 0, candsBefore: 1, candsAfter: 1, pChosen: 1, bitsExpected: 0, phase: 0, isCandidate: true })),
  });

  it('averages within targets, then across targets', () => {
    // Target 0: solved in 3 and 5; target 1: one failure (6 guesses).
    const card = miniCard([game(0, 3), game(0, 5), game(1, 6, false)], 6);
    expect(card.nGames).toBe(3);
    expect(card.nTargets).toBe(2);
    expect(card.shares).toEqual([0, 0, 0.25, 0, 0.25, 0, 0.5]);
    expect(card.mean).toBeCloseTo((4 + 6) / 2);
    expect(card.solveRate).toBeCloseTo(0.5);
  });

  it('applies target weights and ignores player games', () => {
    const g = game(1, 2);
    const card = miniCard([game(0, 4), g, { ...game(0, 1), isPlayer: true }], 6, (t) => (t === 0 ? 3 : 1));
    expect(card.shares[3]).toBeCloseTo(0.75);
    expect(card.shares[1]).toBeCloseTo(0.25);
    expect(card.mean).toBeCloseTo(3.5);
    expect(card.nGames).toBe(2);
  });

  it('is empty without games', () => {
    const card = miniCard([], 6);
    expect(card.nGames).toBe(0);
    expect(Number.isNaN(card.mean)).toBe(true);
    expect(card.shares).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});
