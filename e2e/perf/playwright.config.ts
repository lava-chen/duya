import { defineConfig } from '@playwright/test';

/**
 * e2e/perf/playwright.config.ts — the Playwright-native entry to the
 * performance harness.
 *
 * It is a SEPARATE config on purpose: the repository's `e2e/playwright.config.ts`
 * starts a Vite dev server on port 3000, and the harness must never touch a
 * dev server (the dev detector probes 3000-3005 and would hand the app
 * another worktree's renderer).
 *
 *   npx playwright test --config=e2e/perf/playwright.config.ts
 */
export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60 * 60 * 1000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  projects: [
    {
      name: 'perf',
      testMatch: /.*\.spec\.ts/,
    },
  ],
});
