// Strategy Lab logic (pure): defaults from schemas, validation, determinism and
// resource needs, the cost guard, the hybrid phase builder, import/export and
// share links. Unit-tested in lab.test.ts.
import type { ParamField, StrategySchema, StrategySpec, SwitchRule } from '../backend/types';

type AnySpec = Record<string, unknown> & { kind: string };

export function schemaFor(kind: string, schemas: StrategySchema[]): StrategySchema | undefined {
  return schemas.find((s) => s.kind === kind);
}

function clone<T>(x: T): T {
  return x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T);
}

export const DEFAULT_SWITCH_RULE: SwitchRule = { when: 'after_turns', k: 2 };
export const FALLBACK_INNER: StrategySpec = { kind: 'info_proportional', beta: 1, pool: 'candidates' };

function defaultFor(field: ParamField, schemas: StrategySchema[]): unknown {
  const d = field.default;
  switch (field.type.type) {
    case 'strategy':
      return d && typeof d === 'object' && 'kind' in (d as object) ? fillDefaults(d as StrategySpec, schemas) : clone(FALLBACK_INNER);
    case 'strategies':
      return Array.isArray(d) ? d.map((s) => fillDefaults(s as StrategySpec, schemas)) : [clone(FALLBACK_INNER)];
    case 'weights':
      return Array.isArray(d) ? clone(d) : [1];
    case 'switch_rule':
      return d && typeof d === 'object' && 'when' in (d as object) ? clone(d) : clone(DEFAULT_SWITCH_RULE);
    case 'words':
      return Array.isArray(d) ? clone(d) : [];
    case 'boolean':
      return typeof d === 'boolean' ? d : false;
    case 'number':
      return typeof d === 'number' ? d : field.type.min;
    case 'integer':
      return typeof d === 'number' ? d : field.type.min;
    case 'choice':
      return typeof d === 'string' ? d : field.type.options[0]?.value;
  }
}

/** A new spec of `kind` with every parameter at its default. */
export function defaultSpec(kind: string, schemas: StrategySchema[]): StrategySpec {
  const schema = schemaFor(kind, schemas);
  const spec: AnySpec = { kind };
  if (schema) for (const f of schema.params) spec[f.name] = defaultFor(f, schemas);
  return spec as unknown as StrategySpec;
}

/** Fill missing parameters with defaults, recursively (unknown kinds are left as they are). */
export function fillDefaults(spec: StrategySpec, schemas: StrategySchema[]): StrategySpec {
  const s = clone(spec) as unknown as AnySpec;
  const schema = schemaFor(s.kind, schemas);
  if (!schema) return s as unknown as StrategySpec;
  for (const f of schema.params) {
    if (s[f.name] === undefined) s[f.name] = defaultFor(f, schemas);
    else if (f.type.type === 'strategy' && s[f.name] && typeof s[f.name] === 'object') s[f.name] = fillDefaults(s[f.name] as StrategySpec, schemas);
    else if (f.type.type === 'strategies' && Array.isArray(s[f.name])) s[f.name] = (s[f.name] as StrategySpec[]).map((x) => fillDefaults(x, schemas));
  }
  return s as unknown as StrategySpec;
}

/**
 * Change a spec's kind, keeping parameters that the new kind shares with the
 * old one (same name and type) and defaulting the rest.
 */
export function changeKind(spec: StrategySpec, kind: string, schemas: StrategySchema[]): StrategySpec {
  const next = defaultSpec(kind, schemas) as unknown as AnySpec;
  const old = spec as unknown as AnySpec;
  const oldSchema = schemaFor(old.kind, schemas);
  const newSchema = schemaFor(kind, schemas);
  if (oldSchema && newSchema) {
    for (const f of newSchema.params) {
      const of = oldSchema.params.find((p) => p.name === f.name);
      if (of && of.type.type === f.type.type && old[f.name] !== undefined) next[f.name] = clone(old[f.name]);
    }
  }
  return next as unknown as StrategySpec;
}

/** Nested specs of a spec, from its schema (or known shapes when the schema is missing). */
export function childSpecs(spec: StrategySpec, schemas: StrategySchema[]): StrategySpec[] {
  const s = spec as unknown as AnySpec;
  const out: StrategySpec[] = [];
  const schema = schemaFor(s.kind, schemas);
  const fields = schema
    ? schema.params.map((p) => [p.name, p.type.type] as const)
    : ([
        ['then', 'strategy'],
        ['first', 'strategy'],
        ['inner', 'strategy'],
        ['strategies', 'strategies'],
      ] as const);
  for (const [name, type] of fields) {
    const v = s[name];
    if (type === 'strategy' && v && typeof v === 'object' && 'kind' in v) out.push(v as StrategySpec);
    if (type === 'strategies' && Array.isArray(v)) for (const x of v) if (x && typeof x === 'object' && 'kind' in x) out.push(x as StrategySpec);
  }
  return out;
}

/** Every spec in the tree, depth first (the spec itself first). */
export function walkSpec(spec: StrategySpec, schemas: StrategySchema[]): StrategySpec[] {
  const out: StrategySpec[] = [spec];
  for (const c of childSpecs(spec, schemas)) out.push(...walkSpec(c, schemas));
  return out;
}

/** Whether a spec is deterministic (mirrors Strategy::is_deterministic). */
export function specDeterministic(spec: StrategySpec): boolean {
  const s = spec as unknown as AnySpec;
  switch (s.kind) {
    case 'max_info':
    case 'most_frequent':
    case 'fixed_sequence':
      return true;
    case 'random':
    case 'info_proportional':
    case 'freq_proportional':
      return false;
    case 'coverage_then':
    case 'sequence_then':
      return specDeterministic(s.then as StrategySpec);
    case 'switch':
      return specDeterministic(s.first as StrategySpec) && specDeterministic(s.then as StrategySpec);
    case 'solve_when_le':
      return specDeterministic(s.inner as StrategySpec);
    case 'mixture': {
      const ws = (s.weights as number[]) ?? [];
      const ss = (s.strategies as StrategySpec[]) ?? [];
      const live = ss.filter((_, i) => (ws[i] ?? 0) > 0);
      return live.length <= 1 && live.every(specDeterministic);
    }
    default:
      return false;
  }
}

/** Kinds in the spec tree that need word frequencies. */
export function frequencyNeeds(spec: StrategySpec, schemas: StrategySchema[]): string[] {
  const out = new Set<string>();
  for (const s of walkSpec(spec, schemas)) {
    const schema = schemaFor(s.kind, schemas);
    if (schema?.needs?.frequencies) out.add(schema.label || s.kind);
  }
  return [...out];
}

/** Why a word list cannot support a spec, or null if it can. */
export function unsupportedReason(spec: StrategySpec, schemas: StrategySchema[], hasFrequencies: boolean): string | null {
  if (hasFrequencies) return null;
  const needs = frequencyNeeds(spec, schemas);
  if (!needs.length) return null;
  return `This word list has no frequencies, which ${needs.join(' and ')} ${needs.length > 1 ? 'need' : 'needs'}.`;
}

// ---------------------------------------------------------------------------
// Validation

export interface Issue {
  /** Dotted path of the field, e.g. "then.beta" ("" for the spec itself). */
  path: string;
  message: string;
}

export interface ValidateOptions {
  /** Allowed guesses, for word lists. Skipped when absent. */
  guesses?: { has(word: string): boolean };
  wordLength?: number;
  hasFrequencies?: boolean;
  maxGuesses?: number;
}

const join = (a: string, b: string | number) => (a ? `${a}.${b}` : String(b));

export function validateSwitchRule(rule: unknown, path: string, opts: ValidateOptions): Issue[] {
  const issues: Issue[] = [];
  if (!rule || typeof rule !== 'object') return [{ path, message: 'Choose when to switch.' }];
  const r = rule as Record<string, unknown>;
  const int = (v: unknown, name: string, min: number, max: number) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) issues.push({ path: join(path, name), message: `Enter a whole number from ${min} to ${max}.` });
  };
  switch (r.when) {
    case 'after_turns':
      int(r.k, 'k', 1, Math.max(1, (opts.maxGuesses ?? 6) - 1));
      break;
    case 'candidates_le':
      int(r.n, 'n', 1, 100000);
      break;
    case 'bits_le':
      if (typeof r.h !== 'number' || !Number.isFinite(r.h) || r.h < 0 || r.h > 32) issues.push({ path: join(path, 'h'), message: 'Enter a number of bits from 0 to 32.' });
      break;
    case 'sequence_exhausted':
      break;
    default:
      issues.push({ path, message: 'Unknown switch rule.' });
  }
  return issues;
}

/** Validate a spec against the schemas. Returns every issue found (empty = valid). */
export function validateSpec(spec: unknown, schemas: StrategySchema[], opts: ValidateOptions = {}, path = ''): Issue[] {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return [{ path, message: 'Expected a strategy object with a "kind".' }];
  const s = spec as AnySpec;
  if (typeof s.kind !== 'string') return [{ path, message: 'Missing "kind".' }];
  const schema = schemaFor(s.kind, schemas);
  if (!schema) return [{ path, message: `Unknown strategy kind "${s.kind}".` }];
  const issues: Issue[] = [];
  if (schema.needs?.frequencies && opts.hasFrequencies === false) {
    issues.push({ path, message: `This word list has no frequencies, which ${schema.label} needs.` });
  }
  const known = new Set(schema.params.map((p) => p.name));
  for (const k of Object.keys(s)) if (k !== 'kind' && !known.has(k)) issues.push({ path: join(path, k), message: `Unknown parameter "${k}".` });

  for (const f of schema.params) {
    const v = s[f.name];
    const p = join(path, f.name);
    if (v === undefined) continue; // the solver fills defaults
    const t = f.type;
    switch (t.type) {
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) issues.push({ path: p, message: `${f.label} must be a number.` });
        else if (v < t.min || v > t.max) issues.push({ path: p, message: `${f.label} must be between ${t.min} and ${t.max}.` });
        break;
      case 'integer':
        if (typeof v !== 'number' || !Number.isInteger(v)) issues.push({ path: p, message: `${f.label} must be a whole number.` });
        else if (v < t.min || v > t.max) issues.push({ path: p, message: `${f.label} must be from ${t.min} to ${t.max}.` });
        break;
      case 'boolean':
        if (typeof v !== 'boolean') issues.push({ path: p, message: `${f.label} must be on or off.` });
        break;
      case 'choice':
        if (!t.options.some((o) => o.value === v)) issues.push({ path: p, message: `${f.label} must be one of ${t.options.map((o) => o.value).join(', ')}.` });
        break;
      case 'words': {
        if (!Array.isArray(v) || v.some((w) => typeof w !== 'string')) {
          issues.push({ path: p, message: `${f.label} must be a list of words.` });
          break;
        }
        if (v.length < t.min || v.length > t.max) issues.push({ path: p, message: `${f.label}: give ${t.min === t.max ? t.min : `${t.min} to ${t.max}`} word${t.max === 1 ? '' : 's'}.` });
        const bad = (v as string[]).filter(
          (w) => !/^[a-z]+$/.test(w) || (opts.wordLength !== undefined && w.length !== opts.wordLength) || (opts.guesses !== undefined && !opts.guesses.has(w)),
        );
        if (bad.length) issues.push({ path: p, message: `Not in the guess list: ${bad.map((w) => w.toUpperCase()).join(', ')}.` });
        break;
      }
      case 'strategy':
        issues.push(...validateSpec(v, schemas, opts, p));
        break;
      case 'strategies':
        if (!Array.isArray(v) || v.length === 0) issues.push({ path: p, message: `${f.label}: add at least one strategy.` });
        else v.forEach((x, i) => issues.push(...validateSpec(x, schemas, opts, join(p, i))));
        break;
      case 'weights': {
        if (!Array.isArray(v) || v.some((w) => typeof w !== 'number' || !Number.isFinite(w) || w < 0)) {
          issues.push({ path: p, message: `${f.label} must be non-negative numbers.` });
          break;
        }
        const partner = schema.params.find((x) => x.type.type === 'strategies');
        const list = partner ? s[partner.name] : undefined;
        if (Array.isArray(list) && list.length !== v.length) issues.push({ path: p, message: `Give one weight per strategy (${list.length}).` });
        if ((v as number[]).reduce((a, b) => a + b, 0) <= 0) issues.push({ path: p, message: 'At least one weight must be positive.' });
        break;
      }
      case 'switch_rule':
        issues.push(...validateSwitchRule(v, p, opts));
        break;
    }
  }
  return issues;
}

/** Parse a word list typed by the user: split on commas, spaces and newlines; lowercase. */
export function parseWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,;]+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Cost guard

export interface CostWarning {
  /** Kind of the offending part. */
  kind: string;
  message: string;
  /** Rough run-time estimates in seconds. */
  quickSeconds: number;
  fullSeconds: number;
}

/**
 * Warn when an information-based stochastic strategy scores the full allowed
 * pool: every new state it reaches costs (allowed guesses) × |C| lookups.
 * `globalPool` is the result setting "Stochastic guess pool"; 'allowed' there
 * applies to every information-based stochastic part.
 */
export function costWarnings(
  spec: StrategySpec,
  schemas: StrategySchema[],
  env: { nGuesses: number; nAnswers: number; replicates: number; globalPool?: 'candidates' | 'allowed'; workers?: number },
): CostWarning[] {
  const out: CostWarning[] = [];
  for (const s of walkSpec(spec, schemas)) {
    const a = s as unknown as AnySpec;
    if (a.kind !== 'info_proportional') continue;
    // The "Stochastic guess pool" setting, when 'allowed', overrides every
    // info_proportional pool (app/config.ts applyPoolSetting).
    const pool = env.globalPool === 'allowed' ? 'allowed' : ((a.pool as string | undefined) ?? 'candidates');
    if (pool !== 'allowed') continue;
    const est = (targets: number, r: number) => {
      // About 2.5 fresh states per game after the opener, averaging ~30 candidates,
      // at roughly 2e8 pattern lookups per second per worker.
      const lookups = targets * r * 2.5 * env.nGuesses * 30;
      return lookups / (2e8 * Math.max(1, env.workers ?? 3));
    };
    const quickSeconds = est(Math.min(200, env.nAnswers), 5);
    const fullSeconds = est(env.nAnswers, env.replicates);
    out.push({
      kind: a.kind,
      quickSeconds,
      fullSeconds,
      message: `Information-proportional over all ${env.nGuesses.toLocaleString('en-GB')} allowed guesses scores every guess at every new state. Estimated time: quick check ${fmtDuration(quickSeconds)}, full card ${fmtDuration(fullSeconds)}.`,
    });
  }
  return out;
}

export function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'unknown';
  if (seconds < 60) return `about ${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 3600) return `about ${Math.round(seconds / 60)} min`;
  return `about ${(seconds / 3600).toFixed(seconds < 36000 ? 1 : 0)} h`;
}

// ---------------------------------------------------------------------------
// Hybrid builder: an ordered list of phases compiled to nested `switch` specs.

export interface Phase {
  spec: StrategySpec;
  /** When to move on to the next phase; ignored (null) for the last phase. */
  when: SwitchRule | null;
}

/** Compile phases to a spec: one phase is itself; more nest as switch { first, when, then: rest }. */
export function compilePhases(phases: Phase[]): StrategySpec {
  if (phases.length === 0) throw new Error('A hybrid needs at least one phase.');
  if (phases.length === 1) return clone(phases[0].spec);
  const [head, ...rest] = phases;
  return { kind: 'switch', first: clone(head.spec), when: clone(head.when ?? DEFAULT_SWITCH_RULE), then: compilePhases(rest) };
}

/** Phases of a switch chain (the inverse of compilePhases); a non-switch spec is one phase. */
export function decompilePhases(spec: StrategySpec): Phase[] {
  const out: Phase[] = [];
  let s: StrategySpec = spec;
  while (s.kind === 'switch') {
    out.push({ spec: clone(s.first), when: clone(s.when) });
    s = s.then;
  }
  out.push({ spec: clone(s), when: null });
  return out;
}

/** Move a phase from one index to another (drag and drop, or the move buttons). */
export function movePhase(phases: Phase[], from: number, to: number): Phase[] {
  if (from === to || from < 0 || from >= phases.length || to < 0 || to >= phases.length) return phases.slice();
  const out = phases.slice();
  const [p] = out.splice(from, 1);
  out.splice(to, 0, p);
  // Every phase but the last needs a rule; the last has none.
  return out.map((ph, i) => ({ spec: ph.spec, when: i === out.length - 1 ? null : (ph.when ?? clone(DEFAULT_SWITCH_RULE)) }));
}

export function describeRule(r: SwitchRule | null): string {
  if (!r) return 'until the end';
  switch (r.when) {
    case 'after_turns':
      return `after ${r.k} guess${r.k === 1 ? '' : 'es'}`;
    case 'candidates_le':
      return `once ≤ ${r.n} candidate${r.n === 1 ? '' : 's'} remain`;
    case 'bits_le':
      return `once ≤ ${r.h} bits remain`;
    case 'sequence_exhausted':
      return 'when the sequence runs out';
  }
}

// ---------------------------------------------------------------------------
// Import, export and share links

export interface StrategyDoc {
  label: string;
  colour: string;
  spec: StrategySpec;
}

export type ImportResult = { ok: true; doc: Partial<StrategyDoc> & { spec: StrategySpec } } | { ok: false; error: string };

function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Pretty JSON for export ({ label, colour, spec }). */
export function exportJson(doc: StrategyDoc): string {
  return JSON.stringify({ label: doc.label, colour: doc.colour, spec: doc.spec }, null, 2);
}

export function encodeShare(doc: StrategyDoc): string {
  return b64urlEncode(JSON.stringify({ label: doc.label, colour: doc.colour, spec: doc.spec }));
}

/** The lab share code in a URL hash ("#…&lab=CODE"), or null. */
export function labCodeFromHash(hash: string): string | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of h.split('&')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq) === 'lab') return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

/** A share link: the current page with "lab=CODE" in the hash. */
export function shareUrl(doc: StrategyDoc, base: { origin: string; pathname: string; search?: string }): string {
  return `${base.origin}${base.pathname}${base.search ?? ''}#lab=${encodeShare(doc)}`;
}

function docFromValue(v: unknown): ImportResult {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'Expected a JSON object.' };
  const o = v as Record<string, unknown>;
  if (typeof o.kind === 'string') return { ok: true, doc: { spec: o as unknown as StrategySpec } };
  if (o.spec && typeof o.spec === 'object' && typeof (o.spec as AnySpec).kind === 'string') {
    const label = typeof o.label === 'string' ? o.label : typeof o.name === 'string' ? o.name : undefined;
    const colour = typeof o.colour === 'string' && /^#[0-9a-f]{3,8}$/i.test(o.colour) ? o.colour : undefined;
    return { ok: true, doc: { spec: o.spec as StrategySpec, label, colour } };
  }
  return { ok: false, error: 'No strategy found: expected a spec with a "kind", or an object with a "spec".' };
}

/** Import from pasted text: strategy JSON, a { label, colour, spec } document, a share link or a share code. */
export function parseImport(text: string): ImportResult {
  const t = text.trim();
  if (!t) return { ok: false, error: 'Paste strategy JSON or a share link.' };
  if (t.startsWith('{')) {
    try {
      return docFromValue(JSON.parse(t));
    } catch (e) {
      return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
    }
  }
  const hashAt = t.indexOf('#');
  const code = hashAt >= 0 ? labCodeFromHash(t.slice(hashAt)) : /^[A-Za-z0-9_-]+$/.test(t) ? t : null;
  if (!code) return { ok: false, error: 'Not strategy JSON or a share link.' };
  try {
    return docFromValue(JSON.parse(b64urlDecode(code)));
  } catch {
    return { ok: false, error: 'The share link is damaged.' };
  }
}

// ---------------------------------------------------------------------------
// Saved strategies

export const SAVED_COLOURS = ['#e0457b', '#3a86ff', '#8ac926', '#ff9f1c', '#6a4c93', '#2ec4b6', '#c1121f', '#588157', '#b5838d', '#ffbe0b'];

/** A colour not yet used by `used`, cycling through the palette. */
export function nextColour(used: string[]): string {
  const u = new Set(used.map((c) => c.toLowerCase()));
  return SAVED_COLOURS.find((c) => !u.has(c.toLowerCase())) ?? SAVED_COLOURS[used.length % SAVED_COLOURS.length];
}

export function newSavedId(): string {
  return `saved-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** A label that does not clash with `taken` ("Name", "Name 2", …). */
export function uniqueLabel(base: string, taken: string[]): string {
  const t = new Set(taken);
  if (!t.has(base)) return base;
  for (let i = 2; ; i++) if (!t.has(`${base} ${i}`)) return `${base} ${i}`;
}
