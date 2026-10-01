// The Advanced settings table (docs/specification.md, "Advanced settings") as
// data, plus the pure helpers the settings dialog uses: defaults, changed
// checks, answer-list summaries and pasted-list validation.

import type { DisplaySettings, ResultSettings } from '../../app/store.svelte';

export type SettingKind = 'result' | 'display';

export const GROUPS = ['Game', 'Computation', 'Tree', 'Filter', 'Cards', 'Rankings', 'Data'] as const;
export type Group = (typeof GROUPS)[number];

export interface Option {
  value: unknown;
  label: string;
}

export type Control =
  /** A boolean shown as a switch. */
  | { type: 'toggle' }
  /** A few options as a segmented radio group. */
  | { type: 'choice'; options: Option[] }
  /** Many options as a select. */
  | { type: 'select'; options: Option[] }
  /** A number on a slider. */
  | { type: 'range'; min: number; max: number; step: number; unit?: string }
  /** A free number. */
  | { type: 'number'; min?: number; max?: number; step?: number }
  /** A control the dialog builds itself (answer list, strategies, openers, export size). */
  | { type: 'custom' };

interface Base {
  group: Group;
  label: string;
  defaultText: string;
  help?: string;
  control: Control;
}

export type SettingDef =
  | (Base & { kind: 'result'; key: keyof ResultSettings })
  | (Base & { kind: 'display'; key: keyof DisplaySettings });

/** Every row of the specification's Advanced settings table, in order. */
export const SETTINGS: SettingDef[] = [
  // Game
  {
    group: 'Game',
    kind: 'result',
    key: 'maxGuesses',
    label: 'Max guesses',
    defaultText: '6',
    control: { type: 'select', options: [4, 5, 6, 7, 8, 9, 10].map((n) => ({ value: n, label: String(n) })) },
  },
  {
    group: 'Game',
    kind: 'result',
    key: 'hardMode',
    label: 'Hard mode',
    defaultText: 'Off',
    help: 'Every revealed hint must be used in later guesses. Strategies follow it too.',
    control: { type: 'toggle' },
  },
  {
    group: 'Game',
    kind: 'result',
    key: 'answers',
    label: 'Answer list',
    defaultText: '2,500 most frequent words',
    help: 'The words that can be the target.',
    control: { type: 'custom' },
  },
  {
    group: 'Game',
    kind: 'display',
    key: 'zoomOutAfterGame',
    label: 'Zoom out after a game',
    defaultText: 'On',
    help: 'Off keeps you on the board when a game ends.',
    control: { type: 'toggle' },
  },
  {
    group: 'Game',
    kind: 'display',
    key: 'theme',
    label: 'Appearance',
    defaultText: 'Light',
    control: {
      type: 'choice',
      options: [
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
        { value: 'system', label: 'Match system' },
      ],
    },
  },
  {
    group: 'Game',
    kind: 'display',
    key: 'palette',
    label: 'Colour palette',
    defaultText: 'Standard',
    control: {
      type: 'choice',
      options: [
        { value: 'standard', label: 'Standard' },
        { value: 'high-contrast', label: 'High contrast' },
      ],
    },
  },
  {
    group: 'Game',
    kind: 'display',
    key: 'colourBlindMarks',
    label: 'Colour-blind marks',
    defaultText: 'On',
    help: 'A filled dot on correct letters and a ring on present ones, on tiles and keys.',
    control: { type: 'toggle' },
  },
  // Computation
  {
    group: 'Computation',
    kind: 'result',
    key: 'arrivalStrategy',
    label: 'Arrival strategy',
    defaultText: 'Info-proportional, β = 1',
    help: 'The strategy your first game is compared with.',
    control: { type: 'custom' },
  },
  {
    group: 'Computation',
    kind: 'result',
    key: 'stochasticPool',
    label: 'Stochastic guess pool',
    defaultText: 'Candidates',
    help: 'Which guesses information-based stochastic strategies draw from.',
    control: {
      type: 'choice',
      options: [
        { value: 'candidates', label: 'Candidates' },
        { value: 'allowed', label: 'All allowed guesses' },
      ],
    },
  },
  {
    group: 'Computation',
    kind: 'result',
    key: 'replicatesTree',
    label: 'Replicates, Tree view',
    defaultText: '200',
    help: 'Games per target drawn for a stochastic tree.',
    control: {
      type: 'choice',
      options: [50, 200, 1000].map((n) => ({ value: n, label: n.toLocaleString('en') })),
    },
  },
  {
    group: 'Computation',
    kind: 'result',
    key: 'replicatesCard',
    label: 'Replicates per target, cards and Atlas',
    defaultText: '20',
    control: { type: 'range', min: 5, max: 100, step: 5 },
  },
  {
    group: 'Computation',
    kind: 'result',
    key: 'weighting',
    label: 'Target weighting',
    defaultText: 'Equal',
    help: 'Frequency weighting counts each target by its share of total word frequency.',
    control: {
      type: 'choice',
      options: [
        { value: 'equal', label: 'Equal' },
        { value: 'frequency', label: 'Word frequency' },
      ],
    },
  },
  {
    group: 'Computation',
    kind: 'result',
    key: 'baseSeed',
    label: 'Base seed',
    defaultText: '1',
    help: 'Seeds every random draw, so the same seed gives the same games.',
    control: { type: 'number', step: 1 },
  },
  // Tree
  {
    group: 'Tree',
    kind: 'display',
    key: 'counterfactualBranches',
    label: 'Counterfactual branches, deterministic strategies',
    defaultText: 'Off',
    help: 'Dashed paths for the top alternatives at each turn; they carry no mass.',
    control: {
      type: 'select',
      options: [
        { value: 0, label: 'Off' },
        ...[2, 3, 4, 5].map((n) => ({ value: n, label: `Top ${n} alternatives` })),
      ],
    },
  },
  {
    group: 'Tree',
    kind: 'display',
    key: 'growthAnimation',
    label: 'Growth animation',
    defaultText: 'Full',
    control: {
      type: 'choice',
      options: [
        { value: 'full', label: 'Full' },
        { value: 'fast', label: 'Fast' },
        { value: 'off', label: 'Off' },
      ],
    },
  },
  {
    group: 'Tree',
    kind: 'display',
    key: 'labelThreshold',
    label: 'Label threshold',
    defaultText: '10 px',
    help: 'Branches thinner than this show no word label.',
    control: { type: 'range', min: 8, max: 16, step: 1, unit: 'px' },
  },
  {
    group: 'Tree',
    kind: 'display',
    key: 'replayAnnotations',
    label: 'Replay annotations',
    defaultText: 'Off',
    help: 'Candidates, bits, probability and phase beside each replayed row.',
    control: { type: 'toggle' },
  },
  // Filter
  {
    group: 'Filter',
    kind: 'display',
    key: 'yIsVowel',
    label: 'Y counts as a vowel',
    defaultText: 'Off',
    control: { type: 'toggle' },
  },
  {
    group: 'Filter',
    kind: 'display',
    key: 'filterScope',
    label: 'Filter scope',
    defaultText: 'Tree view',
    control: {
      type: 'choice',
      options: [
        { value: 'tree', label: 'Tree view' },
        { value: 'all', label: 'Tree, Card and Atlas' },
      ],
    },
  },
  // Cards
  {
    group: 'Cards',
    kind: 'display',
    key: 'rowBars',
    label: 'Row length bars',
    defaultText: 'On',
    control: { type: 'toggle' },
  },
  {
    group: 'Cards',
    kind: 'display',
    key: 'motion',
    label: 'Motion',
    defaultText: 'Follows the system',
    help: 'Reduced motion replaces transitions with short cross-fades.',
    control: {
      type: 'choice',
      options: [
        { value: 'system', label: 'Follows the system' },
        { value: 'reduced', label: 'Reduced' },
        { value: 'full', label: 'Full' },
      ],
    },
  },
  // Rankings
  {
    group: 'Rankings',
    kind: 'result',
    key: 'rankStrategySet',
    label: 'Strategy set',
    defaultText: 'Every preset and saved strategy',
    control: { type: 'custom' },
  },
  {
    group: 'Rankings',
    kind: 'result',
    key: 'rankOpenerSet',
    label: 'Opener set',
    defaultText: 'Answer list',
    control: { type: 'custom' },
  },
  {
    group: 'Rankings',
    kind: 'result',
    key: 'rankKeep',
    label: 'Full evaluations kept',
    defaultText: '10',
    help: 'How many of the best screened candidates are played in full.',
    control: { type: 'range', min: 5, max: 50, step: 1 },
  },
  {
    group: 'Rankings',
    kind: 'result',
    key: 'rankMetric',
    label: 'Metric',
    defaultText: 'Mean guesses',
    control: {
      type: 'select',
      options: [
        { value: 'mean', label: 'Mean guesses' },
        { value: 'fail_rate', label: 'Fail rate' },
        { value: 'le3', label: 'Share solved in three or fewer' },
        { value: 'mean_fail_plus', label: 'Mean, a failure counting max + 1' },
      ],
    },
  },
  // Data
  {
    group: 'Data',
    kind: 'display',
    key: 'keepPlayerBranches',
    label: 'Player branches',
    defaultText: 'This session only',
    help: 'Your own games, shown as flagged paths in trees.',
    control: {
      type: 'choice',
      options: [
        { value: false, label: 'This session only' },
        { value: true, label: 'Kept in this browser' },
      ],
    },
  },
  {
    group: 'Data',
    kind: 'display',
    key: 'exportWarnRows',
    label: 'Export size warning',
    defaultText: '1 million rows',
    help: 'Ask before an export larger than this.',
    control: { type: 'custom' },
  },
];

/** The settings of a group, in table order. */
export function settingsIn(group: Group): SettingDef[] {
  return SETTINGS.filter((s) => s.group === group);
}

/** Stable DOM id for a setting. */
export function settingId(def: SettingDef): string {
  return `set-${def.kind}-${def.key}`;
}

/** Whether a value equals the default (structural comparison). */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The option whose value equals v, or undefined. */
export function optionIndex(options: Option[], v: unknown): number {
  return options.findIndex((o) => sameValue(o.value, v));
}

// ---------------------------------------------------------------------------
// Answer lists

/** Smallest frequency cutoff offered. */
export const MIN_CUTOFF = 1000;
/** Reviewed answers in the default list (used before the word list has loaded). */
export const FALLBACK_RANKED = 3416;

/** The range of the frequency cutoff: 1,000 up to the ranked list's length. */
export function cutoffRange(rankedLength: number | null | undefined): { min: number; max: number } {
  const max = rankedLength && rankedLength > 0 ? rankedLength : FALLBACK_RANKED;
  return { min: Math.min(MIN_CUTOFF, max), max };
}

export function clampCutoff(n: number, range: { min: number; max: number }): number {
  if (!Number.isFinite(n)) return Math.min(range.max, Math.max(range.min, 2500));
  return Math.min(range.max, Math.max(range.min, Math.round(n)));
}

const nf = new Intl.NumberFormat('en');
export const fmtInt = (n: number): string => nf.format(n);

/** A short description of an answer selection. */
export function answerSummary(a: ResultSettings['answers']): string {
  switch (a.kind) {
    case 'default':
      return '2,500 most frequent words';
    case 'top':
      return `${fmtInt(a.n)} most frequent words`;
    case 'pasted':
      return `A pasted list of ${fmtInt(a.words.length)} ${a.words.length === 1 ? 'word' : 'words'}`;
  }
}

export interface PastedCheck {
  /** Valid words: lowercase, unique, sorted. */
  words: string[];
  /** Words of the right shape that are not in the guess list. */
  unknown: string[];
  /** Entries of the wrong length or with characters other than letters. */
  malformed: string[];
  /** Repeated entries dropped. */
  duplicates: number;
}

/** Split pasted text into words: whitespace, commas and semicolons separate them. */
export function splitWords(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

/** Validate a pasted word list against the guess list. */
export function checkPastedWords(text: string, lexicon: { wordLength: number; index: Map<string, number> }): PastedCheck {
  const seen = new Set<string>();
  const unknown: string[] = [];
  const malformed: string[] = [];
  let duplicates = 0;
  const words: string[] = [];
  for (const raw of splitWords(text)) {
    const w = raw.toLowerCase();
    if (seen.has(w)) {
      duplicates++;
      continue;
    }
    seen.add(w);
    if (w.length !== lexicon.wordLength || !/^[a-z]+$/.test(w)) malformed.push(raw);
    else if (!lexicon.index.has(w)) unknown.push(w);
    else words.push(w);
  }
  words.sort();
  return { words, unknown, malformed, duplicates };
}

/** One-line description of a pasted-list check, for the dialog. */
export function pastedMessage(c: PastedCheck, wordLength: number): string {
  const parts: string[] = [];
  const n = c.words.length;
  parts.push(`${fmtInt(n)} ${n === 1 ? 'word' : 'words'} in the guess list`);
  if (c.unknown.length) parts.push(`${fmtInt(c.unknown.length)} not in the guess list`);
  if (c.malformed.length) parts.push(`${fmtInt(c.malformed.length)} not ${wordLength}-letter words`);
  if (c.duplicates) parts.push(`${fmtInt(c.duplicates)} repeated`);
  return parts.join(', ');
}

/** A short list of rejected words for display ("ABCDE, FGHIJ and 3 more"). */
export function listSome(words: string[], max = 8): string {
  const shown = words.slice(0, max).map((w) => w.toUpperCase());
  const rest = words.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${fmtInt(rest)} more` : shown.join(', ');
}

// ---------------------------------------------------------------------------
// Export size warning

export const EXPORT_WARN_OPTIONS: Option[] = [
  { value: 100_000, label: '100,000 rows' },
  { value: 1_000_000, label: '1 million rows' },
  { value: 10_000_000, label: '10 million rows' },
  { value: 0, label: 'Never warn' },
];

/** Describe an export warning threshold. */
export function exportWarnText(n: number): string {
  if (n <= 0) return 'Never warn';
  if (n % 1_000_000 === 0) return `${fmtInt(n / 1_000_000)} million rows`;
  return `${fmtInt(n)} rows`;
}

/** The message shown after a result setting changes. */
export function recomputeMessage(label: string): string {
  return `${label} changed. Trees and cards recompute progressively; the new settings travel in share links.`;
}
