// Accessibility smoke test: every level has a text alternative (specification,
// "Accessibility"): tile labels and row announcements for the Game, a
// navigable outline with counts for the Tree, a distribution table for a Card
// and a table of means for the Atlas.
import { expect, test } from '@playwright/test';
import { OPENER, TARGET, openGameAgainst, playWord, row, trackPageErrors, waitForCard, waitForLevel, waitForTree } from './helpers';

test('text alternatives at every level', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = trackPageErrors(page);
  await openGameAgainst(page, TARGET, { noGrowth: true });

  // ---- Game: the board, rows and tiles are labelled; the keyboard keys too.
  const game = page.getByRole('region', { name: 'Game' });
  await expect(game.getByRole('group', { name: 'Board: 6 rows of 5 letters' })).toBeVisible();
  await expect(game.getByRole('group', { name: 'Keyboard' })).toBeVisible();
  await playWord(page, OPENER);
  const first = game.getByRole('group', { name: /^Guess 1: / });
  await expect(first.getByRole('img')).toHaveCount(5);
  await expect(first.getByRole('img', { name: 'A, correct' })).toBeVisible();
  await expect(first.getByRole('img', { name: 'C, absent' })).toBeVisible();
  await expect(row(page, 1).getByRole('img', { name: 'empty' })).toHaveCount(5);
  await expect(game.getByRole('button', { name: 'E, correct' })).toBeVisible();
  // Touch targets of at least 44 px for the keys.
  const keyBox = await page.locator('[data-key="q"]').boundingBox();
  expect(keyBox!.height).toBeGreaterThanOrEqual(44);
  await playWord(page, TARGET);

  // ---- Tree: an outline of the nodes with their game counts (WAI-ARIA tree).
  await waitForLevel(page, 1);
  await waitForTree(page);
  // The outline toggle (named "Outline" or "Text outline of the tree") controls #tree-outline.
  const toggle = page.locator('button[aria-controls="tree-outline"]');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const tree = page.getByRole('tree', { name: /games? against SLATE/i });
  await expect(tree).toBeVisible();
  const items = tree.getByRole('treeitem');
  expect(await items.count()).toBeGreaterThan(1);
  // Every game opens with CRANE: one level-1 node that carries all 200 games.
  const top = tree.locator('[role="treeitem"][aria-level="1"]');
  await expect(top).toHaveCount(1);
  await expect(top).toHaveAttribute('aria-label', /^Guess 1: CRANE: C absent, R absent, A correct, N absent, E correct; 200 games/);
  await expect(top).toHaveAttribute('aria-expanded', 'true');
  // The player's path is selected, labelled and focused.
  const selected = tree.locator('[role="treeitem"][aria-selected="true"]');
  await expect(selected).toHaveCount(1);
  await expect(selected).toHaveAttribute('aria-level', '2');
  await expect(selected).toHaveAttribute('aria-label', /^Guess 2: SLATE: .*your game/);
  await expect(selected).toBeFocused();
  // Arrow keys move focus; Enter selects another node.
  const before = await page.evaluate(() => window.__wordlology!.app.focus.node);
  await page.keyboard.press('ArrowDown');
  await expect(selected).not.toBeFocused();
  const focusedLabel = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '');
  expect(focusedLabel).toMatch(/^Guess 2: /);
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__wordlology!.app.focus.node)).not.toBe(before);
  await expect(tree.locator('[role="treeitem"][aria-selected="true"]')).toHaveAttribute('aria-label', focusedLabel);
  await page.keyboard.press('Escape'); // closes the outline, not the level
  await expect(tree).toBeHidden();
  expect(await page.evaluate(() => window.__wordlology!.app.zTarget)).toBe(1);

  // ---- Card: a distribution table.
  await page.keyboard.press('-');
  await waitForLevel(page, 2);
  await waitForCard(page);
  const cardTable = page.getByRole('region', { name: 'Card distribution table' }).getByRole('table');
  await expect(cardTable).toBeAttached();
  await expect(cardTable.getByRole('columnheader').first()).toHaveText('Outcome');
  expect((await cardTable.getByRole('columnheader').allTextContents()).map((t) => t.trim()).slice(0, 3)).toEqual(['Outcome', 'Games', 'Share']);
  const rowHeads = cardTable.locator('tbody th[scope="row"]');
  await expect(rowHeads).toHaveText(['Guess 1', 'Guess 2', 'Guess 3', 'Guess 4', 'Guess 5', 'Guess 6', 'Out']);
  await expect(cardTable.getByRole('rowheader', { name: 'Mean guesses' })).toBeAttached();
  await expect(cardTable.locator('caption')).toContainText(OPENER.toUpperCase());
  // The Table button shows it on screen.
  const tools = page.getByRole('toolbar', { name: 'Card and atlas tools' });
  const tableBtn = tools.getByRole('button', { name: 'Table' });
  await tableBtn.click();
  await expect(tableBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(cardTable).toBeVisible();

  // ---- Atlas: a table of means (opener rows × strategy columns).
  await page.keyboard.press('-');
  await waitForLevel(page, 3);
  const means = page.getByRole('region', { name: 'Atlas table of means' }).getByRole('table');
  await expect(means).toBeVisible();
  const strategy = await page.evaluate(() => window.__wordlology!.app.focus.strategy!.label);
  await expect(means.getByRole('columnheader')).toHaveText(['Opener', strategy]);
  await expect(means.getByRole('rowheader', { name: OPENER.toUpperCase() })).toBeVisible();
  // The cell reads "3.88 ± 0.003": the card's mean with its standard error.
  const cell = await means.getByRole('cell').first().innerText();
  const shown = Number(/\d+(?:\.\d+)?/.exec(cell)?.[0]);
  const cardMean = await page.evaluate(() => window.__wordlology!.focusData.card!.snapshot().mean);
  expect(cardMean).toBeGreaterThan(3);
  expect(cardMean).toBeLessThan(5);
  expect(Math.abs(shown - cardMean)).toBeLessThanOrEqual(0.006);

  expect(errors).toEqual([]);
});
