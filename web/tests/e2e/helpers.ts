// Shared helpers for the end-to-end tests. The app exposes its store in dev
// builds as window.__wordlology = { app, focusData } (web/src/main.ts); the
// tests wait on that real state instead of fixed sleeps.
import { expect, type Download, type Locator, type Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';

/** The target the journey plays against, and the two guesses that win it. */
export const TARGET = 'slate';
export const OPENER = 'crane';

/** Minimal typing for the store handle (only what the tests read). */
export interface E2EHandle {
  app: {
    z: number;
    zTarget: number;
    reducedMotion: boolean;
    solverReady: boolean;
    words: { answers: ArrayLike<number>; guesses: string[]; wordLength: number } | null;
    display: Record<string, unknown> & { growthAnimation: 'full' | 'fast' | 'off' };
    game: {
      board: { target: number; guesses: number[]; patterns: number[]; status: string } | null;
      input: string;
      message: string;
      history: unknown[];
    };
    replay: { active: boolean; target: number; guesses: number[]; patterns: number[]; cursor: number };
    focus: { strategy: { id: string; label: string } | null; opener: string | null; target: number; node: number };
    atlas: { columns: unknown[]; rows: unknown[] };
    ui: Record<string, unknown> & { exportDialog: boolean; toasts: { text: string }[] };
  };
  focusData: {
    version: number;
    tree: {
      target: number;
      games: { isPlayer?: boolean; target: number; turns: { guess: number }[] }[];
      nodes: unknown[];
      playerCount: number;
      guessesTo(node: unknown): number[];
    } | null;
    treeRun: { status: string; games: unknown[]; version: number } | null;
    cardRun: { status: string; games: unknown[]; version: number } | null;
    card: { snapshot(): { shares: number[]; mean: number; nGames: number; complete: boolean; solveRate: number } } | null;
  };
}

declare global {
  interface Window {
    __wordlology?: E2EHandle;
  }
}

/** Wait until the app has its word list and a board. */
export async function waitForApp(page: Page): Promise<void> {
  await page.waitForFunction(() => !!window.__wordlology?.app.words && !!window.__wordlology.app.game.board, null, {
    timeout: 30_000,
  });
}

/** Wait until the solver workers have built their pattern matrices. */
export async function waitForSolver(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__wordlology?.app.solverReady === true, null, { timeout: 60_000 });
}

/** The answer index of a word in the loaded answer list (-1 if absent). */
export async function answerIndex(page: Page, word: string): Promise<number> {
  return page.evaluate((w) => {
    const words = window.__wordlology!.app.words!;
    return Array.from(words.answers).findIndex((id) => words.guesses[id] === w);
  }, word);
}

export interface OpenOptions {
  /** Turn the tree growth animation off (stable screenshots, faster runs). */
  noGrowth?: boolean;
}

/**
 * Load the app and start a game against `word` through a share link
 * (`#t=<encoded answer index>`, applied by the app's hashchange handler).
 */
export async function openGameAgainst(page: Page, word = TARGET, opts: OpenOptions = {}): Promise<number> {
  await installDrawCounter(page);
  await page.goto('/');
  await waitForApp(page);
  const idx = await answerIndex(page, word);
  expect(idx, `${word} should be in the default answer list`).toBeGreaterThanOrEqual(0);
  const code = await page.evaluate(async (i) => {
    // Vite serves the source modules in dev, so the test encodes the link with the app's own code.
    const path = '/src/app/url.ts';
    const url = (await import(/* @vite-ignore */ path)) as { encodeTarget(i: number): string };
    return url.encodeTarget(i);
  }, idx);
  await page.evaluate((c) => {
    location.hash = `t=${c}`;
  }, code);
  await page.waitForFunction((i) => window.__wordlology!.app.game.board?.target === i, idx);
  if (opts.noGrowth) await setDisplay(page, { growthAnimation: 'off' });
  await waitForSolver(page);
  return idx;
}

/** Change display settings in the store. */
export async function setDisplay(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate((p) => {
    Object.assign(window.__wordlology!.app.display, p);
  }, patch);
}

export const board = (page: Page): Locator => page.locator('[data-board]');
export const row = (page: Page, i: number): Locator => page.locator(`[data-board] [data-row="${i}"]`);

/** Wait until no CSS animation (tile flip, shake, pop) runs on the board. */
export async function waitForBoardIdle(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const b = document.querySelector('[data-board]');
    return !!b && b.getAnimations({ subtree: true }).every((a) => a.playState !== 'running');
  });
}

/** Type a word on the physical keyboard and press Enter. */
export async function playWord(page: Page, word: string): Promise<void> {
  await waitForBoardIdle(page);
  await page.keyboard.type(word, { delay: 15 });
  await expect.poll(() => page.evaluate(() => window.__wordlology!.app.game.input)).toBe(word);
  await page.keyboard.press('Enter');
}

/** Play crane then slate: a win in two. Resolves once the row has flipped and the game is won. */
export async function winInTwo(page: Page): Promise<void> {
  await playWord(page, OPENER);
  await page.waitForFunction(() => window.__wordlology!.app.game.board?.guesses.length === 1);
  await playWord(page, TARGET);
  await page.waitForFunction(() => window.__wordlology!.app.game.board?.status === 'won');
}

/** Current zoom value. */
export async function zoom(page: Page): Promise<number> {
  return page.evaluate(() => window.__wordlology!.app.z);
}

/** Wait until z has settled at a level. */
export async function waitForLevel(page: Page, level: number, timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    (l) => {
      const a = window.__wordlology!.app;
      return Math.abs(a.z - l) < 0.01 && a.zTarget === l;
    },
    level,
    { timeout },
  );
}

/** Wait for the focused tree run to finish (200 strategy games plus player paths). */
export async function waitForTree(page: Page, timeout = 60_000): Promise<void> {
  await page.waitForFunction(() => window.__wordlology!.focusData.treeRun?.status === 'done', null, { timeout });
}

/** Wait for the focused card run to finish. */
export async function waitForCard(page: Page, timeout = 120_000): Promise<void> {
  await page.waitForFunction(() => window.__wordlology!.focusData.cardRun?.status === 'done', null, { timeout });
}

/** Wait for a few animation frames so on-demand rendering catches up. */
export async function settleFrames(page: Page, frames = 6): Promise<void> {
  await page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        let left = n;
        const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    frames,
  );
}

/** Press a key and measure (in page time) how long z takes to reach `level`. */
export async function timedLevelChange(page: Page, key: string, level: number, timeout = 5_000): Promise<number> {
  await page.evaluate(() => {
    (window as unknown as { __e2eT0: number }).__e2eT0 = performance.now();
  });
  await page.keyboard.press(key);
  await page.waitForFunction(
    (l) => {
      const a = window.__wordlology!.app;
      return a.zTarget === l && a.z === l;
    },
    level,
    { polling: 'raf', timeout },
  );
  return page.evaluate(() => performance.now() - (window as unknown as { __e2eT0: number }).__e2eT0);
}

/** Collect uncaught page errors for a test (asserted empty at the end). */
export function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

/** Columns of each export table, from docs/specification.md ("Data export"). */
export const SPEC_COLUMNS: Record<string, string[]> = {
  'configs.csv': [
    'config_id', 'strategy_id', 'strategy_label', 'strategy_json', 'opener', 'word_list_id', 'word_list_version',
    'hard_mode', 'max_guesses', 'replicates', 'base_seed', 'filter', 'solver_version', 'app_version', 'exported_at',
  ],
  'games.csv': ['game_id', 'config_id', 'target', 'replicate', 'n_guesses', 'solved', 'outcome', 'path', 'is_player'],
  'plays.csv': [
    'game_id', 'config_id', 'turn', 'guess', 'feedback', 'feedback_code', 'candidates_before', 'candidates_after',
    'bits_expected', 'bits_observed', 'p_chosen', 'is_candidate', 'phase', 'matches_filter',
  ],
  'nodes.csv': [
    'node_id', 'parent_id', 'config_id', 'target', 'depth', 'guess', 'feedback', 'n_games', 'share', 'is_terminal',
    'outcome', 'matches_filter',
  ],
  'distribution.csv': ['config_id', 'outcome', 'n_games', 'share', 'share_se'],
  'summary.csv': ['config_id', 'n_targets', 'n_games', 'mean_guesses', 'sd_guesses', 'se_mean', 'median', 'solve_rate', 'p95'],
  'paired.csv': ['target', 'config_a', 'config_b', 'mean_a', 'mean_b', 'diff'],
};

/** Files each level's zip holds (specification, "What each level exports"). */
export const LEVEL_FILES: Record<'tree' | 'card' | 'atlas', string[]> = {
  tree: ['configs.csv', 'games.csv', 'plays.csv', 'nodes.csv', 'distribution.csv'],
  card: ['configs.csv', 'games.csv', 'plays.csv', 'distribution.csv', 'summary.csv'],
  atlas: ['configs.csv', 'games.csv', 'plays.csv', 'distribution.csv', 'summary.csv', 'paired.csv'],
};

/** The bytes of a finished download. */
export async function readDownload(download: Download): Promise<Uint8Array> {
  const stream = await download.createReadStream();
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk as Uint8Array);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Unzip an export into file name → UTF-8 text. */
export function unzipText(bytes: Uint8Array): Record<string, string> {
  const files = unzipSync(bytes);
  const out: Record<string, string> = {};
  for (const [name, data] of Object.entries(files)) out[name] = strFromU8(data);
  return out;
}

/** Split one CSV line (quoted fields may hold commas and doubled quotes). */
export function csvFields(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Header and data lines of a CSV text (no comment lines, a trailing newline allowed). */
export function csvRows(text: string): { header: string[]; rows: string[][] } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const [head, ...rest] = lines;
  return { header: csvFields(head ?? ''), rows: rest.map(csvFields) };
}

/**
 * The open dialog with this accessible name that is on top of the top layer.
 * Soft-asserts that only one such dialog is open.
 */
export async function topDialog(page: Page, name: string): Promise<Locator> {
  const dialogs = page.getByRole('dialog', { name });
  await expect(dialogs.first()).toBeVisible();
  const n = await dialogs.count();
  expect.soft(n, `exactly one "${name}" dialog should be open`).toBe(1);
  for (let i = n - 1; i >= 0; i--) {
    const d = dialogs.nth(i);
    const onTop = await d.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(20, r.height / 2));
      return !!hit && el.contains(hit);
    });
    if (onTop) return d;
  }
  return dialogs.first();
}

/**
 * Count WebGL draw calls (in every context) so tests can wait for the
 * render-on-demand scene to go idle. Call before the page loads.
 */
export async function installDrawCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __e2eDraws: number; __e2eLastDraw: number };
    if (typeof w.__e2eDraws === 'number') return;
    w.__e2eDraws = 0;
    w.__e2eLastDraw = 0;
    const names = ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements', 'clear'];
    for (const ctor of [globalThis.WebGLRenderingContext, globalThis.WebGL2RenderingContext]) {
      if (!ctor) continue;
      const proto = ctor.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
      for (const name of names) {
        const orig = proto[name];
        if (typeof orig !== 'function') continue;
        proto[name] = function (this: unknown, ...args: unknown[]) {
          w.__e2eDraws++;
          w.__e2eLastDraw = performance.now();
          return orig.apply(this, args);
        };
      }
    }
  });
}

/** Wait until no WebGL frame has been drawn for `quietMs` (the scene renders on demand, so idle means settled). */
export async function waitForSceneIdle(page: Page, quietMs = 1000, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    (q) => {
      const w = window as unknown as { __e2eDraws?: number; __e2eLastDraw?: number };
      return typeof w.__e2eLastDraw === 'number' && performance.now() - w.__e2eLastDraw >= q;
    },
    quietMs,
    { timeout, polling: 100 },
  );
}
