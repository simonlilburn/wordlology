// Screenshot diffs per level (Game, Tree, Card, Atlas). The growth animation is
// off and motion reduced so each level renders a stable final frame; areas
// that fill in the background (the target browser's thumbnails, toasts,
// computing status) are masked. Regenerate with `npx playwright test levels --update-snapshots`.
import { expect, test, type Page } from '@playwright/test';
import { OPENER, TARGET, openGameAgainst, playWord, settleFrames, waitForBoardIdle, waitForCard, waitForLevel, waitForTree } from './helpers';

test.use({ contextOptions: { reducedMotion: 'reduce' } });

function volatile(page: Page) {
  return [
    page.locator('section[aria-label="Target browser"]'),
    page.locator('.toasts'),
    page.locator('[role="status"]'),
  ];
}

test('each level matches its screenshot', async ({ page }) => {
  test.setTimeout(150_000);
  await openGameAgainst(page, TARGET, { noGrowth: true });
  expect(await page.evaluate(() => window.__wordlology!.app.reducedMotion)).toBe(true);

  // Game: one row played, the keyboard coloured.
  await playWord(page, OPENER);
  await page.waitForFunction(() => window.__wordlology!.app.game.board?.guesses.length === 1);
  await waitForBoardIdle(page);
  await expect(page).toHaveScreenshot('game.png', { mask: volatile(page) });

  // Tree: the finished tree against SLATE with the player's path selected.
  await playWord(page, TARGET);
  await waitForLevel(page, 1);
  await waitForTree(page);
  await page.waitForFunction(() => window.__wordlology!.app.focus.node >= 0);
  await settleFrames(page);
  await expect(page).toHaveScreenshot('tree.png', { mask: volatile(page), timeout: 30_000 });

  // Card: the complete card for info-proportional with CRANE.
  await page.keyboard.press('-');
  await waitForLevel(page, 2);
  await waitForCard(page);
  await settleFrames(page);
  await expect(page).toHaveScreenshot('card.png', { mask: volatile(page), timeout: 30_000 });

  // Atlas: a one-cell grid with its headers and dashed add cards.
  await page.keyboard.press('-');
  await waitForLevel(page, 3);
  await settleFrames(page);
  await expect(page).toHaveScreenshot('atlas.png', { mask: volatile(page), timeout: 30_000 });
});
