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
   * "updater,browser"). Handlers check DUYA_MOCK_EXTERNAL env var.
   * Currently informational; add handler-side short-circuits as needed.
   */
  mockExternal?: string[];
  /** Load the already-built dist/ renderer instead of a Vite dev server. */
  previewMode?: boolean;
}

export interface DuyaApp {
  app: ElectronApplication;
  page: Page;
}

/**
 * The isolated userData root for a namespace.
 *
 * Exported rather than inlined so a spec that needs to reach the namespace's
 * SQLite file on disk (e.g. to seed a row in a shape the running app cannot
 * produce) derives the exact same path `launchDuya` uses. Two independent
 * derivations drift the moment either file moves, and the symptom is a
 * `existsSync` failure that looks like a product bug.
 */
export function userDataRootFor(namespace: string): string {
  return path.resolve(__dirname, '..', '.e2e-userdata', namespace);
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
  const userDataRoot = userDataRootFor(opts.namespace);
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
      DUYA_PREVIEW_MODE: opts.previewMode ? 'true' : 'false',
      // Bind the browser bridge daemon to an ephemeral port. A developer may
      // already have DUYA running on the default 19825; IPC E2E must not stop
      // or contend with that live instance before creating its first window.
      DUYA_DAEMON_PORT: '0',
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
    // Electron can create its BrowserWindow during the short gap between
    // `_electron.launch()` resolving and `firstWindow()` subscribing. Poll
    // the observed window list so this race cannot wait for a second window.
    const deadline = Date.now() + 30_000;
    let page = app.windows()[0];
    while (!page && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      page = app.windows()[0];
    }
    if (!page) throw new Error('Electron did not create a BrowserWindow within 30 seconds');
    // Wait for the renderer to finish loading AND the preload-exposed
    // window.electronAPI to be available. domcontentloaded alone is not
    // enough — the contextBridge injection happens after the DOM event.
    //
    // The timeout is well above Playwright's 30s default: on a cold Vite
    // dependency cache the shared renderer's first transform can outlast 30s,
    // and the old default failed the very first launch of a run while the app
    // was in fact mounting (the diagnostic snapshot showed the full shell).
    await page.waitForLoadState('domcontentloaded', { timeout: 60_000 });
    await page.waitForFunction(
      () => typeof (window as unknown as { electronAPI?: unknown }).electronAPI !== 'undefined',
      { timeout: 30_000 },
    );

    // In test mode the app may show the onboarding flow because the isolated
    // userData has no configured provider. Mark onboarding completed and reload
    // so canvas UI specs see the main shell instead of the welcome screen.
    if (process.env.DUYA_TEST === '1') {
      await page.evaluate(() => {
        localStorage.setItem('duya-onboarding-completed', 'true');
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => typeof (window as unknown as { electronAPI?: unknown }).electronAPI !== 'undefined',
        { timeout: 30_000 },
      );
    }

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
 * Open the Conductor view in the running app.
 *
 * ## Why this is a helper and not three copies of the same three lines
 *
 * The sidebar has two tabs. The primary navigation — the row that carries
 * the Conductor entry — renders on the WORK tab only; the Bots tab is a flat
 * contact list. The app starts on the Bots tab, so a spec that goes straight
 * for `nav-conductor` waits out its timeout against a button that is not in
 * the DOM, and the canvas it is trying to reach never appears.
 *
 * Every Conductor spec needs the same two steps in the same order, and every
 * one of them used to carry its own copy of the wait — so the failure was
 * three identical 20-second timeouts instead of one readable error.
 */
export async function openConductorView(page: Page): Promise<void> {
  // The Work tab must be active before the primary navigation exists.
  const workTab = page.getByTestId('sidebar-tab-work');
  await workTab.waitFor({ state: 'visible', timeout: 20_000 });
  if ((await workTab.getAttribute('aria-selected')) !== 'true') {
    await workTab.click();
  }
  await page.getByTestId('nav-conductor').click({ timeout: 20_000 });
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
