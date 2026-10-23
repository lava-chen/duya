/**
 * e2e/perf/lib/launch.mjs — launching the real Electron app for measurement.
 *
 * THE ONE RULE THIS MODULE ENFORCES
 *
 * The renderer must be the PRODUCTION build of THIS checkout. The Desktop
 * main process resolves its renderer URL in preview mode
 * (`DUYA_PREVIEW_MODE=true` -> `file://<cwd>/dist/index.html`), which is
 * port-independent. The dev-server path is not usable here: the dev detector
 * probes 3000-3005 and returns the first hit, which on a machine with
 * several worktrees is ANOTHER branch's Vite server — the app would then
 * load a renderer that is not the code under test.
 *
 * So: preview mode, a production build, an isolated userData directory per
 * namespace, and no dev server anywhere in the picture.
 */
import { _electron as electron } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The repository root of this checkout (e2e/perf/lib -> e2e/perf -> e2e -> root). */
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

/** Where the isolated userData / SQLite databases of a namespace live. */
export function userDataRootFor(namespace) {
  return path.resolve(REPO_ROOT, '.e2e-userdata', `perf-${namespace}`);
}

/**
 * Fail early and loudly when the production build is missing.
 *
 * A measurement against a stale or absent build is not a measurement, and
 * the symptom (the app refusing to start) is easy to misread as a product
 * defect.
 */
export function assertProductionBuild() {
  const required = [
    path.join(REPO_ROOT, 'dist', 'index.html'),
    path.join(REPO_ROOT, 'dist-electron', 'main.js'),
  ];
  const missing = required.filter((file) => !fs.existsSync(file));
  if (missing.length > 0) {
    throw new Error(
      'the production build is missing:\n'
        + missing.map((file) => `  - ${file}`).join('\n')
        + '\nBuild it first:\n'
        + '  npm run bundle:worker\n'
        + '  npm run build:electron\n'
        + '  npx vite build\n',
    );
  }
  const worker = path.join(REPO_ROOT, 'packages', 'host', 'bundle', 'worker-entry.js');
  if (!fs.existsSync(worker)) {
    throw new Error(`the worker bundle is missing: ${worker} (run: npm run bundle:worker)`);
  }
  return {
    rendererUrl: `file://${path.join(REPO_ROOT, 'dist', 'index.html')}`,
    mainEntry: path.join(REPO_ROOT, 'dist-electron', 'main.js'),
    workerBundle: worker,
  };
}

/**
 * Launch the real Electron app in preview mode.
 *
 * `DUYA_TEST=1` is required and is not a mock: it is the product's own test
 * mode, which skips the single-instance lock (so a developer's running Duya
 * does not swallow the launch) and isolates userData per namespace.
 */
export async function launchPerfElectron(options = {}) {
  const namespace = options.namespace ?? `perf-${Date.now()}`;
  const userDataRoot = userDataRootFor(namespace);
  fs.mkdirSync(userDataRoot, { recursive: true });

  const app = await electron.launch({
    args: [
      '.',
      `--duya-namespace=${namespace}`,
      `--user-data-dir=${userDataRoot}`,
      ...(options.extraArgs ?? []),
    ],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DUYA_TEST: '1',
      DUYA_PREVIEW_MODE: 'true',
      DUYA_TEST_USER_DATA_DIR: userDataRoot,
      DUYA_DAEMON_PORT: '0',
      LOG_LEVEL: options.logLevel ?? 'WARN',
      ...(options.env ?? {}),
    },
  });

  const consoleErrors = [];
  const pageErrors = [];

  const page = await waitForFirstWindow(app, options.timeoutMs ?? 60_000);
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => {
    pageErrors.push(String(error?.message ?? error));
  });

  return {
    app,
    page,
    namespace,
    userDataRoot,
    consoleErrors,
    pageErrors,
  };
}

/**
 * Wait until the renderer is usable: the document is loaded and the preload
 * bridge is in place.
 */
export async function waitForAppReady(page, timeoutMs = 60_000) {
  await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
  await page.waitForFunction(() => typeof window.electronAPI !== 'undefined', { timeout: timeoutMs });
  return page;
}

async function waitForFirstWindow(app, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let page = app.windows()[0];
  while (!page && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    page = app.windows()[0];
  }
  if (!page) throw new Error('Electron did not create a BrowserWindow in time');
  return page;
}

/**
 * The wall-clock instant the Electron main process was started.
 *
 * Read from the OS rather than from the harness, because the harness can
 * only say "somewhere around here" — the spawn happens inside
 * `electron.launch()`. On Windows the process start time comes from the
 * process table; elsewhere it is unavailable and the caller falls back to
 * the pre-launch timestamp.
 */
export function readProcessStartMs(app) {
  const pid = app?.process()?.pid;
  if (!pid || process.platform !== 'win32') return null;
  try {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString("o")`,
      ],
      { encoding: 'utf8' },
    );
    const parsed = Date.parse(output.trim());
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Close the app; force-kill the tree when the graceful close hangs. */
export async function closePerfElectron(app) {
  if (!app) return;
  const pid = app.process()?.pid;
  try {
    await Promise.race([
      app.close(),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('close timeout')), 8000)),
    ]);
  } catch {
    if (pid) {
      try {
        if (process.platform === 'win32') {
          const { execSync } = await import('node:child_process');
          execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
        } else {
          process.kill(pid, 'SIGKILL');
        }
      } catch {
        /* already dead */
      }
    }
  }
}

/**
 * The paint timings of the current document.
 *
 * `timeOrigin` is the wall-clock instant the document's time origin was
 * established, so `timeOrigin + entry.startTime` is a wall-clock timestamp
 * that can be compared with the instant the Electron process was spawned.
 */
export async function readPaintTiming(page) {
  return page.evaluate(() => {
    const entries = performance.getEntriesByType('paint');
    const byName = new Map(entries.map((entry) => [entry.name, entry.startTime]));
    return {
      timeOrigin: performance.timeOrigin,
      firstPaintMs: byName.get('first-paint') ?? null,
      firstContentfulPaintMs: byName.get('first-contentful-paint') ?? null,
      domContentLoadedMs: performance.timing?.domContentLoadedEventEnd ?? null,
      navigationStart: performance.timeOrigin,
    };
  });
}

/**
 * Wait until the composer accepts keys.
 *
 * "Typeable" means: a contenteditable textbox (the product's
 * `RichTextInput`) or a textarea is in the document and attached to it.
 *
 * The wait does NOT throw when the composer never becomes typeable: a
 * composer that is rendered but disabled is a real state, and the report
 * says so instead of the harness inventing a number. The reason carries the
 * DOM evidence.
 */
export async function waitForTypeable(page, timeoutMs = 30_000) {
  const startedAt = Date.now();
  const selector = '[role="textbox"][contenteditable="true"], textarea:not([disabled])';
  try {
    await page.waitForFunction(
      (css) => {
        const el = document.querySelector(css);
        return Boolean(el && el.isConnected);
      },
      selector,
      { timeout: timeoutMs, polling: 'raf' },
    );
  } catch {
    const evidence = await describeComposer(page);
    return {
      found: false,
      elapsedMs: Date.now() - startedAt,
      detectedAt: null,
      reason: `no typeable composer within ${timeoutMs}ms`,
      evidence,
    };
  }
  const elapsedMs = Date.now() - startedAt;
  return { found: true, elapsedMs, detectedAt: startedAt + elapsedMs, reason: null };
}

/** What the composer looks like right now — the evidence for a failed wait. */
export async function describeComposer(page) {
  return page
    .evaluate(() => {
      const editable = document.querySelector('[role="textbox"]');
      const textarea = document.querySelector('textarea');
      const pick = (element) =>
        element
          ? {
              tag: element.tagName,
              contentEditable: element.getAttribute('contenteditable'),
              disabled: element.disabled === true,
              connected: element.isConnected,
            }
          : null;
      return {
        editable: pick(editable),
        textarea: pick(textarea),
        domNodes: document.getElementsByTagName('*').length,
        bodyPreview: (document.body?.innerText ?? '').slice(0, 200),
      };
    })
    .catch(() => null);
}

/** Read the GPU feature status the main process reports. */
export async function gpuFeatureStatus(app) {
  try {
    return await app.evaluate(({ app: electronApp }) => electronApp.getGPUFeatureStatus());
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

/**
 * Create a session and seed it with messages, through the product's own
 * bridge (preload -> ipcMain -> Host -> SQLite).
 *
 * Nothing is written behind the product's back: the rows land in the same
 * store the app reads from, in the same shape the app writes.
 */
export async function seedSession(page, options) {
  const { sessionId, title, workingDirectory, messages } = options;
  const result = await page.evaluate(
    async (args) => {
      const api = window.electronAPI;
      if (!api) throw new Error('window.electronAPI is not available');
      const created = await api.thread.create({
        id: args.sessionId,
        title: args.title,
        working_directory: args.workingDirectory,
        // 'auto' keeps a tool call from waiting for an approval prompt, which
        // would stall a measurement instead of exercising the streaming path.
        permission_profile: args.permissionProfile,
      });
      const replaced = await api.message.replace(args.sessionId, args.messages, 0);
      // Read the transcript back through the same bridge: a seed that the
      // product cannot read back is not a seed, and a scenario that measures
      // an empty transcript reports numbers about nothing.
      const readBack = await api.message.getBySession(args.sessionId, {
        includeSuperseded: true,
      });
      return {
        createdId: created?.id ?? null,
        replaced,
        readBackCount: Array.isArray(readBack) ? readBack.length : null,
      };
    },
    {
      sessionId,
      title,
      workingDirectory,
      messages,
      permissionProfile: options.permissionProfile ?? 'auto',
    },
  );
  if (result.replaced?.success === false) {
    throw new Error(
      `seeding ${sessionId} failed: ${result.replaced.reason ?? 'unknown reason'}`,
    );
  }
  if (result.readBackCount !== messages.length) {
    throw new Error(
      `seeding ${sessionId} wrote ${messages.length} rows but the product reads back `
        + `${result.readBackCount}`,
    );
  }
  return result;
}

/**
 * Publish renderer state through the product's own persistence.
 *
 * `duya-conversations` is the zustand-persist key of the conversation store;
 * restoring `activeThreadId` + `currentView` is how the app itself comes
 * back to a session after a restart, so the harness uses the same door
 * instead of poking the store.
 */
export async function setRendererState(page, state) {
  await page.evaluate((next) => {
    localStorage.setItem('duya-onboarding-completed', 'true');
    const raw = localStorage.getItem('duya-conversations');
    let parsed = { state: {}, version: 0 };
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { state: {}, version: 0 };
      }
    }
    parsed.state = { ...(parsed.state ?? {}), ...next };
    if (parsed.version === undefined) parsed.version = 0;
    localStorage.setItem('duya-conversations', JSON.stringify(parsed));
  }, state);
}

/**
 * Restore a session through the product's own persistence, and let the
 * product persist it back.
 *
 * Writing `duya-conversations` directly is not enough: the conversation
 * store persists on every state change, so the app overwrites the value
 * with its own (still empty) state before the process exits — and the next
 * boot comes up on the welcome screen. Writing the value and then RELOADING
 * makes the app rehydrate from it and persist it back, which is the state
 * the next launch will find.
 */
export async function restoreSession(page, state) {
  await setRendererState(page, state);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForAppReady(page);
  // The store persists on its next state change; give it a moment to write.
  await page.waitForTimeout(800);
  return readChatViewState(page);
}

/** How many message rows the chat transcript currently shows. */
export async function readRenderedMessageCount(page) {
  return page.evaluate(() => {
    const list = document.querySelector('.message-list-scroll');
    if (!list) return null;
    return list.querySelectorAll('[data-message-id]').length;
  });
}

/** Whether the chat view is on screen (a transcript container exists). */
export async function readChatViewState(page) {
  return page.evaluate(() => {
    const list = document.querySelector('.message-list-scroll');
    const input = document.querySelector('[role="textbox"][contenteditable="true"]');
    return {
      chatView: Boolean(list),
      typeable: Boolean(input && input.isConnected),
      domNodes: document.getElementsByTagName('*').length,
    };
  });
}
