// Pure helpers for the filter builder: editable drafts of rules and slots, and
// the readout (nodes matched, games touching a match, matches per row).
import type { Game } from '../../backend/types';
import {
  emptyRule,
  formatFilter,
  isEmptyRule,
  matchesNode,
  parseFilter,
  type CompiledFilter,
  type FilterRule,
  type Slot,
} from '../../model/filter';
import type { TargetTree } from '../../model/types';

export type SlotMode = 'any' | 'letter' | 'set' | 'vowel' | 'consonant';

/** One builder slot. `letters` holds the letter (mode 'letter') or the set (mode 'set'), lowercase. */
export interface SlotDraft {
  mode: SlotMode;
  negate: boolean;
  letters: string;
}

export interface RuleDraft {
  slots: SlotDraft[];
  /** Letters the word must contain, as typed (any order). */
  contains: string;
  /** Letters the word must not contain. */
  excludes: string;
  repeated: boolean;
}

export const SLOT_MODES: { value: SlotMode; label: string }[] = [
  { value: 'any', label: 'Any' },
  { value: 'letter', label: 'Letter' },
  { value: 'set', label: 'Set' },
  { value: 'vowel', label: 'Vowel' },
  { value: 'consonant', label: 'Consonant' },
];

export function lettersOnly(s: string): string {
  return [...new Set(s.toLowerCase().replace(/[^a-z]/g, ''))].sort().join('');
}

export function slotToDraft(slot: Slot): SlotDraft {
  const v = slot.value;
  switch (v.kind) {
    case 'any':
      return { mode: 'any', negate: false, letters: '' };
    case 'letter':
      return { mode: 'letter', negate: slot.negate, letters: v.letter };
    case 'set':
      return { mode: 'set', negate: slot.negate, letters: v.letters };
    case 'class':
      return { mode: v.class, negate: slot.negate, letters: '' };
  }
}

export function draftToSlot(d: SlotDraft): Slot {
  switch (d.mode) {
    case 'any':
      return { negate: false, value: { kind: 'any' } };
    case 'letter': {
      const l = lettersOnly(d.letters).slice(0, 1);
      return l ? { negate: d.negate, value: { kind: 'letter', letter: l } } : { negate: false, value: { kind: 'any' } };
    }
    case 'set': {
      const ls = lettersOnly(d.letters);
      if (!ls) return { negate: false, value: { kind: 'any' } };
      if (ls.length === 1) return { negate: d.negate, value: { kind: 'letter', letter: ls } };
      return { negate: d.negate, value: { kind: 'set', letters: ls } };
    }
    case 'vowel':
    case 'consonant':
      return { negate: d.negate, value: { kind: 'class', class: d.mode } };
  }
}

export function ruleToDraft(rule: FilterRule): RuleDraft {
  return {
    slots: rule.slots.map(slotToDraft),
    contains: rule.contains.join('').toUpperCase(),
    excludes: rule.excludes.join('').toUpperCase(),
    repeated: rule.repeated,
  };
}

export function draftToRule(d: RuleDraft): FilterRule {
  return {
    slots: d.slots.map(draftToSlot),
    contains: [...lettersOnly(d.contains)],
    excludes: [...lettersOnly(d.excludes)],
    repeated: d.repeated,
  };
}

export function emptyDraft(wordLength: number): RuleDraft {
  return ruleToDraft(emptyRule(wordLength));
}

/**
 * Canonical filter text for builder drafts. Rules that constrain nothing are
 * dropped; if every rule is empty the text is "" (filter off).
 */
export function draftsToText(drafts: RuleDraft[]): string {
  const rules = drafts.map(draftToRule).filter((r) => !isEmptyRule(r));
  return formatFilter(rules);
}

/** Drafts for a filter text (one empty draft when the text is blank or invalid). */
export function textToDrafts(text: string, wordLength: number): RuleDraft[] {
  if (text.trim() === '') return [emptyDraft(wordLength)];
  const r = parseFilter(text, wordLength);
  if (!r.ok || r.rules.length === 0) return [emptyDraft(wordLength)];
  return r.rules.map(ruleToDraft);
}

/** Short label of a slot for the builder's slot button. */
export function slotLabel(d: SlotDraft): string {
  const neg = d.negate ? 'not ' : '';
  switch (d.mode) {
    case 'any':
      return 'any';
    case 'letter':
      return d.letters ? neg + d.letters.toUpperCase() : 'any';
    case 'set':
      return d.letters ? neg + '{' + d.letters.toUpperCase().split('').join(',') + '}' : 'any';
    case 'vowel':
      return neg + 'vowel';
    case 'consonant':
      return neg + 'consonant';
  }
}

// ---------------------------------------------------------------------------
// Readout

export interface RowReadout {
  /** Guess number (1-based). */
  row: number;
  /** Matching nodes in this row. */
  nodes: number;
  /** Strategy games passing through a matching node in this row. */
  games: number;
}

export interface FilterReadout {
  /** Matching nodes (the root excluded). */
  nodes: number;
  /** Strategy games touching at least one match. */
  games: number;
  /** Strategy games in the tree (R, or fewer while streaming). */
  totalGames: number;
  /** games / totalGames. */
  share: number;
  perRow: RowReadout[];
}

/** Number of strategy games (player games excluded) passing through at least one match. */
export function gamesTouching(games: Game[], guesses: string[], f: CompiledFilter): { touching: number; total: number } {
  let touching = 0;
  let total = 0;
  for (const g of games) {
    if (g.isPlayer) continue;
    total++;
    const n = g.turns.length;
    for (let i = 0; i < n; i++) {
      const word = guesses[g.turns[i].guess];
      if (word !== undefined && matchesNode(f, word, i + 1, g.solved && i === n - 1)) {
        touching++;
        break;
      }
    }
  }
  return { touching, total };
}

/** Readout for the focused tree. `targetWordId` is the tree target's word id (solving guesses are final). */
export function filterReadout(
  tree: TargetTree,
  guesses: string[],
  targetWordId: number,
  f: CompiledFilter,
  maxGuesses: number,
): FilterReadout {
  const perRow: RowReadout[] = Array.from({ length: maxGuesses }, (_, i) => ({ row: i + 1, nodes: 0, games: 0 }));
  let nodes = 0;
  for (const node of tree.nodes) {
    if (!node || node.depth < 1 || node.guess < 0) continue;
    const word = guesses[node.guess];
    if (word === undefined) continue;
    if (matchesNode(f, word, node.depth, node.guess === targetWordId)) {
      nodes++;
      const row = perRow[node.depth - 1];
      if (row) {
        row.nodes++;
        row.games += node.mass;
      }
    }
  }
  const { touching, total } = gamesTouching(tree.games, guesses, f);
  return { nodes, games: touching, totalGames: total, share: total ? touching / total : 0, perRow };
}
