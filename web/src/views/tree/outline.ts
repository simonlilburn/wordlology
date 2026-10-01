// The Tree view's text alternative as a flat ARIA tree: the visible rows
// (children of expanded nodes, heaviest first) and keyboard navigation. Pure.

import type { TrieNode } from '../../model/types';

export interface OutlineRow {
  node: TrieNode;
  level: number;
  setsize: number;
  posinset: number;
  expandable: boolean;
  expanded: boolean;
}

/** Visible rows: every child of the root, and the children of expanded nodes, depth first. */
export function flattenOutline(root: TrieNode, expanded: ReadonlySet<number>, childrenOf: (n: TrieNode) => readonly TrieNode[], limit = 5000): OutlineRow[] {
  const out: OutlineRow[] = [];
  const walk = (n: TrieNode, level: number) => {
    const kids = childrenOf(n);
    for (let i = 0; i < kids.length && out.length < limit; i++) {
      const c = kids[i];
      const expandable = c.children.length > 0;
      const open = expandable && expanded.has(c.id);
      out.push({ node: c, level, setsize: kids.length, posinset: i + 1, expandable, expanded: open });
      if (open) walk(c, level + 1);
    }
  };
  walk(root, 1);
  return out;
}

export type OutlineKeyResult =
  | { kind: 'focus'; index: number }
  | { kind: 'expand'; id: number }
  | { kind: 'collapse'; id: number; index: number }
  | { kind: 'select'; id: number }
  | { kind: 'play'; id: number }
  | null;

/** What a key does on row `i` (WAI-ARIA tree pattern). */
export function outlineKey(rows: readonly OutlineRow[], i: number, key: string, shift: boolean): OutlineKeyResult {
  const row = rows[i];
  if (!row) return rows.length ? { kind: 'focus', index: 0 } : null;
  switch (key) {
    case 'ArrowDown':
      return { kind: 'focus', index: Math.min(rows.length - 1, i + 1) };
    case 'ArrowUp':
      return { kind: 'focus', index: Math.max(0, i - 1) };
    case 'Home':
      return { kind: 'focus', index: 0 };
    case 'End':
      return { kind: 'focus', index: rows.length - 1 };
    case 'ArrowRight':
      if (row.expandable && !row.expanded) return { kind: 'expand', id: row.node.id };
      if (row.expanded && rows[i + 1]) return { kind: 'focus', index: i + 1 };
      return null;
    case 'ArrowLeft': {
      if (row.expanded) return { kind: 'collapse', id: row.node.id, index: i };
      for (let j = i - 1; j >= 0; j--) if (rows[j].level < row.level) return { kind: 'focus', index: j };
      return null;
    }
    case 'Enter':
      return shift ? { kind: 'play', id: row.node.id } : { kind: 'select', id: row.node.id };
    case ' ':
      return { kind: 'select', id: row.node.id };
    default:
      return null;
  }
}
