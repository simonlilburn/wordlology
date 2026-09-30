// Contracts between the views and whatever computes games.
// Mirrors docs/architecture.md; keep the two in sync.

/** Word list manifest as shipped in data/wordlists/<id>/manifest.json. */
export interface WordListManifest {
  id: string;
  name: string;
  version: string;
  word_length: number;
  language?: string;
  answers: string;
  answers_ranked?: string;
  guesses: string;
  frequencies?: string;
  notice?: string;
  licence: string;
  credits: string[];
  counts: Record<string, number>;
  sha256: Record<string, string>;
}

/** Which answers a configuration uses. */
export type AnswerSelection =
  | { kind: 'default' }
  /** The n most frequent reviewed answers (answers-ranked.txt). */
  | { kind: 'top'; n: number }
  /** A pasted list; `sha256` is of the sorted words joined by "\n". */
  | { kind: 'pasted'; sha256: string; words: string[] };

export interface WordListRef {
  id: string;
  version: string;
  answers: AnswerSelection;
}

export interface Rules {
  max_guesses: number;
  hard_mode: boolean;
}

export type Pool = 'candidates' | 'allowed';

export type SwitchRule =
  | { when: 'after_turns'; k: number }
  | { when: 'candidates_le'; n: number }
  | { when: 'bits_le'; h: number }
  | { when: 'sequence_exhausted' };

/** Serde-tagged strategy spec (see crates/wl-strategy/src/spec.rs). */
export type StrategySpec =
  | { kind: 'max_info'; pool?: Pool }
  | { kind: 'most_frequent' }
  | { kind: 'fixed_sequence'; words: string[]; solve_when_one?: boolean }
  | { kind: 'random'; pool?: Pool }
  | { kind: 'info_proportional'; beta?: number; pool?: Pool }
  | { kind: 'freq_proportional'; beta?: number }
  | { kind: 'coverage_then'; switch: SwitchRule; then: StrategySpec }
  | { kind: 'sequence_then'; words: string[]; switch: SwitchRule; then: StrategySpec }
  | { kind: 'switch'; first: StrategySpec; then: StrategySpec; when: SwitchRule }
  | { kind: 'mixture'; weights: number[]; strategies: StrategySpec[] }
  | { kind: 'solve_when_le'; n: number; inner: StrategySpec };

export type Weighting = 'equal' | 'frequency';

/**
 * A configuration: everything that determines the games played.
 * The config ID is a hash of its canonical JSON plus the solver version.
 */
export interface Config {
  word_list: WordListRef;
  rules: Rules;
  strategy: StrategySpec;
  /** Lowercase opener, or null for the strategy's own choice. */
  opener: string | null;
  /** Replicates per target. Deterministic strategies are canonicalised to 1. */
  replicates: number;
  base_seed: number;
  weighting: Weighting;
}

/** Which games of a configuration to play. */
export interface Scope {
  /** Every answer, an explicit list of answer indices, or a seeded sample of n answers. */
  targets: 'all' | number[] | { sample: number };
  /** Half-open replicate range; defaults to [0, config.replicates). */
  replicates?: [number, number];
}

export type Priority = 'focused' | 'visible' | 'background';

export interface RunRequest {
  config: Config;
  scope: Scope;
  priority?: Priority;
}

/** One guess of a game. */
export interface Turn {
  /** Guess word id (index into guesses.txt). */
  guess: number;
  /** Feedback code: sum of c_i * 3^i, c = 0 absent, 1 present, 2 correct. */
  pattern: number;
  candsBefore: number;
  candsAfter: number;
  /** Probability the strategy gave this guess (1 for deterministic choices and openers). */
  pChosen: number;
  /** Expected information of the guess over the candidates before it, in bits. */
  bitsExpected: number;
  /** Index into the strategy's phase labels; 255 = opener, 254 = player. */
  phase: number;
  /** Whether the guess was still a candidate answer. */
  isCandidate: boolean;
}

export interface Game {
  /** Answer index of the target. */
  target: number;
  replicate: number;
  turns: Turn[];
  solved: boolean;
  /** Player games carry no mass in trees. */
  isPlayer?: boolean;
}

export const PHASE_OPENER = 255;
export const PHASE_PLAYER = 254;

export interface GameBatchEvent {
  type: 'games';
  games: Game[];
}

export interface ProgressEvent {
  type: 'progress';
  /** Games finished so far in this run. */
  done: number;
  /** Games the run will play in total. */
  total: number;
  /** Targets finished so far (deterministic and stochastic). */
  targetsDone: number;
  targetsTotal: number;
  /** Deterministic runs: every game ending at or before this guess number is final. */
  settledDepth?: number;
  /** Deterministic runs: games still unresolved. */
  unresolved?: number;
}

export interface SummaryEvent {
  type: 'summary';
  configId: string;
  nGames: number;
  elapsedMs: number;
  /** Phase labels of the strategy, indexed by Turn.phase. */
  phases: string[];
  deterministic: boolean;
}

export type RunEvent = GameBatchEvent | ProgressEvent | SummaryEvent;

export interface StrategySchema {
  kind: string;
  label: string;
  description: string;
  determinism: 'deterministic' | 'stochastic' | 'hybrid';
  needs: { frequencies: boolean };
  params: ParamField[];
}

export interface ParamField {
  name: string;
  label: string;
  help: string;
  type:
    | { type: 'number'; min: number; max: number; step: number }
    | { type: 'integer'; min: number; max: number }
    | { type: 'boolean' }
    | { type: 'choice'; options: { value: string; label: string }[] }
    | { type: 'words'; min: number; max: number }
    | { type: 'strategy' }
    | { type: 'strategies' }
    | { type: 'weights' }
    | { type: 'switch_rule' };
  default: unknown;
}

export interface Preset {
  id: string;
  label: string;
  colour: string;
  spec: StrategySpec;
}

export interface Capabilities {
  solverVersion: string;
  strategies: StrategySchema[];
  presets: Preset[];
  wordLists: string[];
  exactMode: boolean;
  maxReplicates: number;
}

/** Ranked alternatives for a state, for hint chips and annotations. */
export interface ScoresRequest {
  config: Config;
  /** Guesses so far with their feedback codes. */
  history: { guess: number; pattern: number }[];
  topK: number;
}

export interface ScoresResult {
  /** The distribution's top entries: word id, probability (or score for deterministic strategies). */
  entries: { word: number; score: number; p: number }[];
  deterministic: boolean;
  phase: string;
  candidates: number;
}

/** The frontend talks only to a SolverBackend; backends compose. */
export interface SolverBackend {
  id: string;
  capabilities(): Promise<Capabilities>;
  wordLists(): Promise<WordListManifest[]>;
  run(req: RunRequest, signal: AbortSignal): AsyncIterable<RunEvent>;
  /** Strategy scores for a state (hint chip, annotations). Optional for static backends. */
  scores?(req: ScoresRequest, signal?: AbortSignal): Promise<ScoresResult>;
  /** One-step expected information of every allowed guess from the initial state (opener screening). */
  openerInfo?(config: Config, signal?: AbortSignal): Promise<Float64Array>;
  /** Config ID computed exactly as the solver does. */
  configId?(config: Config): Promise<string>;
  /**
   * Continue a game from a prefix with the strategy, using the random stream of
   * (target, replicate). Used by replay's Next button ("a fresh seeded draw").
   */
  continueGame?(req: ContinueRequest, signal?: AbortSignal): Promise<Game>;
}

export interface ContinueRequest {
  config: Config;
  /** Answer index of the target. */
  target: number;
  /** Guesses already made (word ids); their patterns follow from the target. */
  history: number[];
  replicate: number;
  /** Play only the next guess (true) or the rest of the game (false). */
  oneStep: boolean;
}
