// The specification's UI journey: play → tree → card → atlas → export.
import { expect, test, type Page } from '@playwright/test';
import {
  LEVEL_FILES,
  OPENER,
  SPEC_COLUMNS,
  TARGET,
  board,
  csvRows,
  openGameAgainst,
  playWord,
  readDownload,
  row,
  topDialog,
  trackPageErrors,
  unzipText,
  waitForBoardIdle,
  waitForCard,
  waitForLevel,
  waitForTree,
} from './helpers';

type Level = 'tree' | 'card' | 'atlas';

/** Open the export dialog (E by default), download the zip and check its files against the specification. */
async function exportAndCheck(
  page: Page,
  level: Level,
  open: () => Promise<void> = () => page.keyboard.press('e'),
): Promise<{ fileName: string; files: Record<string, string> }> {
  await open();
  const dialog = await topDialog(page, 'Export');
  const levels = dialog.getByRole('radiogroup', { name: 'Level to export' });
  await expect(levels.getByRole('radio', { name: level[0].toUpperCase() + level.slice(1) })).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.getByText(/About [\d,]+ rows/)).toBeVisible();
  // The runs are finished, so this is not a partial export.
  await expect(dialog.locator('[data-partial]')).toHaveCount(0);

  const downloadPromise = page.waitForEvent('download');
  await dialog.locator('[data-export-go]').click();
  const download = await downloadPromise;
  const fileName = download.suggestedFilename();
  expect(fileName).toMatch(new RegExp(`^wordlology-${level}-\\d{8}-\\d{4}\\.zip$`));
  const files = unzipText(await readDownload(download));
  expect(Object.keys(files).sort()).toEqual([...LEVEL_FILES[level]].sort());

  for (const [name, text] of Object.entries(files)) {
    expect(text.startsWith('#'), `${name} has no comment lines`).toBe(false);
    const { header, rows } = csvRows(text);
    const want = SPEC_COLUMNS[name];
    if (name === 'configs.csv') {
      // Partial-export bookkeeping (complete, targets_finished) and more may follow the spec's columns.
      expect(header.slice(0, want.length), name).toEqual(want);
      expect(rows).toHaveLength(1);
      const cfg = Object.fromEntries(header.map((h, i) => [h, rows[0][i]]));
      expect(cfg.opener).toBe(OPENER);
      expect(cfg.max_guesses).toBe('6');
      expect(cfg.hard_mode).toBe('FALSE');
      expect(cfg.exported_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      if ('complete' in cfg) expect(cfg.complete).toBe('TRUE');
      expect(cfg.word_list_id).toBe('open-en-5');
      expect(cfg.replicates).toBe(level === 'tree' ? '200' : '20');
      expect(cfg.base_seed).toBe('1');
      expect(cfg.filter).toBe('NA');
      expect(cfg.solver_version).not.toMatch(/^(NA|)$/);
      expect(cfg.app_version).not.toMatch(/^(NA|)$/);
      expect(() => JSON.parse(cfg.strategy_json)).not.toThrow();
    } else {
      expect(header, name).toEqual(want);
    }
    for (const r of rows.slice(0, 50)) expect(r, `${name} row width`).toHaveLength(header.length);
  }

  // Copy R code: a snippet for the exact zip just exported.
  const copy = page.locator('[data-copy-r]');
  await expect(copy).toBeVisible();
  await expect(dialog.getByLabel('R code')).toContainText(fileName);
  await copy.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(fileName);
  const snippet = await page.evaluate(() => navigator.clipboard.readText());
  expect(snippet).toContain('unzip(zip, exdir = dir)');
  expect(snippet).toContain('read_csv(file.path(dir, "games.csv")');
  await expect(page.getByRole('status').filter({ hasText: `R code copied for ${fileName}` })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Export' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__wordlology!.app.ui.exportDialog)).toBe(false);
  return { fileName, files };
}

test('play → tree → card → atlas → export', async ({ page, context }) => {
  test.setTimeout(180_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const errors = trackPageErrors(page);
  const target = await openGameAgainst(page, TARGET, { noGrowth: true });

  // ---- Game: an empty 6 × 5 board with labelled rows and tiles.
  await expect(board(page)).toHaveAttribute('aria-label', 'Board: 6 rows of 5 letters');
  await expect(page.locator('[data-board] [data-row]')).toHaveCount(6);
  await expect(page.locator('[data-board] [data-tile]')).toHaveCount(30);
  await expect(row(page, 0)).toHaveAttribute('aria-label', 'Guess 1, typing: empty');
  await expect(row(page, 5)).toHaveAttribute('aria-label', 'Guess 6, empty');
  const live = page.locator('section[aria-label="Game"] [aria-live="polite"]');

  // Too short: shake and a message.
  await page.keyboard.type('cra');
  await expect(row(page, 0)).toHaveAttribute('aria-label', 'Guess 1, typing: CRA');
  await page.keyboard.press('Enter');
  await expect(page.locator('section.game .message')).toHaveText('Not enough letters');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace');

  // Not a word: the row shakes, the message shows and is announced; the letters stay.
  await page.keyboard.type('xxxxx');
  await expect(row(page, 0)).toHaveAttribute('aria-label', 'Guess 1, typing: XXXXX');
  await expect(row(page, 0).locator('[data-tile]').first()).toHaveAttribute('data-state', 'typed');
  await page.keyboard.press('Enter');
  await expect(page.locator('section.game .message')).toHaveText('XXXXX is not in the word list');
  await expect(row(page, 0)).toHaveClass(/\bshake\b/);
  await expect(live).toHaveText('XXXXX is not in the word list');
  expect(await page.evaluate(() => window.__wordlology!.app.game.board!.guesses.length)).toBe(0);
  for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace');
  await expect(row(page, 0)).toHaveAttribute('aria-label', 'Guess 1, typing: empty');

  // CRANE against SLATE: only A and E are right.
  await playWord(page, OPENER);
  await expect(row(page, 0)).toHaveAttribute('aria-label', 'Guess 1: C, absent; R, absent; A, correct; N, absent; E, correct');
  await expect(live).toHaveText('Guess 1, CRANE: C absent, R absent, A correct, N absent, E correct.');
  await waitForBoardIdle(page);
  const states = await row(page, 0).locator('[data-tile]').evaluateAll((els) => els.map((e) => e.getAttribute('data-state')));
  expect(states).toEqual(['absent', 'absent', 'correct', 'absent', 'correct']);
  await expect(page.locator('[data-key="a"]')).toHaveAttribute('aria-label', 'A, correct');
  await expect(page.locator('[data-key="c"]')).toHaveAttribute('aria-label', 'C, absent');
  await expect(page.locator('[data-key="s"]')).toHaveAttribute('aria-label', 'S');

  // SLATE wins in two. Record when the message shows and when the zoom out starts.
  await page.evaluate(() => {
    const w = window as unknown as { __e2eWin: { msg: number; zoom: number } };
    w.__e2eWin = { msg: -1, zoom: -1 };
    const app = window.__wordlology!.app;
    const tick = (now: number) => {
      if (w.__e2eWin.msg < 0 && app.game.message.includes('Solved')) w.__e2eWin.msg = now;
      if (w.__e2eWin.zoom < 0 && app.zTarget === 1) w.__e2eWin.zoom = now;
      if (w.__e2eWin.zoom < 0) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await playWord(page, TARGET);
  await expect(row(page, 1)).toHaveAttribute('aria-label', 'Guess 2: S, correct; L, correct; A, correct; T, correct; E, correct');
  await expect(page.locator('section.game .message')).toHaveText('Brilliant! Solved in 2 guesses.');
  await expect(live).toHaveText('Brilliant! Solved in 2 guesses.');
  expect(await page.evaluate(() => window.__wordlology!.app.game.board!.status)).toBe('won');

  // ---- Tree: 800 ms after the end-of-game message the app zooms out by itself.
  await waitForLevel(page, 1);
  const win = await page.evaluate(() => (window as unknown as { __e2eWin: { msg: number; zoom: number } }).__e2eWin);
  expect(win.msg).toBeGreaterThan(0);
  expect(win.zoom - win.msg).toBeGreaterThanOrEqual(700);
  expect(win.zoom - win.msg).toBeLessThan(2500);
  await waitForTree(page);
  const tree = await page.evaluate(() => {
    const { app, focusData } = window.__wordlology!;
    const t = focusData.tree!;
    const words = app.words!;
    const node = app.focus.node;
    return {
      target: t.target,
      strategyGames: t.games.filter((g) => !g.isPlayer).length,
      playerCount: t.playerCount,
      selected: node >= 0 ? t.guessesTo(t.nodes[node]).map((id) => words.guesses[id]) : null,
      strategy: app.focus.strategy?.id ?? null,
      opener: app.focus.opener,
    };
  });
  expect(tree.target).toBe(target);
  expect(tree.strategyGames).toBeGreaterThanOrEqual(190);
  expect(tree.strategyGames).toBeLessThanOrEqual(210);
  expect(tree.playerCount).toBeGreaterThanOrEqual(1);
  // The player's own path is the selected trunk.
  expect(tree.selected).toEqual([OPENER, TARGET]);
  // Arrival: the arrival strategy with the player's first guess as the opener.
  expect(tree.strategy).not.toBeNull();
  expect(tree.opener).toBe(OPENER);
  const readout = page.getByRole('region', { name: 'Selected path' });
  await expect(readout).toBeVisible();
  await expect(readout).toContainText('Solved in 2');
  await expect(readout.getByRole('button', { name: /Play/ })).toBeVisible();

  // ---- Card.
  await page.keyboard.press('-');
  await waitForLevel(page, 2);
  await waitForCard(page);
  const snap = await page.evaluate(() => window.__wordlology!.focusData.card!.snapshot());
  expect(snap.complete).toBe(true);
  expect(snap.shares).toHaveLength(7);
  expect(snap.shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  for (const s of snap.shares) expect(s).toBeGreaterThanOrEqual(0);
  expect(snap.mean).toBeGreaterThan(3);
  expect(snap.mean).toBeLessThan(5);
  expect(snap.solveRate).toBeGreaterThan(0.9);

  // ---- Atlas.
  await page.keyboard.press('-');
  await waitForLevel(page, 3);
  await expect(page.getByRole('toolbar', { name: 'Card and atlas tools' })).toBeVisible();

  // ---- Export at each level.
  // Atlas: the toolbar's Export… button.
  const atlas = await exportAndCheck(page, 'atlas', () =>
    page.getByRole('toolbar', { name: 'Card and atlas tools' }).getByRole('button', { name: /^Export/ }).click(),
  );
  const atlasSummary = csvRows(atlas.files['summary.csv']);
  expect(atlasSummary.rows.length).toBeGreaterThanOrEqual(1);

  await page.keyboard.press('=');
  await waitForLevel(page, 2);
  // Card: the side pane's Export button.
  const pane = page.getByRole('complementary', { name: 'Controls' });
  const card = await exportAndCheck(page, 'card', () => pane.getByRole('button', { name: /^Export/ }).click());
  const games = csvRows(card.files['games.csv']);
  expect(games.rows.length).toBe(snap.nGames);
  const dist = csvRows(card.files['distribution.csv']);
  expect(dist.rows.map((r) => r[1])).toEqual(['1', '2', '3', '4', '5', '6', 'X']);
  const summary = csvRows(card.files['summary.csv']);
  const mean = Number(summary.rows[0][summary.header.indexOf('mean_guesses')]);
  expect(mean).toBeCloseTo(snap.mean, 3);

  await page.keyboard.press('=');
  await waitForLevel(page, 1);
  // Tree: the E key.
  const treeExport = await exportAndCheck(page, 'tree');
  const tg = csvRows(treeExport.files['games.csv']);
  const col = (name: string) => tg.header.indexOf(name);
  // Every game is against SLATE; the player's game is flagged and has the path crane>slate.
  expect(new Set(tg.rows.map((r) => r[col('target')]))).toEqual(new Set([TARGET]));
  const player = tg.rows.filter((r) => r[col('is_player')] === 'TRUE');
  expect(player.map((r) => r[col('path')])).toContain(`${OPENER}>${TARGET}`);
  expect(tg.rows.length - player.length).toBe(tree.strategyGames);
  // Conventions: n_guesses counts guesses, outcome is 1–6 or X, path joins lowercase guesses with ">".
  for (const r of tg.rows) {
    const path = r[col('path')].split('>');
    const n = Number(r[col('n_guesses')]);
    expect(path.length).toBe(n);
    for (const w of path) expect(w).toMatch(/^[a-z]{5}$/);
    expect(['TRUE', 'FALSE']).toContain(r[col('solved')]);
    expect(r[col('outcome')]).toBe(r[col('solved')] === 'TRUE' ? String(n) : 'X');
    if (r[col('solved')] === 'TRUE') expect(path[path.length - 1]).toBe(TARGET);
  }
  const plays = csvRows(treeExport.files['plays.csv']);
  const pc = (name: string) => plays.header.indexOf(name);
  const turns = tg.rows.reduce((sum, r) => sum + Number(r[col('n_guesses')]), 0);
  expect(plays.rows.length).toBe(turns);
  for (const r of plays.rows.slice(0, 200)) {
    expect(r[pc('feedback')]).toMatch(/^[gyb]{5}$/);
    expect(r[pc('guess')]).toMatch(/^[a-z]{5}$/);
  }
  const firstPlay = plays.rows.find((r) => r[pc('turn')] === '1')!;
  expect(firstPlay[pc('guess')]).toBe(OPENER);
  expect(firstPlay[pc('feedback')]).toBe('bbgbg');
  const nodes = csvRows(treeExport.files['nodes.csv']);
  expect(nodes.rows.length).toBeGreaterThan(2);
  const treeDist = csvRows(treeExport.files['distribution.csv']);
  const shareSum = treeDist.rows.reduce((sum, r) => sum + Number(r[treeDist.header.indexOf('share')]), 0);
  expect(shareSum).toBeCloseTo(1, 4);

  // The side pane's Copy R code copies the snippet for the latest export.
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await pane.getByRole('button', { name: 'Copy R code' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(treeExport.fileName);

  expect(errors).toEqual([]);
});
