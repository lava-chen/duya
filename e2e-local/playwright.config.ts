// LOCAL evidence config (not committed).
import { defineConfig } from '@playwright/test';
import * as path from 'node:path';

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: { trace: 'off', actionTimeout: 15_000 },
  webServer: {
    command: 'npm run dev',
    cwd: path.resolve(__dirname, '..'),
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
