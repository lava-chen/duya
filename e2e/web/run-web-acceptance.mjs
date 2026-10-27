/**
 * e2e/web/run-web-acceptance.mjs — start the Web acceptance environment,
 * run the Playwright specs against it, and tear it down.
 *
 * ## Why a runner and not two `webServer` entries
 *
 * The environment is not a "server that serves a URL and stays up": it owns
 * a Host, a worker-capable data root, and a loopback provider, and it must
 * die with the run. Playwright's `webServer` can start a process and wait for
 * a URL, but it cannot hand that process's dynamically chosen data root to
 * the spec process — and the spec NEEDS it, because the data root is where
 * the run ledger lives.
 *
 * So this runner starts the environment, reads the data root it printed, and
 * passes it down as an environment variable.
 *
 * ## What the specs are pointed at
 *
 * The BFF the environment starts is the PRODUCT's entry — `node
 * apps/web/dist/server/main.js`, no resolver shim — so the acceptance
 * exercises the command the docs tell a user to run.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));

/** The environment prints one JSON line; this is its data root. */
function parseEnvironment(stdout) {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      return JSON.parse(trimmed);
    } catch {
      continue;
    }
  }
  return null;
}

async function main() {
  // The environment lives in the web package's own fixture directory, not
  // here: it composes a Host, and `apps/web/tests/fixtures` is the root the
  // architecture policy declares for Node-backed web fixtures (it is the
  // `web-server` module, which may reach `duya-host`). The `e2e/` tree may
  // not: nothing under it is inside a declared module, so a host import
  // there is a boundary violation rather than a test.
  const environment = spawn(process.execPath, [
    path.join(repo, 'apps/web/tests/fixtures/web-acceptance-env.mjs'),
  ], {
    cwd: repo,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  let stdout = '';
  const metadata = await new Promise((resolve, reject) => {
    const deadline = Date.now() + 60_000;
    const poll = setInterval(() => {
      const parsed = parseEnvironment(stdout);
      if (parsed) {
        clearInterval(poll);
        resolve(parsed);
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error(`the acceptance environment did not report its metadata in time:\n${stdout}`));
      }
    }, 100);
    environment.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    environment.once('exit', (code) => {
      clearInterval(poll);
      reject(new Error(`the acceptance environment exited early (code ${code}):\n${stdout}`));
    });
  });

  process.stdout.write(`[web-acceptance] environment ready: ${metadata.origin}\n`);

  // The data root is where the run ledger lives, so the spec reads its
  // facts from the same place the Host wrote them.
  const spec = spawn(process.execPath, [
    path.join(repo, 'node_modules/@playwright/test/cli.js'),
    'test',
    '--config',
    path.join(repo, 'e2e/web/web-playwright.config.ts'),
  ], {
    cwd: repo,
    env: {
      ...process.env,
      DUYA_E2E_WEB_DATA_ROOT: metadata.dataRoot,
      DUYA_E2E_WEB_PORT: String(new URL(metadata.origin).port),
    },
    stdio: 'inherit',
  });

  const code = await new Promise((resolve) => spec.once('exit', resolve));

  environment.kill('SIGTERM');
  await new Promise((resolve) => environment.once('exit', resolve));

  // The evidence the run produced stays on disk for the record; the
  // temporary root itself is the OS's to clean.
  process.stdout.write(`[web-acceptance] data root: ${metadata.dataRoot}\n`);
  process.exit(code ?? 1);
}

await main();
