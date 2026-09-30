// The runs, tree and card for the configuration in focus. Owned by the platform agent.
// Updated when app.focus, app.result or the word list change.
import type { CardAccumulator } from './card';
import type { Run, TargetTree } from './types';

export interface FocusData {
  /** Tree run for (focused strategy, opener, target) at the Tree view replicate count. */
  treeRun: Run | null;
  tree: TargetTree | null;
  /** Card run for (focused strategy, opener) over every target at the card replicate count. */
  cardRun: Run | null;
  card: CardAccumulator | null;
  /** Increments whenever any of the above is replaced. */
  version: number;
}

export const focusData: FocusData = { treeRun: null, tree: null, cardRun: null, card: null, version: 0 };
