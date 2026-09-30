import { test } from '@playwright/test';
import { openGameAgainst, playWord, waitForLevel, waitForTree, timedLevelChange } from './helpers';
test.use({ contextOptions: { reducedMotion: 'reduce' }, viewport: { width: 800, height: 600 } });
test('dbg', async ({ page }) => {
  await openGameAgainst(page, 'slate', { noGrowth: true });
  await playWord(page, 'crane');
  await playWord(page, 'slate');
  await waitForLevel(page, 1);
  await waitForTree(page);
  await page.evaluate(() => {
    const w = window as any; w.__log = [];
    const app = window.__wordlology!.app;
    const tick = (now: number) => { w.__log.push([Math.round(now), +app.z.toFixed(3)]); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  const seq: [string, number][] = [['-', 2], ['-', 3], ['=', 2], ['=', 1], ['=', 0], ['-', 1], ['-', 2], ['-', 3], ['=', 2], ['=', 1], ['=', 0], ['-', 1]];
  for (const [k, l] of seq) {
    await page.evaluate(() => { (window as any).__log = []; });
    const ms = Math.round(await timedLevelChange(page, k, l));
    const log = await page.evaluate(() => (window as any).__log);
    const moving = log.filter((x: number[], i: number) => i > 0 && x[1] !== log[i-1][1]);
    console.log('T', k, l, ms, JSON.stringify(log.slice(0, 12).map((x: number[], i: number) => i ? x[0] - log[i-1][0] : 0)));
  }
});
