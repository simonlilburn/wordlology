// Animated display nodes: each layout node (matched by its path key) glides
// from where it was drawn to its new place when the layout changes (growth,
// zoom, selection, ellipsis expansion, a new target). New nodes fade in at
// their place; nodes that left the layout fade out where they were.

import type { Layout, LNode } from './layout';

export interface DNode {
  key: string;
  /** Latest layout node (kind, trie node, labels); kept for dying nodes. */
  l: LNode;
  parent: DNode | null;
  x: number;
  y: number;
  /** River into the node: width and offset from the parent's x. */
  rw: number;
  ro: number;
  alpha: number;
  fx: number;
  fy: number;
  frw: number;
  fro: number;
  fa: number;
  tx: number;
  ty: number;
  trw: number;
  tro: number;
  ta: number;
  dying: boolean;
}

export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export class Morph {
  nodes = new Map<string, DNode>();
  /** Draw order: parents before children (live nodes in layout order, then dying ones). */
  order: DNode[] = [];
  private start = 0;
  private dur = 0;
  animating = false;

  /** Adopt a new layout; `dur` 0 jumps. */
  setLayout(layout: Layout, now: number, dur: number): void {
    // Freeze current values as the "from" state.
    for (const d of this.nodes.values()) {
      d.fx = d.x;
      d.fy = d.y;
      d.frw = d.rw;
      d.fro = d.ro;
      d.fa = d.alpha;
    }
    const seen = new Set<string>();
    const order: DNode[] = [];
    for (const l of layout.nodes) {
      seen.add(l.key);
      let d = this.nodes.get(l.key);
      const parent = l.parent ? (this.nodes.get(l.parent.key) ?? null) : null;
      if (!d) {
        // Born: fade in at its place (its river draws on from the parent), so
        // a burst of new nodes never piles up around their parents.
        const px = l.x;
        const py = l.y;
        d = {
          key: l.key,
          l,
          parent,
          x: px,
          y: py,
          rw: l.riverWidth,
          ro: l.riverOffset,
          alpha: 0,
          fx: px,
          fy: py,
          frw: l.riverWidth,
          fro: l.riverOffset,
          fa: 0,
          tx: l.x,
          ty: l.y,
          trw: l.riverWidth,
          tro: l.riverOffset,
          ta: 1,
          dying: false,
        };
        this.nodes.set(l.key, d);
      } else {
        d.l = l;
        d.parent = parent;
        d.tx = l.x;
        d.ty = l.y;
        d.trw = l.riverWidth;
        d.tro = l.riverOffset;
        d.ta = 1;
        d.dying = false;
      }
      order.push(d);
    }
    for (const d of this.nodes.values()) {
      if (seen.has(d.key)) continue;
      if (!d.dying) {
        d.dying = true;
        d.tx = d.x;
        d.ty = d.y;
        d.trw = d.rw;
        d.tro = d.ro;
      }
      d.ta = 0;
      order.push(d);
    }
    this.order = order;
    this.start = now;
    this.dur = dur;
    if (dur <= 0) this.finish();
    else this.animating = true;
  }

  private finish(): void {
    for (const d of this.nodes.values()) {
      d.x = d.tx;
      d.y = d.ty;
      d.rw = d.trw;
      d.ro = d.tro;
      d.alpha = d.ta;
    }
    this.prune();
    this.animating = false;
  }

  private prune(): void {
    let removed = false;
    for (const [k, d] of this.nodes) {
      if (d.dying && d.alpha <= 0.001) {
        this.nodes.delete(k);
        removed = true;
      }
    }
    if (removed) this.order = this.order.filter((d) => this.nodes.has(d.key));
  }

  /** Advance to time `now`; returns true while still moving. */
  step(now: number): boolean {
    if (!this.animating) return false;
    const t = this.dur > 0 ? Math.min(1, (now - this.start) / this.dur) : 1;
    if (t >= 1) {
      this.finish();
      return false;
    }
    const e = easeInOut(t);
    for (const d of this.nodes.values()) {
      d.x = d.fx + (d.tx - d.fx) * e;
      d.y = d.fy + (d.ty - d.fy) * e;
      d.rw = d.frw + (d.trw - d.frw) * e;
      d.ro = d.fro + (d.tro - d.fro) * e;
      d.alpha = d.fa + (d.ta - d.fa) * (d.dying ? t : e);
    }
    return true;
  }

  /** Forget every node (the next layout appears without a morph). */
  clear(): void {
    this.nodes.clear();
    this.order = [];
    this.animating = false;
  }
}
