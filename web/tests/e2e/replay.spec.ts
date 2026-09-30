// Replay: a path selected in the Tree opens on the board, where ← / → scrub
// it, Next plays the path's next guess (or draws the strategy's), and the hint
// chip plays the strategy's most likely guess, branching the path.
import { expect, test, type Page } from '@playwright/test';
import { OPENER, TARGET, openGameAgainst, row, trackPageErrors, waitForLevel, waitForTree, winInTwo } from './helpers';

const replayState = (page: Page) =>
  page.evaluate(() => {
    const { app } = window.__wordlology!;
    const w = app.words!;
    return {
      active: app.replay.active,
      cursor: app.replay.cursor,
      guesses: app.replay.guesses.map((g) => w.guesses[g]),
      target: app.replay.target,
    };
  });

test('replay a tree path: scrub, Next and the hint chip', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = trackPageErrors(page);
  const target = await openGameAgainst(page, TARGET, { noGrowth: true });
  await winInTwo(page);
  await waitForLevel(page, 1);
  await waitForTree(page);

  // The player's path is selected on arrival; the side pane offers Play.
  const readout = page.getByRole('region', { name: 'Selected path' });
  await expect(readout).toBeVisible();
  await readout.getByRole('button', { name: /Play/ }).click();

  // Replay opens on the board at the end of the path.
  await waitForLevel(page, 0);
  expect(await replayState(page)).toEqual({ active: true, cursor: 2, guesses: [OPENER, TARGET], target });
  const controls = page.getByRole('group', { name: 'Replay controls' });
  await expect(controls).toBeVisible();
  const slider = controls.getByRole('slider', { name: 'Replay position' });
  await expect(slider).toHaveAttribute('aria-valuemax', '2');
  await expect(slider).toHaveAttribute('aria-valuenow', '2');
  await expect(slider).toHaveAttribute('aria-valuetext', 'After guess 2 of 2, SLATE');
  const next = controls.getByRole('button', { name: /^Next/ });
  await expect(next).toBeDisabled(); // the path ends solved

  // ← and → scrub (window shortcuts in the Game view).
  await page.keyboard.press('ArrowLeft');
  await expect(slider).toHaveAttribute('aria-valuenow', '1');
  await expect(row(page, 1)).toHaveAttribute('aria-label', /^Guess 2 \(after the replay cursor\): S, correct/);
  await expect(page.locator('section[aria-label="Game"] [aria-live="polite"]')).toHaveText(/^After guess 1 of 2\. Guess 1, CRANE:/);
  await page.keyboard.press('ArrowLeft');
  await expect(slider).toHaveAttribute('aria-valuenow', '0');
  await expect(slider).toHaveAttribute('aria-valuetext', 'Start, before guess 1 of 2');
  await page.keyboard.press('ArrowLeft'); // clamped at the start
  await expect(slider).toHaveAttribute('aria-valuenow', '0');
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuenow', '1');
  // The slider itself also takes arrow keys when focused.
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuenow', '2');
  await page.keyboard.press('ArrowLeft');
  await expect(slider).toHaveAttribute('aria-valuenow', '1');
  await expect(row(page, 0)).toHaveAttribute('aria-label', 'Guess 1: C, absent; R, absent; A, correct; N, absent; E, correct');

  // Next plays the path's own next guess.
  await expect(next).toBeEnabled();
  await next.click();
  await expect(slider).toHaveAttribute('aria-valuenow', '2');
  await expect(row(page, 1)).toHaveAttribute('aria-label', /^Guess 2: S, correct/);
  await expect(next).toBeDisabled();

  // Back to guess 1: the hint chip offers the strategy's most likely guess.
  await page.keyboard.press('ArrowLeft');
  await expect(slider).toHaveAttribute('aria-valuenow', '1');
  const hint = controls.getByRole('button', { name: /^Hint: the strategy would play [A-Z]{5}/ });
  await expect(hint).toBeVisible({ timeout: 20_000 });
  const hintLabel = (await hint.getAttribute('aria-label')) ?? '';
  const hintWord = /would play ([A-Z]{5})/.exec(hintLabel)![1].toLowerCase();
  await hint.click();
  await expect(slider).toHaveAttribute('aria-valuenow', '2');
  let state = await replayState(page);
  expect(state.guesses.slice(0, 2)).toEqual([OPENER, hintWord]);

  if (hintWord !== TARGET) {
    // A different word branches the path; Next then draws the strategy's move.
    await expect(controls).toContainText('your branch from guess 2');
    await expect(next).toBeEnabled();
    await next.click();
    await expect.poll(async () => (await replayState(page)).guesses.length, { timeout: 20_000 }).toBe(3);
    state = await replayState(page);
    expect(state.cursor).toBe(3);
    await expect(slider).toHaveAttribute('aria-valuemax', '3');
    await expect(row(page, 2)).toHaveAttribute('aria-label', new RegExp(`^Guess 3: ${state.guesses[2][0].toUpperCase()}, `));
  } else {
    await expect(next).toBeDisabled();
  }
  expect(errors).toEqual([]);
});
