// Shareable state in the URL hash. Owned by the platform agent.
//
// #l=2&s=max_info&o=crane&t=k3f&p=1a.2b&f=%3FA%3F%3FY&fm=isolate&x=<preset>
//
//   l   level (0 Game … 3 Atlas; omitted for 0)
//   s   strategy: a catalogue preset id, or "~" + base64url JSON {id,label,colour,spec}
//   o   opener word, or "-" for the strategy's choice
//   t   target as an encoded answer index (does not spoil the word)
//   p   selected path: guess word ids in base 36, joined by "."
//   f   filter text; fc combine (any), fm mode (isolate), fr rows ("2.3"), ff include final ("0")
//   x   non-default settings as a preset: base64url JSON {r: result, d: display}

import { requestSelectPath, selectedPathGuesses } from '../model/focus';
import { applyStrategyFromLink, strategyForLink } from './linkStrategy';
import { changedDisplay, changedResult, mergeSettings, sanitiseDisplay, sanitiseResult } from './settings';
import {
  app,
  DEFAULT_DISPLAY,
  DEFAULT_RESULT,
  type DisplaySettings,
  type FilterState,
  type Level,
  type ResultSettings,
  type StrategyEntry,
} from './store.svelte';
import { currentLevel, jumpTo } from './zoom';

export interface UrlState {
  level?: Level;
  /** A preset id to resolve against the catalogue, or a full entry. */
  strategy?: { presetId: string } | StrategyEntry;
  /** undefined = not in the link; null = the strategy's choice. */
  opener?: string | null;
  target?: number;
  path?: number[];
  filter?: FilterState | null;
  result?: Partial<ResultSettings>;
  display?: Partial<DisplaySettings>;
}

// Target obfuscation: an affine bijection on 16-bit indices, written in base 36.
const MUL = 40503;
const ADD = 23197;
const MOD = 65536;
const INV = modInverse(MUL, MOD);

function modInverse(a: number, m: number): number {
  let [oldR, r] = [a, m];
  let [oldS, s] = [1, 0];
  while (r !== 0) {
    const q = Math.floor(oldR / r);
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return ((oldS % m) + m) % m;
}

function mulMod(a: number, b: number, m: number): number {
  // Exact for a, b < 2^16.
  return Number((BigInt(a) * BigInt(b)) % BigInt(m));
}

/** Encode an answer index so a link does not show the word. */
export function encodeTarget(idx: number): string {
  return ((mulMod(idx, MUL, MOD) + ADD) % MOD).toString(36);
}

/** Decode an encoded target; -1 if malformed. */
export function decodeTarget(code: string): number {
  if (!/^[0-9a-z]{1,4}$/.test(code)) return -1;
  const v = parseInt(code, 36);
  if (!Number.isFinite(v) || v >= MOD) return -1;
  return mulMod((v - ADD + MOD) % MOD, INV, MOD);
}

export function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Serialise a state to a hash (without the leading '#'). */
export function encodeState(s: UrlState): string {
  const p = new URLSearchParams();
  if (s.level) p.set('l', String(s.level));
  if (s.strategy) {
    if ('presetId' in s.strategy) p.set('s', s.strategy.presetId);
    else p.set('s', '~' + base64UrlEncode(JSON.stringify(s.strategy)));
  }
  if (s.opener !== undefined) p.set('o', s.opener ?? '-');
  if (s.target !== undefined && s.target >= 0) p.set('t', encodeTarget(s.target));
  if (s.path && s.path.length) p.set('p', s.path.map((g) => g.toString(36)).join('.'));
  if (s.filter && s.filter.text.trim()) {
    const f = s.filter;
    p.set('f', f.text);
    if (f.combine !== 'all') p.set('fc', f.combine);
    if (f.mode !== 'highlight') p.set('fm', f.mode);
    if (f.rows.length) p.set('fr', f.rows.join('.'));
    if (!f.includeFinal) p.set('ff', '0');
  }
  const preset: Record<string, unknown> = {};
  if (s.result && Object.keys(s.result).length) preset.r = s.result;
  if (s.display && Object.keys(s.display).length) preset.d = s.display;
  if (Object.keys(preset).length) p.set('x', base64UrlEncode(JSON.stringify(preset)));
  return p.toString();
}

/** Parse a hash (with or without '#'); malformed parts are ignored. */
export function decodeState(hash: string): UrlState {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  const p = new URLSearchParams(h);
  const s: UrlState = {};
  const l = Number(p.get('l'));
  if (p.has('l') && Number.isInteger(l) && l >= 0 && l <= 3) s.level = l as Level;
  const st = p.get('s');
  if (st) {
    if (st.startsWith('~')) {
      try {
        const e = JSON.parse(base64UrlDecode(st.slice(1))) as StrategyEntry;
        if (e && e.spec && typeof e.spec.kind === 'string') {
          s.strategy = {
            id: typeof e.id === 'string' ? e.id : 'link',
            label: typeof e.label === 'string' ? e.label : 'Linked strategy',
            colour: typeof e.colour === 'string' ? e.colour : '#7c5cff',
            spec: e.spec,
          };
        }
      } catch {
        /* ignore */
      }
    } else if (/^[\w.-]+$/.test(st)) s.strategy = { presetId: st };
  }
  if (p.has('o')) {
    const o = (p.get('o') ?? '').trim().toLowerCase();
    s.opener = o === '-' || o === '' ? null : /^[a-z]+$/.test(o) ? o : undefined;
    if (s.opener === undefined) delete s.opener;
  }
  if (p.has('t')) {
    const t = decodeTarget(p.get('t')!);
    if (t >= 0) s.target = t;
  }
  const path = p.get('p');
  if (path) {
    const ids = path.split('.').map((x) => parseInt(x, 36));
    if (ids.length && ids.every((x) => Number.isInteger(x) && x >= 0 && x < 65535)) s.path = ids;
  }
  const f = p.get('f');
  if (f) {
    const rows = (p.get('fr') ?? '')
      .split('.')
      .map(Number)
      .filter((x) => Number.isInteger(x) && x >= 1 && x <= 10);
    s.filter = {
      text: f,
      combine: p.get('fc') === 'any' ? 'any' : 'all',
      mode: p.get('fm') === 'isolate' ? 'isolate' : 'highlight',
      rows,
      includeFinal: p.get('ff') !== '0',
    };
  }
  const x = p.get('x');
  if (x) {
    try {
      const preset = JSON.parse(base64UrlDecode(x)) as { r?: Partial<ResultSettings>; d?: Partial<DisplaySettings> };
      if (preset.r && typeof preset.r === 'object') s.result = preset.r;
      if (preset.d && typeof preset.d === 'object') s.display = preset.d;
    } catch {
      /* ignore */
    }
  }
  return s;
}

/** The current app state as a URL state. */
export function currentState(): UrlState {
  const s: UrlState = {};
  const level = currentLevel();
  if (level) s.level = level;
  if (app.focus.strategy) s.strategy = strategyForLink(app.focus.strategy);
  if (app.focus.strategy || app.focus.opener) s.opener = app.focus.opener;
  if (level > 0 && app.focus.target >= 0) s.target = app.focus.target;
  if (level > 0) {
    const path = selectedPathGuesses();
    if (path && path.length) s.path = path;
  }
  if (app.filter && app.filter.text.trim()) s.filter = JSON.parse(JSON.stringify(app.filter)) as FilterState;
  const r = changedResult();
  if (Object.keys(r).length) s.result = JSON.parse(JSON.stringify(r));
  const d = changedDisplay();
  if (Object.keys(d).length) s.display = JSON.parse(JSON.stringify(d));
  return s;
}

/** Apply the settings preset of a link (before the word list loads: it may change the answers). */
export function applySettingsFromState(s: UrlState): void {
  if (s.result) app.result = sanitiseResult(mergeSettings(DEFAULT_RESULT, { ...JSON.parse(JSON.stringify(DEFAULT_RESULT)), ...s.result }));
  if (s.display) app.display = sanitiseDisplay(mergeSettings(DEFAULT_DISPLAY, { ...JSON.parse(JSON.stringify(app.display)), ...s.display }));
}

/** Apply the view parts of a link (after the word list has loaded). */
export function applyViewFromState(s: UrlState): void {
  const n = app.words?.answers.length ?? 0;
  if (s.strategy) {
    applyStrategyFromLink(s.strategy);
    app.arrived = true;
  }
  if (s.opener !== undefined) app.focus.opener = s.opener;
  if (s.target !== undefined && s.target < n) {
    app.focus.target = s.target;
    app.focus.node = -1;
  }
  if (s.filter !== undefined) app.filter = s.filter;
  if (s.path && app.focus.target >= 0) requestSelectPath(app.focus.target, s.path);
  if (s.level !== undefined) jumpTo(s.level);
}

/** A link to the current view. */
export function shareLink(): string {
  const base = typeof location !== 'undefined' ? location.href.split('#')[0] : '';
  const h = encodeState(currentState());
  return h ? `${base}#${h}` : base;
}

let lastWritten = '';
let suspended = false;

/** Write the current state into the address bar (replaceState, no history entry). */
export function writeUrl(): void {
  if (suspended || typeof history === 'undefined' || typeof location === 'undefined') return;
  const h = encodeState(currentState());
  if (h === lastWritten) return;
  lastWritten = h;
  const url = location.href.split('#')[0] + (h ? `#${h}` : '');
  try {
    history.replaceState(history.state, '', url);
  } catch {
    /* sandboxed */
  }
}

/** The state in the current address bar. */
export function readUrl(): UrlState {
  if (typeof location === 'undefined') return {};
  lastWritten = location.hash.replace(/^#/, '');
  return decodeState(location.hash);
}

/** Run `fn` without writing the URL (while restoring). */
export function withoutUrlWrites(fn: () => void): void {
  suspended = true;
  try {
    fn();
  } finally {
    suspended = false;
  }
}
