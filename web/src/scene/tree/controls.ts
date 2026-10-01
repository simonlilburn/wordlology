// Imperative controls for the Tree view's DOM overlays (zoom buttons, Skip,
// minimap, tooltip). The tree layer registers the implementation.

import { openReplay } from '../../app/actions';
import { focusData } from '../../model/focus';
import type { TrieNode } from '../../model/types';

export interface TreeControlHandle {
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
  skip(): void;
  /** Centre the view on a world point (minimap). */
  panTo(wx: number, wy: number, animate: boolean): void;
  /** Close the pinned tooltip. */
  unpin(): void;
  /** Expand the ellipsis under a node (tooltip button). */
  expand(parentNode: number): void;
  /** Bring a node into view and pin its tooltip (outline). */
  reveal(nodeId: number): void;
}

let handle: TreeControlHandle | null = null;

export function registerTreeControls(h: TreeControlHandle | null): void {
  handle = h;
}

function call(fn: (h: TreeControlHandle) => void): void {
  if (!handle) return;
  try {
    fn(handle);
  } catch (e) {
    console.warn('[tree]', e);
  }
}

export const treeControls = {
  zoomIn: () => call((h) => h.zoomIn()),
  zoomOut: () => call((h) => h.zoomOut()),
  fit: () => call((h) => h.fit()),
  skip: () => call((h) => h.skip()),
  panTo: (wx: number, wy: number, animate = false) => call((h) => h.panTo(wx, wy, animate)),
  unpin: () => call((h) => h.unpin()),
  expand: (parentNode: number) => call((h) => h.expand(parentNode)),
  reveal: (nodeId: number) => call((h) => h.reveal(nodeId)),
};

/** Nodes from the first guess down to `node`. */
export function nodePath(node: TrieNode): TrieNode[] {
  const out: TrieNode[] = [];
  for (let n: TrieNode | null = node; n && n.parent; n = n.parent) out.push(n);
  return out.reverse();
}

/** Open the path ending at a node of the focused tree in replay mode. */
export function playNode(nodeId: number): void {
  const tree = focusData.tree;
  if (!tree || nodeId < 0 || nodeId >= tree.nodes.length) return;
  const path = nodePath(tree.nodes[nodeId]);
  if (!path.length) return;
  try {
    openReplay({
      target: tree.target,
      guesses: path.map((n) => n.guess),
      patterns: path.map((n) => n.pattern),
      config: focusData.treeRun?.config ?? null,
    });
  } catch (e) {
    console.warn('[tree] replay', e);
  }
}
