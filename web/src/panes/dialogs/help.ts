// Shortcut help: the specification's key table merged with the shortcuts other
// areas register at run time (app/keyboard.ts).

export interface HelpRow {
  keys: string[];
  action: string;
  /** Where it works, if not everywhere. */
  where?: string;
}

/** The specification's keyboard table (docs/specification.md, "Keyboard"), plus Esc and ;. */
export const SPEC_SHORTCUTS: HelpRow[] = [
  { keys: ['A–Z', 'Enter', 'Backspace'], action: 'Play a guess', where: 'Game view' },
  { keys: ['←', '→'], action: 'Scrub a replay', where: 'Game view, replaying' },
  { keys: ['−', '='], action: 'Zoom out or in one level' },
  { keys: ['Esc'], action: 'Zoom out one level, or close a dialog' },
  { keys: [',', '.'], action: 'Previous or next target' },
  { keys: ['/'], action: 'Target search' },
  { keys: ['F'], action: 'Letter filter', where: 'outside the Game view' },
  { keys: ['S', 'O'], action: 'Strategy, opener', where: 'outside the Game view' },
  { keys: ['E'], action: 'Export', where: 'outside the Game view' },
  { keys: [';'], action: 'Settings', where: 'outside the Game view' },
  { keys: ['?'], action: 'Shortcut help' },
];

const KEY_NAMES: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Escape: 'Esc',
  ' ': 'Space',
  '-': '−',
  '+': '+',
};

/** A KeyboardEvent.key as shown in the table. */
export function keyName(key: string): string {
  if (KEY_NAMES[key]) return KEY_NAMES[key];
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/** Keys (as shown) already covered by the specification's table. */
function coveredKeys(): Set<string> {
  const s = new Set<string>();
  for (const r of SPEC_SHORTCUTS) for (const k of r.keys) s.add(k);
  for (const k of ['Enter', 'Backspace', '+', '_']) s.add(k);
  return s;
}

/**
 * Registered shortcuts that the specification's table does not already list,
 * as help rows (deduplicated by description and keys).
 */
export function extraShortcuts(registered: { keys: string[]; description: string }[]): HelpRow[] {
  const covered = coveredKeys();
  const seen = new Set<string>();
  const out: HelpRow[] = [];
  for (const s of registered) {
    const names = [...new Set(s.keys.map(keyName))];
    if (!names.length || names.every((k) => covered.has(k))) continue;
    const id = `${s.description}|${names.join(' ')}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ keys: names, action: s.description });
  }
  return out;
}

/** The four levels, for the help dialog. */
export const LEVELS: { n: number; name: string; text: string }[] = [
  {
    n: 0,
    name: 'Game',
    text: 'One target and one sequence of guesses: the board and keyboard. Opened from a higher level, it replays a path you can scrub, continue with Next, or branch from.',
  },
  {
    n: 1,
    name: 'Tree',
    text: 'Every game a strategy plays against one target, drawn as a tree from a shared opener. Thicker branches are more likely; your own games appear as flagged paths.',
  },
  {
    n: 2,
    name: 'Card',
    text: 'The same strategy and opener over every target: the distribution of guesses needed, filled in progressively as games are played.',
  },
  {
    n: 3,
    name: 'Atlas',
    text: 'A grid of cards, strategies by openers, for comparing them side by side and ranking them.',
  },
];
