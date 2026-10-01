// Fallback strategy schemas and presets, mirroring crates/wl-strategy (schema.rs,
// catalogue.rs). The Lab and the side pane use the backend's capabilities when
// they are available; these keep the forms usable before the solver has loaded
// (and in tests).
import type { ParamField, Preset, StrategySchema } from '../backend/types';

const pool = (def: 'candidates' | 'allowed' = 'candidates'): ParamField => ({
  name: 'pool',
  label: 'Guess pool',
  help: 'Candidates only (fast), or every allowed guess (slow: shows an estimate first).',
  type: {
    type: 'choice',
    options: [
      { value: 'candidates', label: 'Candidates (words still possible)' },
      { value: 'allowed', label: 'All allowed guesses' },
    ],
  },
  default: def,
});

const beta: ParamField = {
  name: 'beta',
  label: 'β',
  help: 'Sharpness: 0 is uniform, higher concentrates on the best words.',
  type: { type: 'number', min: 0, max: 20, step: 0.1 },
  default: 1,
};

const switchRule = (def: unknown): ParamField => ({
  name: 'switch',
  label: 'Switch when',
  help: 'When to hand over to the next strategy.',
  type: { type: 'switch_rule' },
  default: def,
});

const then: ParamField = {
  name: 'then',
  label: 'Then',
  help: 'The strategy that plays after the switch.',
  type: { type: 'strategy' },
  default: { kind: 'max_info', pool: 'candidates' },
};

export const FALLBACK_SCHEMAS: StrategySchema[] = [
  {
    kind: 'max_info',
    label: 'Maximum information',
    description: 'Plays the word with the highest expected information: the entropy of its feedback distribution over the candidates.',
    determinism: 'deterministic',
    needs: { frequencies: false },
    params: [pool()],
  },
  {
    kind: 'most_frequent',
    label: 'Most frequent',
    description: 'Plays the most frequent word still possible.',
    determinism: 'deterministic',
    needs: { frequencies: true },
    params: [],
  },
  {
    kind: 'fixed_sequence',
    label: 'Fixed sequence',
    description: 'Plays a listed sequence of words in order.',
    determinism: 'deterministic',
    needs: { frequencies: false },
    params: [
      { name: 'words', label: 'Words', help: 'Guesses to play in order.', type: { type: 'words', min: 1, max: 10 }, default: ['crane'] },
      {
        name: 'solve_when_one',
        label: 'Solve when one candidate is left',
        help: 'Guess the answer as soon as only one word is possible.',
        type: { type: 'boolean' },
        default: true,
      },
    ],
  },
  {
    kind: 'random',
    label: 'Random',
    description: 'Guesses uniformly at random from the pool.',
    determinism: 'stochastic',
    needs: { frequencies: false },
    params: [pool()],
  },
  {
    kind: 'info_proportional',
    label: 'Information-proportional',
    description: 'Guesses at random with probability proportional to expected information raised to the power β.',
    determinism: 'stochastic',
    needs: { frequencies: false },
    params: [beta, pool()],
  },
  {
    kind: 'freq_proportional',
    label: 'Frequency-proportional',
    description: 'Guesses a candidate at random with probability proportional to its frequency raised to the power β.',
    determinism: 'stochastic',
    needs: { frequencies: true },
    params: [beta],
  },
  {
    kind: 'coverage_then',
    label: 'Letter coverage, then…',
    description: 'Greedily plays words covering the most frequent untested letters (no repeats), then switches.',
    determinism: 'hybrid',
    needs: { frequencies: false },
    params: [switchRule({ when: 'after_turns', k: 2 }), then],
  },
  {
    kind: 'sequence_then',
    label: 'Sequence, then…',
    description: 'Plays a fixed sequence, then switches.',
    determinism: 'hybrid',
    needs: { frequencies: false },
    params: [
      { name: 'words', label: 'Words', help: 'Guesses to play first, in order.', type: { type: 'words', min: 1, max: 10 }, default: ['crane'] },
      switchRule({ when: 'sequence_exhausted' }),
      then,
    ],
  },
  {
    kind: 'switch',
    label: 'Switch',
    description: 'Plays one strategy until a rule fires, then another.',
    determinism: 'hybrid',
    needs: { frequencies: false },
    params: [
      { name: 'first', label: 'First', help: 'The strategy that plays first.', type: { type: 'strategy' }, default: { kind: 'info_proportional', beta: 1, pool: 'candidates' } },
      { ...then, name: 'then' },
      { name: 'when', label: 'Switch when', help: 'When to hand over.', type: { type: 'switch_rule' }, default: { when: 'after_turns', k: 2 } },
    ],
  },
  {
    kind: 'mixture',
    label: 'Mixture',
    description: 'Each turn, picks one of several strategies with probability proportional to its weight (for example ε-greedy).',
    determinism: 'hybrid',
    needs: { frequencies: false },
    params: [
      { name: 'weights', label: 'Weights', help: 'Non-negative weights, one per strategy.', type: { type: 'weights' }, default: [0.9, 0.1] },
      {
        name: 'strategies',
        label: 'Strategies',
        help: 'The strategies to mix.',
        type: { type: 'strategies' },
        default: [
          { kind: 'max_info', pool: 'candidates' },
          { kind: 'random', pool: 'candidates' },
        ],
      },
    ],
  },
  {
    kind: 'solve_when_le',
    label: 'Solve when few left',
    description: 'Guesses from the candidates once at most n are left; otherwise plays the inner strategy.',
    determinism: 'hybrid',
    needs: { frequencies: false },
    params: [
      { name: 'n', label: 'n', help: 'Candidate count at or below which to guess a candidate.', type: { type: 'integer', min: 1, max: 100 }, default: 2 },
      { name: 'inner', label: 'Otherwise', help: 'The strategy used while more candidates remain.', type: { type: 'strategy' }, default: { kind: 'max_info', pool: 'allowed' } },
    ],
  },
];

export const FALLBACK_PRESETS: Preset[] = [
  { id: 'info_proportional', label: 'Info-proportional (β = 1)', colour: '#7c5cff', spec: { kind: 'info_proportional', beta: 1, pool: 'candidates' } },
  { id: 'max_info', label: 'Max information', colour: '#1f9d8b', spec: { kind: 'max_info', pool: 'candidates' } },
  { id: 'max_info_allowed', label: 'Max information (all guesses)', colour: '#0f6b8f', spec: { kind: 'max_info', pool: 'allowed' } },
  { id: 'random', label: 'Random candidate', colour: '#d9822b', spec: { kind: 'random', pool: 'candidates' } },
];

/**
 * The schemas to offer: the backend's when it reports any (it is authoritative:
 * a kind it does not report cannot be built), else the fallback catalogue.
 */
export function effectiveSchemas(fromBackend: StrategySchema[] | null | undefined): StrategySchema[] {
  return fromBackend && fromBackend.length ? fromBackend : FALLBACK_SCHEMAS;
}
