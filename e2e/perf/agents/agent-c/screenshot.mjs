#!/usr/bin/env node
/**
 * Agent C — visual snapshot of the sidebar.
 *
 * The performance change narrows subscriptions and adds a memo boundary.
 * Neither may change what the sidebar SHOWS, so this script captures the
 * same views before and after the change for a pixel comparison.
 *
 * Usage (from the repo root of this checkout):
 *
 *   node e2e/perf/agents/agent-c/screenshot.mjs --out docs-local/research/perf-agent-c/after.png
 *
 * Flags:
 *   --out FILE     Where to write the PNG (default: docs-local/research/perf-agent-c/sidebar.png).
 *   --no-lock      Do not take the shared benchmark lock.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const LOCK_SCRIPT =
  process.env.DUYA_PERF_LOCK ?? 'E:/Projects/duya/.claude/perf-bench-lock.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : true;
};
const outFile = String(flag('out', 'docs-local/research/perf-agent-c/sidebar.png'));
const useLock = flag('no-lock', false) !== true;
const userDataFlag = flag('user-data', null);

let lockHeld = false;
function acquireLock() {
  if (!useLock) return;
  if (!fs.existsSync(LOCK_SCRIPT)) return;
  const result = spawnSync(process.execPath, [LOCK_SCRIPT, 'acquire', 'agentC-state'], {
    stdio: 'inherit',
  });
  if (result.status === 0) lockHeld = true;
  else if (result.status === 2) {
    console.error('[agent-c] benchmark lock is busy; not snapshotting under contention.');
    process.exit(2);
  }
}
function releaseLock() {
  if (!lockHeld) return;
  spawnSync(process.execPath, [LOCK_SCRIPT, 'release'], { stdio: 'inherit' });
  lockHeld = false;
}

async function clickInPage(page, selector) {
  const clicked = await page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node) return false;
    node.click();
    return true;
  }, selector);
  if (!clicked) throw new Error(`selector not found: ${selector}`);
}

async function main() {
  acquireLock();
  const namespace = `perf-agent-c-shot-${process.pid}`;
  const userDataRoot = userDataFlag
    ? path.resolve(REPO_ROOT, String(userDataFlag))
    : path.resolve(REPO_ROOT, '.e2e-userdata', namespace);
  fs.mkdirSync(userDataRoot, { recursive: true });
  const app = await electron.launch({
    args: ['.', `--duya-namespace=${namespace}`, `--user-data-dir=${userDataRoot}`],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DUYA_TEST: '1',
      DUYA_PREVIEW_MODE: 'true',
      DUYA_TEST_USER_DATA_DIR: userDataRoot,
      DUYA_DAEMON_PORT: '0',
      LOG_LEVEL: 'WARN',
    },
  });
  try {
    let page = app.windows()[0];
    const deadline = Date.now() + 60_000;
    while (!page && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      page = app.windows()[0];
    }
    if (!page) throw new Error('Electron did not open a BrowserWindow');
    await page.waitForFunction(() => typeof window.electronAPI !== 'undefined', undefined, {
      timeout: 60_000,
    });
    await page.evaluate(() => {
      try {
        window.localStorage.setItem('duya-onboarding-completed', '1');
      } catch {
        /* storage unavailable */
      }
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.app-shell-root', { timeout: 60_000 });
    await page.waitForTimeout(4000);

    const outPath = path.resolve(REPO_ROOT, outFile);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    // 1. The default view (Bots tab) — the sidebar as the user first sees it.
    const column = page.locator('.app-sidebar-column').first();
    await column.screenshot({ path: outPath });

    // 2. The Work tab — the project/session list.
    await clickInPage(page, '[data-testid="sidebar-tab-work"]');
    await page.waitForTimeout(1200);
    const workPath = outPath.replace(/\.png$/, '-work.png');
    await column.screenshot({ path: workPath });

    console.log(JSON.stringify({ out: outPath, work: workPath }, null, 2));
  } finally {
    const pid = app.process()?.pid;
    if (pid) {
      try {
        spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
      } catch {
        /* already gone */
      }
    }
    await app.close().catch(() => undefined);
    releaseLock();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[agent-c] screenshot failed:', error);
    releaseLock();
    process.exit(1);
  });
