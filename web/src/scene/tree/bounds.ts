// Owned by the scene/tree agent.
// The tree layer records the focused tree's world rectangle here each time it
// lays the tree out, so the Tree → Card transition can start from it.

let current: { x: number; y: number; width: number; height: number } | null = null;

/** Called by the tree layer (null when no tree is drawn). */
export function setTreeBounds(b: { x: number; y: number; width: number; height: number } | null): void {
  current = b ? { ...b } : null;
}

/** World rectangle of the focused tree (CSS px at scale 1), or null if none is drawn. */
export function treeBounds(): { x: number; y: number; width: number; height: number } | null {
  return current ? { ...current } : null;
}
