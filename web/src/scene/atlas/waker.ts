// Wakes the on-demand scene when a watched run changes (games arrive), so
// cards fill progressively without rendering every frame while idle.

import type { Run } from '../../model/types';

export class RunWaker {
  private subs = new Map<Run, () => void>();
  private seen = new Set<Run>();
  wake: () => void = () => {};

  /** Start a frame's watch list. */
  begin(): void {
    this.seen.clear();
  }

  watch(run: Run | null | undefined): void {
    if (!run) return;
    this.seen.add(run);
    if (this.subs.has(run)) return;
    try {
      this.subs.set(
        run,
        run.onChange(() => this.wake()),
      );
    } catch {
      /* run without listeners */
    }
  }

  /** Drop subscriptions to runs not watched this frame. */
  end(): void {
    for (const [run, off] of this.subs) {
      if (!this.seen.has(run)) {
        off();
        this.subs.delete(run);
      }
    }
  }

  dispose(): void {
    for (const off of this.subs.values()) off();
    this.subs.clear();
    this.seen.clear();
  }
}
