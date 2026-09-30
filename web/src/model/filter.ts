// Letter filter: parser, formatter and matcher (mirrors wl_core::filter). Owned by the panes agent.
// Grammar: docs/architecture.md, "Letter filter".
import type { FilterState } from '../app/store.svelte';

export type SlotKind =
  | { kind: 'any' }
  | { kind: 'letter'; letter: string }
  | { kind: 'set'; letters: string }
  | { kind: 'class'; class: 'vowel' | 'consonant' };

export interface Slot {
  negate: boolean;
  value: SlotKind;
}

export interface FilterRule {
  slots: Slot[];
  contains: string[];
  excludes: string[];
  repeated: boolean;
}

export type ParseResult = { ok: true; rules: FilterRule[] } | { ok: false; error: string; at: number };

export function parseFilter(text: string, wordLength: number): ParseResult {
  throw new Error('not implemented');
}

export function formatRule(rule: FilterRule): string {
  throw new Error('not implemented');
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
}

export function compileFilter(state: FilterState | null, wordLength: number, yIsVowel: boolean): CompiledFilter | null {
  throw new Error('not implemented');
}

/** Whether a word matches the rule set (ignoring scope). */
export function matchesWord(f: CompiledFilter, word: string): boolean {
  throw new Error('not implemented');
}

/** Whether a node (guess `word` at guess number `turn`, `isFinal` if it is a solving guess) matches, honouring scope. */
export function matchesNode(f: CompiledFilter, word: string, turn: number, isFinal: boolean): boolean {
  throw new Error('not implemented');
}
