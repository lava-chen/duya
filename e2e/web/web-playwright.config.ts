/**
 * e2e/web/web-playwright.config.ts — the Web surface's own Playwright project.
 *
 * ## Why this is NOT the Electron project
 *
 * Every other project under `e2e/` drives the Electron app through
 * Playwright's `_electron` API. The Web client is not Electron: it is the
 * SHARED renderer (`@duya/ui`) served by the Node BFF, opened in a real
 * browser, talking to a real standalone Host over HTTP. Driving it through
 * `_electron` would prove the Electron path, which is the one already
 * covered — the Web path is the one with no coverage at all.
 *
 * So this config launches a plain Chromium against the BFF's origin, which
 * is the surface a Web user actually gets.
 *
 * ## What the environment is, and what it is not
 *
 * Real: the standalone Host, the production worker bundle, the BFF, the
 * shared renderer, and a browser. The run is a real run — a durable ledger
 * row, real SSE envelopes, a real worker process executing a tool.
 *
 * Scripted: the MODEL. The provider is a loopback HTTP server speaking the
 * Anthropic Messages wire protocol, which decides the BYTES for one request
 * and nothing else. It cannot create a run, settle a run, or emit a
 * protocol event. The executor, not the fixture, is what makes a turn
 * happen. No packet leaves the machine and no provider credential is needed.
 *
 * ## The server under test
 *
 * The BFF is started as the PRODUCT starts it — `node apps/web/dist/server/main.js`
 * with no resolver shim and no `--import` flag — because that is exactly
 * the thing the Web acceptance is about. A test that mounted the shim would
 * pass while the documented command stayed broken.
 *
 * ## Why the suite is NOT named `*.spec.ts`
 *
 * `npm run test:e2e` drives the Electron track with `e2e/playwright.config.ts`,
 * whose projects match by directory segment (`smoke/`, `ipc/`, `turn/`,
 * `ui-states/`). This suite matches none of them: it needs its own config,
 * its own runner and a Host-backed environment. So it lives here, under its
 * own config, and the file is named `*.playwright.ts` rather than `*.spec.ts`
 * on purpose:
 *
 * `scripts/ci/test-scope.mjs` classifies a `.spec.` file under `e2e/` as a
 * spec that CI can run on its own (`npm run test:e2e -- <file>`). This suite
 * is not such a spec — selecting it that way makes Playwright report "no
 * tests found" and fail the job. A non-`.spec.` file under `e2e/` is
 * classified as E2E INFRASTRUCTURE instead, which is the truthful
 * classification: touching this suite means the whole E2E suite runs.
 */

import { defineConfig } from '@playwright/test';
import * as path from 'node:path';

/** The port the fixture's BFF listens on. Fixed so the config can name it. */
const WEB_PORT = Number(process.env.DUYA_E2E_WEB_PORT ?? '5199');

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // A turn here spawns a worker, executes a tool, waits on an approval, and
  // replays after a reload — the Electron turn spec budgets 90s for less.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    actionTimeout: 20_000,
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
  },
  projects: [
    {
      name: 'web',
      testMatch: /web-.*\.playwright\.ts/,
    },
  ],
});
