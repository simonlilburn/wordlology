// Reduced-motion pass: with prefers-reduced-motion the app replaces its
// transitions with short cross-fades. The journey runs again quickly and each
// level change must finish within about 300 ms.
import { expect, test, type Page } from '@playwright/test';
import { OPENER, TARGET, openGameAgainst, playWord, row, trackPageErrors, waitForLevel, waitForTree } from './helpers';

test.use({ contextOptions: { reducedMotion: 'reduce' } });

/**
 * Allowed animation time from a level change (zTarget moves) until z arrives.
 * Measured as the sum of frame intervals, capped as the zoom animation caps
 * them (16 ms for the first frame, then 64 ms): SwiftShader renders some frames in several hundred
 * milliseconds, so wall-clock time is recorded (as an annotation) but only
 * asserted with E2E_STRICT_TIMING=1 on machines with a GPU. The default
 * spring needs well over a second of animation time for one level.
 */
const TRANSITION_BUDGET_MS = 300;
const STRICT_WALL_CLOCK = process.env.E2E_STRICT_TIMING === '1';

interface Transition {
  from: number;
  to: number;
  /** Wall-clock ms from the change to arrival. */
  wall: number;
  /** Animation ms: frame intervals capped at 64 ms. */
  anim: number;
  frames: number;
}

/** Record, on every animation frame, when zTarget changes and when z arrives. */
async function startTransitionLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    type T = { from: number; to: number; start: number; last: number; anim: number; frames: number; end: number | null };
    const w = window as unknown as { __e2eTransitions: T[] };
    w.__e2eTransitions = [];
    const app = window.__wordlology!.app;
    let target = app.zTarget;
    const tick = (now: number) => {
      const cur = w.__e2eTransitions[w.__e2eTransitions.length - 1];
      if (cur && cur.end === null) {
        // The zoom animation counts its first frame as 16 ms and caps later ones at 64 ms.
        cur.anim += Math.min(cur.frames === 0 ? 16 : 64, now - cur.last);
        cur.last = now;
        cur.frames++;
        if (app.z === cur.to) cur.end = now;
      }
      if (app.zTarget !== target) {
        const done = app.z === app.zTarget;
        w.__e2eTransitions.push({ from: target, to: app.zTarget, start: now, last: now, anim: 0, frames: 0, end: done ? now : null });
        target = app.zTarget;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function lastTransition(page: Page, to: number): Promise<Transition> {
  await page.waitForFunction(
    (level) => {
      const log = (window as unknown as { __e2eTransitions: { to: number; end: number | null }[] }).__e2eTransitions;
      const last = log[log.length - 1];
      return !!last && last.to === level && last.end !== null;
    },
    to,
    { timeout: 15_000 },
  );
  return page.evaluate(() => {
    type T = { from: number; to: number; start: number; anim: number; frames: number; end: number };
    const log = (window as unknown as { __e2eTransitions: T[] }).__e2eTransitions;
    const t = log[log.length - 1];
    return { from: t.from, to: t.to, wall: t.end - t.start, anim: t.anim, frames: t.frames };
  });
}

function checkTransition(t: Transition, label: string): void {
  test.info().annotations.push({
    type: 'transition',
    description: `${label}: ${Math.round(t.anim)} ms animation, ${Math.round(t.wall)} ms wall clock, ${t.frames} frames`,
  });
  expect(t.anim, `${label}: animation time`).toBeLessThanOrEqual(TRANSITION_BUDGET_MS);
  if (STRICT_WALL_CLOCK) expect(t.wall, `${label}: wall clock`).toBeLessThanOrEqual(TRANSITION_BUDGET_MS);
}

test('reduced motion: quick cross-fades between levels', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = trackPageErrors(page);
  await openGameAgainst(page, TARGET, { noGrowth: true });

  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  expect(await page.evaluate(() => window.__wordlology!.app.reducedMotion)).toBe(true);
  await expect(page.locator('.shell')).toHaveClass(/\breduced-motion\b/);
  await startTransitionLog(page);

  // No tile flip: the row is coloured at once and the next guess can follow immediately.
  await page.keyboard.type(OPENER);
  await page.keyboard.press('Enter');
  await expect(row(page, 0)).toHaveAttribute('aria-label', /^Guess 1: C, absent/);
  const running = await page
    .locator('[data-board]')
    .evaluate((b) => b.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length);
  expect(running).toBe(0);
  await playWord(page, TARGET);
  await page.waitForFunction(() => window.__wordlology!.app.game.board?.status === 'won');

  // Game → Tree after the win.
  await waitForLevel(page, 1);
  const toTree = await lastTransition(page, 1);
  expect(toTree.from).toBe(0);
  checkTransition(toTree, 'Game → Tree after the win');
  await waitForTree(page);

  // Tree → Card → Atlas and back, one level at a time.
  const steps: [string, number][] = [
    ['-', 2],
    ['-', 3],
    ['=', 2],
    ['Escape', 3],
    ['=', 2],
    ['=', 1],
    ['=', 0],
  ];
  for (const [key, to] of steps) {
    await page.keyboard.press(key);
    checkTransition(await lastTransition(page, to), `${key} → level ${to}`);
    await waitForLevel(page, to);
  }
  // Back on the Game view the finished board is shown again.
  await expect(row(page, 1)).toHaveAttribute('aria-label', /^Guess 2: S, correct/);
  expect(errors).toEqual([]);
});
