import { defineConfig } from '@playwright/test';
import * as path from 'node:path';

/**
 * Playwright config for DUYA Electron E2E tests.
 *
 * Architecture (see AGENTS.md → Tests):
 *   - Main track: @playwright/test `_electron` API launches the real Electron
 *     main process with DUYA_TEST=1 + --duya-namespace=<spec>. Each spec gets
 *     an isolated userData directory (fresh SQLite DB, fresh settings).
 *   - The Vite dev server is started by `webServer` below so the renderer
 *     has something to load. `reuseExistingServer` lets `npm run electron:dev`
 *     stay running during development.
 *
 * Running:
 *   npx playwright test                # all e2e
 *   npx playwright test e2e/smoke      # just smoke
 *   npx playwright test e2e/ipc        # just IPC specs
 */
export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: 'smoke',
      testMatch: /smoke\.spec\.ts/,
    },
    {
      name: 'ipc',
      testMatch: /ipc\/.*\.spec\.ts/,
    },
    {
      name: 'ui',
      testMatch: /conductor\/.*\.spec\.ts/,
    },
  ],
  webServer: {
    command: 'npm run dev',
    cwd: path.resolve(__dirname, '..'),
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
