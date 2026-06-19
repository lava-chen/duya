/**
 * Shared helpers for DUYA Electron E2E tests.
 *
 * Launches the real Electron main process (dist-electron/main.js) via
 * Playwright's `_electron` API with test-mode hooks active:
 *   - DUYA_TEST=1              → bypass single-instance lock, enable test hooks
 *   - --duya-namespace=<name>  → isolate userData / SQLite DB per spec
 *
 * The returned `page` is the real BrowserWindow. `page.evaluate()` runs in
 * the renderer context where `window.electronAPI` (exposed by preload.ts
 * via contextBridge) is available — so calling it triggers real IPC
 * invoke/handle roundtrips through ipcMain.
 */
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as path from 'node:path';

export interface LaunchOptions {
  /** Unique namespace for this test run — isolates userData & DB. */
  namespace: string;
  /**
   * Comma-separated list of external subsystems to mock (e.g.
   * "updater,wiki-agent"). Handlers check DUYA_MOCK_EXTERNAL env var.
   * Currently informational; add handler-side short-circuits as needed.
   */
  mockExternal?: string[];
}

export interface DuyaApp {
  app: ElectronApplication;
  page: Page;
}

/**
 * Launch DUYA Electron app in test mode and wait for the first window.
 *
 * Per-namespace isolation is achieved by setting DUYA_TEST_USER_DATA_DIR
 * to a project-local directory (one subdir per namespace). This avoids
 * relying on `app.getPath('userData')` which on Windows is
 * `%APPDATA%\duya\duya-dev\test-namespaces\<ns>` and can be blocked by
 * restricted write sandboxes (Trae, locked-down CI runners). The chosen
 * path lives under the repo's e2e/ folder so it shares the same trust
 * boundary as the rest of the workspace.
 */
export async function launchDuya(opts: LaunchOptions): Promise<DuyaApp> {
  const fs = await import('node:fs');
  const pathMod = await import('node:path');
  // .e2e-userdata/<ns> — git-ignored implicitly (no tracked file uses
  // this path; if the repo wants to be explicit, add to .gitignore).
  const userDataRoot = pathMod.resolve(__dirname, '..', '.e2e-userdata', opts.namespace);
  fs.mkdirSync(userDataRoot, { recursive: true });

  const app = await electron.launch({
    args: [
      '.',
      `--duya-namespace=${opts.namespace}`,
      `--user-data-dir=${userDataRoot}`,
    ],
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      DUYA_TEST: '1',
      DUYA_MOCK_EXTERNAL: (opts.mockExternal ?? []).join(','),
      DUYA_TEST_USER_DATA_DIR: userDataRoot,
      // Suppress noisy logs during tests
      LOG_LEVEL: 'WARN',
    },
  });

  // Forward Electron main-process stdout/stderr so launch failures show
  // up in the Playwright test log. Without this we just see a useless
  // "Target page, context or browser has been closed".
  app.process().stdout?.on('data', (chunk: Buffer) => {
    const s = chunk.toString();
    if (s.trim()) process.stdout.write(`[electron:${opts.namespace}] ${s}`);
  });
  app.process().stderr?.on('data', (chunk: Buffer) => {
    const s = chunk.toString();
    if (s.trim()) process.stderr.write(`[electron:${opts.namespace}] ${s}`);
  });

  try {
    const page = await app.firstWindow();
    // Wait for the renderer to finish loading AND the preload-exposed
    // window.electronAPI to be available. domcontentloaded alone is not
    // enough — the contextBridge injection happens after the DOM event.
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(
      () => typeof (window as unknown as { electronAPI?: unknown }).electronAPI !== 'undefined',
      { timeout: 30_000 },
    );
    return { app, page };
  } catch (err) {
    // If the renderer never exposes electronAPI, capture diagnostics before
    // closing so the test failure message is actionable.
    try {
      const page = app.windows()[0];
      if (page) {
        const url = page.url();
        const title = await page.title().catch(() => '<no title>');
        const body = await page.evaluate(() => document.body?.innerText?.slice(0, 500)).catch(
          () => '<no body>',
        );
        console.error(`[launchDuya] FAILED for namespace="${opts.namespace}"`, {
          url,
          title,
          bodyPreview: body,
        });
      }
    } catch {
      // diagnostic capture failed — ignore
    }
    await app.close().catch(() => {});
    throw err;
  }
}

/**
 * Call a method on window.electronAPI from the renderer context.
 * Returns the resolved value of the IPC invoke.
 *
 * Usage:
 *   const value = await invokeApi(page, 'settingsDb.get', 'my-key');
 *   const list = await invokeApi(page, 'thread.list');
 */
export async function invokeApi<T = unknown>(
  page: Page,
  methodPath: string,
  ...args: unknown[]
): Promise<T> {
  const result = await page.evaluate(
    ({ methodPath, args }) => {
      const api = (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI;
      if (!api) throw new Error('window.electronAPI is not available');
      const parts = methodPath.split('.');
      let target: unknown = api;
      for (const part of parts.slice(0, -1)) {
        target = (target as Record<string, unknown>)[part];
        if (!target) throw new Error(`Path "${methodPath}" not found at "${part}"`);
      }
      const fn = (target as Record<string, unknown>)[parts[parts.length - 1]];
      if (typeof fn !== 'function') {
        throw new Error(`electronAPI.${methodPath} is not a function`);
      }
      return (fn as (...a: unknown[]) => Promise<unknown>)(...args);
    },
    { methodPath, args },
  );
  return result as T;
}

/**
 * Gracefully close the Electron app. Tries app.close() first; if that
 * hangs (graceful shutdown can take up to 10s with background processes
 * like agent server and gateway), force-kill the process tree.
 */
export async function closeDuya(app: ElectronApplication): Promise<void> {
  const pid = app.process().pid;
  try {
    await Promise.race([
      app.close(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('close timeout')), 8_000),
      ),
    ]);
  } catch {
    // Force kill the process tree if graceful close hangs
    if (pid) {
      try {
        // taskkill /F /T kills the process and all children on Windows.
        // On Unix, SIGKILL the main PID (child processes orphaned).
        if (process.platform === 'win32') {
          const { execSync } = await import('node:child_process');
          execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
        } else {
          process.kill(pid, 'SIGKILL');
        }
      } catch {
        // already dead
      }
    }
  }
}
