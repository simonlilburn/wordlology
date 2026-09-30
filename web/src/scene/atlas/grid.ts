// Keeping the focused configuration in the atlas grid (pure).
//
// The grid grows only by explicit adds ("+ Strategy", "+ Opener", ranking
// entries, Run full). When the focus moves to a strategy or opener that is
// not in the grid (the side pane, the Lab's "Use"), an axis holding a single
// entry follows the focus (a lone card simply changes), and an axis holding
// several gains the new entry, so nothing the user built is lost.

export interface GridEntry {
  id: string;
}

export interface FocusedGrid<S extends GridEntry> {
  columns: S[];
  rows: (string | null)[];
  /** Whether anything changed (the caller then clears the compare selection). */
  changed: boolean;
}

export function gridWithFocus<S extends GridEntry>(
  columns: readonly S[],
  rows: readonly (string | null)[],
  strategy: S,
  opener: string | null,
): FocusedGrid<S> {
  let cols = columns.slice();
  let rs = rows.slice();
  let changed = false;
  if (!cols.some((c) => c.id === strategy.id)) {
    cols = cols.length === 1 ? [strategy] : [...cols, strategy];
    changed = true;
  }
  if (!rs.includes(opener)) {
    rs = rs.length === 1 ? [opener] : [...rs, opener];
    changed = true;
  }
  return { columns: cols, rows: rs, changed };
}
