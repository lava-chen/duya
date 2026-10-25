import { defineConfig } from '@playwright/test';
import path from 'node:path';

export default defineConfig({
  testDir: '.', testMatch: '*.spec.ts', workers: 1, timeout: 60_000,
  use: { baseURL: 'http://127.0.0.1:3199', trace: 'retain-on-failure' },
  webServer: { cwd: path.resolve(__dirname, '../..'), command: 'node scripts/worktree-browser-server.mjs', url: 'http://127.0.0.1:3199', timeout: 60_000, reuseExistingServer: false },
});
