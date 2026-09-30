// Global keyboard shortcuts. Owned by the platform agent.
export interface Shortcut {
  /** KeyboardEvent.key values, e.g. ['f', 'F'] or ['ArrowLeft']. */
  keys: string[];
  description: string;
  /** Only active when this returns true (default: always). */
  when?: () => boolean;
  handler: (e: KeyboardEvent) => void;
}

/** Register a shortcut; returns an unregister function. Letter shortcuts are inactive in the Game view. */
export function registerShortcut(s: Shortcut): () => void {
  return () => {};
}

/** All registered shortcuts, for the help dialog. */
export function listShortcuts(): Shortcut[] {
  return [];
}
