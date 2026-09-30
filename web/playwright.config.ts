// End-to-end tests (docs/specification.md, "Repository, testing and milestones"):
// play → tree → card → atlas → export, screenshot diffs per level, and a
// reduced-motion pass. Run with `npm run e2e` (add `--update-snapshots` to
// regenerate the per-level baselines under tests/e2e/*-snapshots/).
import { defineConfig, devices } from '@playwright/test';

const PORT = 5190;
const CI = !!process.env.CI;

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results',
  // The app runs its own solver worker pool (up to three workers); two browser
  // pages at a time keep a four-core machine responsive.
  workers: CI ? 1 : 2,
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 90_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      // SwiftShader WebGL and font hinting differ slightly between machines.
      maxDiffPixelRatio: 0.03,
      threshold: 0.3,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  snapshotPathTemplate: '{testDir}/{testFileName}-snapshots/{arg}-{projectName}{ext}',
  reporter: CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    acceptDownloads: true,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    locale: 'en-GB',
    timezoneId: 'UTC',
    colorScheme: 'light',
    launchOptions: {
      // WebGL through SwiftShader (no GPU in CI containers).
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
      },
    },
  ],
  webServer: {
    command: `node scripts/sync-data.mjs && npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
