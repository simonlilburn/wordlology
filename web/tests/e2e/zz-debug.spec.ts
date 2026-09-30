import { test } from '@playwright/test';
import { openGameAgainst, playWord, waitForLevel, waitForTree, waitForCard, waitForSceneIdle } from './helpers';
test.use({ contextOptions: { reducedMotion: 'reduce' } });
test('dbg', async ({ page }) => {
  await openGameAgainst(page, 'slate', { noGrowth: true });
  await playWord(page, 'crane');
  await playWord(page, 'slate');
  await waitForLevel(page, 1); await waitForTree(page);
  let t = Date.now(); await waitForSceneIdle(page); console.log('D tree idle after', Date.now() - t, await page.evaluate(() => (window as any).__e2eDraws));
  await page.keyboard.press('-'); await waitForLevel(page, 2); await waitForCard(page);
  t = Date.now(); await waitForSceneIdle(page); console.log('D card idle after', Date.now() - t);
  await page.keyboard.press('-'); await waitForLevel(page, 3);
  t = Date.now(); await waitForSceneIdle(page); console.log('D atlas idle after', Date.now() - t);
});
