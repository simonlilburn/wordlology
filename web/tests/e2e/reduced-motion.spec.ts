// Reduced-motion pass: with prefers-reduced-motion the app replaces its
// transitions with short cross-fades. The journey runs again quickly and each
// level change must finish within about 300 ms.
import { expect, test, type Page } from '@playwright/test';
import { OPENER, TARGET, openGameAgainst, playWord, row, trackPageErrors, waitForLevel, waitForTree } from './helpers';

test.use({ contextOptions: { reducedMotion: 'reduce' } });

/** Allowed time from a level change (zTarget moves) until z arrives. */
const TRANSITION_BUDGET_MS = 300;

/** Record, on every animation frame, when zTarget changes and when z arrives. */
async function startTransitionLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __e2eTransitions: { from: number; to: number; start: number; end: number | null }[] };
    w.__e2eTransitions = [];
    const app = window.__wordlology!.app;
    let target = app.zTarget;
    const tick = (now: number) => {
      if (app.zTarget !== target) {
        w.__e2eTransitions.push({ from: target, to: app.zTarget, start: now, end: app.z === app.zTarget ? now : null });
        target = app.zTarget;
      }
      const last = w.__e2eTransitions[w.__e2eTransitions.length - 1];
      if (last && last.end === null && app.z === last.to) last.end = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function lastTransition(page: Page, to: number): Promise<{ from: number; to: number; ms: number }> {
  await page.waitForFunction(
    (level) => {
      const log = (window as unknown as { __e2eTransitions: { to: number; end: number | null }[] }).__e2eTransitions;
      const last = log[log.length - 1];
      return !!last && last.to === level && last.end !== null;
    },
    to,
    { timeout: 10_000 },
  );
  return page.evaluate(() => {
    const log = (window as unknown as { __e2eTransitions: { from: number; to: number; start: number; end: number }[] }).__e2eTransitions;
    const last = log[log.length - 1];
    return { from: last.from, to: last.to, ms: last.end - last.start };
  });
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
  expect(toTree.ms).toBeLessThanOrEqual(TRANSITION_BUDGET_MS);
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
    const t = await lastTransition(page, to);
    expect(t.ms, `${key} → level ${to} took ${Math.round(t.ms)} ms`).toBeLessThanOrEqual(TRANSITION_BUDGET_MS);
    await waitForLevel(page, to);
  }
  // Back on the Game view the finished board is shown again.
  await expect(row(page, 1)).toHaveAttribute('aria-label', /^Guess 2: S, correct/);
  expect(errors).toEqual([]);
});
