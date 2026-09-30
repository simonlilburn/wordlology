// Phone viewport smoke test (390 × 844): the Game view fits and is playable
// by touch, and at the Tree the side pane becomes a bottom sheet with three
// heights (collapsed, half, full).
import { expect, test, type Page } from '@playwright/test';
import { OPENER, TARGET, openGameAgainst, row, trackPageErrors, waitForBoardIdle, waitForLevel, waitForTree } from './helpers';

const W = 390;
const H = 844;

test.use({ viewport: { width: W, height: H }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });

async function tapWord(page: Page, word: string): Promise<void> {
  await waitForBoardIdle(page);
  for (const ch of word) await page.locator(`[data-key="${ch}"]`).tap();
  await expect.poll(() => page.evaluate(() => window.__wordlology!.app.game.input)).toBe(word);
  await page.locator('[data-key="enter"]').tap();
}

test('phone: game view and bottom sheet', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = trackPageErrors(page);
  await openGameAgainst(page, TARGET, { noGrowth: true });

  // ---- Game view: no horizontal scroll; board, header and keyboard fit the width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(W);
  const boardBox = (await page.locator('[data-board]').boundingBox())!;
  expect(boardBox.x).toBeGreaterThanOrEqual(0);
  expect(boardBox.x + boardBox.width).toBeLessThanOrEqual(W);
  expect(boardBox.y + boardBox.height).toBeLessThanOrEqual(H);
  // Text labels of the header tools collapse to icons, which keep a name (their title) and a 44 px target.
  await expect(page.locator('.tool.text .lab').first()).toBeHidden();
  for (const name of ['Start a game with a new random word', 'Zoom out to the Tree view', 'Settings', 'Help and shortcuts']) {
    const b = page.getByRole('region', { name: 'Game' }).getByRole('button', { name, exact: true });
    await expect(b).toBeVisible();
    const box = (await b.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x + box.width).toBeLessThanOrEqual(W);
  }
  const keys = page.locator('[data-key]');
  expect(await keys.count()).toBe(28);
  for (const box of await keys.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect))) {
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(W);
    expect(box.bottom).toBeLessThanOrEqual(H);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }

  // ---- Play by touch.
  await tapWord(page, OPENER);
  await expect(row(page, 0)).toHaveAttribute('aria-label', 'Guess 1: C, absent; R, absent; A, correct; N, absent; E, correct');
  await tapWord(page, TARGET);
  await page.waitForFunction(() => window.__wordlology!.app.game.board?.status === 'won');

  // ---- Tree: the controls are a bottom sheet.
  await waitForLevel(page, 1);
  await waitForTree(page);
  const sheet = page.locator('aside[data-side-pane]');
  await expect(sheet).toHaveAttribute('data-covers', 'bottom');
  const handle = page.getByRole('button', { name: /^Resize controls sheet/ });
  await expect(handle).toBeVisible();
  await expect(handle).toHaveAttribute('aria-label', 'Resize controls sheet (half)');
  await expect(handle).toHaveAttribute('aria-expanded', 'true');
  await expect(handle).toContainText(OPENER.toUpperCase());
  const height = async () => (await sheet.boundingBox())!.height;
  const sheetBox = (await sheet.boundingBox())!;
  expect(sheetBox.x).toBe(0);
  expect(Math.round(sheetBox.width)).toBe(W);
  expect(Math.round(sheetBox.y + sheetBox.height)).toBe(H);
  expect(await height()).toBeCloseTo(Math.round(H * 0.46), -1);

  // The target browser strip spans the width, and its A–Z strip does not run into the "n / N" counter.
  const browser = page.getByRole('region', { name: 'Target browser' });
  await expect(browser).toBeVisible();
  const overlap = await browser.evaluate((el) => {
    const az = el.querySelector('[aria-label="Jump to letter"]');
    const count = el.querySelector('.count');
    if (!az || !count) return null;
    const letters = [...az.children].map((c) => c.getBoundingClientRect());
    const right = Math.max(...letters.map((r) => r.right));
    return { lettersRight: Math.round(right), countLeft: Math.round(count.getBoundingClientRect().left) };
  });
  if (overlap) expect.soft(overlap.lettersRight, 'A–Z letters end before the counter').toBeLessThanOrEqual(overlap.countLeft);

  // Tapping the handle cycles half → full → collapsed → half.
  await handle.tap();
  await expect(handle).toHaveAttribute('aria-label', 'Resize controls sheet (full)');
  await expect.poll(height).toBeGreaterThan(H * 0.8);
  await handle.tap();
  await expect(handle).toHaveAttribute('aria-label', 'Resize controls sheet (collapsed)');
  await expect(handle).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(height).toBeLessThan(100);
  await handle.tap();
  await expect(handle).toHaveAttribute('aria-label', 'Resize controls sheet (half)');

  // Arrow keys on the handle resize it too.
  await handle.focus();
  await page.keyboard.press('ArrowUp');
  await expect(handle).toHaveAttribute('aria-label', 'Resize controls sheet (full)');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(handle).toHaveAttribute('aria-label', 'Resize controls sheet (collapsed)');

  // The sheet holds the same controls as the side pane.
  await page.keyboard.press('ArrowUp');
  await expect(sheet.getByRole('region', { name: 'Selected path' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: /^Export/ })).toBeAttached();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(W);
  expect(errors).toEqual([]);
});
