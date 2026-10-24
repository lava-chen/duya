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
import { execFileSync, execSync } from 'node:child_process';
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
 *
 * A launch that lands in the app's SAFE-MODE window is retried once. On a
 * fresh profile the app can open its database before the `databases`
 * directory exists ("Cannot open database because the directory does not
 * exist"), and it then shows the recovery window instead of the shell. That
 * is a product-side first-boot ordering problem, not a measurement: the
 * retry measures the same thing the second time round.
 */
export async function launchPerfElectron(options = {}) {
  const attempts = options.attempts ?? 2;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await launchPerfElectronOnce(options);
    } catch (error) {
      lastError = error;
      const message = String(error?.message ?? error);
      if (!message.includes('SAFE-MODE')) throw error;
      if (attempt + 1 >= attempts) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw lastError;
}

async function launchPerfElectronOnce(options) {
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

  // The namespace is how the close finds this app again: the pid Playwright
  // hands out belongs to its own launcher, not to the app.
  LAUNCH_NAMESPACES.set(app, namespace);

  const consoleErrors = [];
  const pageErrors = [];

  const page = await waitForFirstWindow(app, options.timeoutMs ?? 60_000).catch(async (error) => {
    // A launch that did not produce a renderer must not leave the app
    // behind: the retry (or the next sample) would measure a machine that
    // already runs an app.
    await closePerfElectron(app);
    throw error;
  });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => {
    pageErrors.push(String(error?.message ?? error));
  });

  // The first-launch wizard covers the whole window, so it would swallow
  // every click the harness makes. The app writes this flag itself when the
  // wizard is done or skipped; setting it at document-start means every
  // navigation of this profile starts on the app's own shell.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('duya-onboarding-completed', 'true');
    } catch {
      /* a profile without localStorage is not a profile the app can use */
    }
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
  let page = null;
  while (!page && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const windows = app.windows();
    // The app opens a SAFE-MODE window (a `data:` URL) when it cannot reach
    // its database. That window has no localStorage and no renderer, so the
    // harness must not measure it: the real renderer is the `file:` one.
    const usable = windows.filter((window) => !window.url().startsWith('data:'));
    page = usable.find((window) => window.url().startsWith('file:')) ?? usable[0] ?? null;
  }
  if (!page) {
    const safeMode = app.windows().find((window) => window.url().startsWith('data:'));
    throw new Error(
      safeMode
        ? 'Electron only opened its SAFE-MODE window (the app could not reach its database), '
          + 'so there is no renderer to measure'
        : 'Electron did not create a BrowserWindow in time',
    );
  }
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

/**
 * The namespace of every launch, so the close can find the app's processes.
 *
 * Playwright launches the app THROUGH a `cmd.exe` wrapper on Windows, so the
 * pid it hands out belongs to that wrapper and not to the app. A guard that
 * looks at THAT name sees `cmd` and refuses to kill it — and the app stays
 * alive: the profile stays locked, ~700 MB stay allocated, and the next
 * sample measures a machine that is already busy. That is what happened
 * until the close stopped trusting the pid.
 *
 * The namespace is unique per launch and it is in the app's own command
 * line, so it finds exactly this app's processes and nothing of anybody
 * else's.
 */
const LAUNCH_NAMESPACES = new WeakMap();

/**
 * Close the app, and make sure it is GONE.
 *
 * WHY THE EXTRA WORK
 *
 * `app.close()` resolves when Playwright is done with the window — it does
 * NOT promise that the Electron main process exited. This app keeps one
 * alive (it owns a gateway and an agent server), so a "closed" sample left
 * a whole app tree behind: 6+ processes and ~700 MB per sample, and after a
 * dozen samples the machine was measuring itself. The profile stayed locked
 * and the next sample measured a busy machine.
 *
 * So the processes of THIS launch are killed after the graceful close.
 */
export async function closePerfElectron(app) {
  if (!app) return { killed: [] };
  const pid = app.process()?.pid;
  const namespace = LAUNCH_NAMESPACES.get(app) ?? null;
  try {
    await Promise.race([
      app.close(),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('close timeout')), 8000)),
    ]);
  } catch {
    /* the graceful close did not work: the forced path below takes over */
  }
  const killed = killLaunchProcesses(namespace);
  if (killed.length === 0) await killPerfProcessTree(pid);
  return { killed };
}

/**
 * Kill the processes of one launch, by its namespace.
 *
 * Only the processes whose own command line carries this launch's namespace
 * are touched, so another agent's app (which has another namespace) is never
 * in the blast radius.
 */
export function killLaunchProcesses(namespace) {
  if (!namespace) return [];
  if (process.platform !== 'win32') return [];
  let pids = [];
  try {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ns = ${JSON.stringify(namespace)}; `
          + "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('electron.exe','cmd.exe') "
          + '-and $_.CommandLine '
          + '-and '
          + `$_.CommandLine -match ('--duya-namespace=' + [regex]::Escape($ns) + '("|\\s|$)') } `
          + '| ForEach-Object { $_.ProcessId }',
      ],
      { encoding: 'utf8' },
    );
    pids = output
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
  const killed = [];
  for (const target of pids) {
    try {
      execSync(`taskkill /F /T /PID ${target}`, { stdio: 'ignore' });
      killed.push(target);
    } catch {
      /* the process died on its own */
    }
  }
  return killed;
}

/**
 * Kill the app's process tree, when the app is still running.
 *
 * The name is checked first: the app may already be gone, and a pid that
 * was freed can be handed to ANOTHER process — killing that one would take
 * the harness down with it.
 */
export async function killPerfProcessTree(pid) {
  if (!pid) return { killed: false, reason: 'no pid' };
  const name = readProcessName(pid);
  if (!name) return { killed: false, reason: 'the process is gone' };
  if (name.toLowerCase() !== 'electron') {
    return { killed: false, reason: `the pid belongs to ${name}, not to the app` };
  }
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    return { killed: true, pid };
  } catch {
    return { killed: false, reason: 'the process died on its own' };
  }
}

/** The name of the process with this pid, or null when there is none. */
function readProcessName(pid) {
  try {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).ProcessName`,
      ],
      { encoding: 'utf8' },
    ).trim();
    return output || null;
  } catch {
    return null;
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
 * Wait until the app is usable: the composer accepts keys AND the boot
 * splash is gone.
 *
 * "Typeable" means: a contenteditable textbox (the product's
 * `RichTextInput`) or a textarea is in the document and attached to it.
 *
 * The splash matters: the app renders the welcome view BEHIND the
 * `.duya-startup-landing` overlay while it boots, and the composer in that
 * DOM is already editable. Reporting that as "typeable" would report the
 * moment the shell mounted, not the moment the user could type. So the wait
 * requires the overlay to stop COVERING the UI.
 *
 * It does NOT require the overlay to be GONE: in this build it never is.
 * `App.tsx` fades the splash and schedules its unmount in the same effect
 * whose cleanup cancels that very timer, so the element stays in the DOM in
 * the `fading` phase (opacity 0, `pointer-events: none`) for the rest of the
 * run. "Not covering" is what the user experiences.
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
        if (!el || !el.isConnected) return false;
        const splash = document.querySelector('.duya-startup-landing');
        if (!splash) return true;
        // The overlay stops covering the UI when it is faded out. It is never
        // unmounted in this build (App.tsx cancels its own unmount timer),
        // so "gone" is the wrong condition — "not covering" is the truth.
        if (splash.getAttribute('data-visible') === 'false') return true;
        if (splash.getAttribute('data-phase') === 'fading') return true;
        const style = window.getComputedStyle(splash);
        return style.pointerEvents === 'none' || Number(style.opacity) <= 0.01;
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
      reason: `no typeable composer (with the boot splash out of the way) within ${timeoutMs}ms`,
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
      const splash = document.querySelector('.duya-startup-landing');
      const splashStyle = splash ? window.getComputedStyle(splash) : null;
      return {
        editable: pick(editable),
        textarea: pick(textarea),
        splash: splash ? splash.getAttribute('data-phase') : null,
        splashStatus: splash?.querySelector('.duya-startup-status')?.textContent ?? null,
        splashCovering: Boolean(
          splash
          && splash.getAttribute('data-visible') !== 'false'
          && splash.getAttribute('data-phase') !== 'fading'
          && splashStyle?.pointerEvents !== 'none'
          && Number(splashStyle?.opacity ?? '1') > 0.01,
        ),
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
 * Wake the conversation store, so the session list and the project list arrive.
 *
 * WHY THIS EXISTS (a product defect, not a harness convenience)
 *
 * `packages/ui/src/stores/conversation-store.ts` persists itself to
 * localStorage under `duya-conversations` and marks itself hydrated in
 * `onRehydrateStorage` — by MUTATING the state object in place
 * (`s.isHydrated = true`). Zustand v5 does not notify subscribers after
 * `onRehydrateStorage`, so on a profile whose persisted state is absent the
 * mutation is never observed: `isHydrated` stays false in React, and with it
 * `app-sidebar.tsx` never calls `loadFromDatabase()`. The result is a booted
 * app with an EMPTY session list and a welcome composer that stays disabled
 * (`WelcomeView.tsx`: `disabled={!isHydrated || !selectedProject}`).
 *
 * The way out is the product's own sync path: the renderer receives
 * `sync:threads-changed` -> `forceSync()` -> `loadFromDatabase()`, and THAT
 * write is a real `set()`, so the subscribers are notified and the app
 * hydrates. The main process only echoes that event to the OTHER windows
 * (`system-handlers.ts`), so with a single window the harness sends it to
 * every window itself.
 *
 * This is called in a PREPARE phase — never inside a measured window — so the
 * measured boot is the product's own, unmodified, boot. The one exception is
 * the startup scenario, which nudges the store inside its measured window and
 * reports the nudge's cost separately; see its notes.
 */
export async function wakeConversationStore(app, page, options = {}) {
  await app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('sync:threads-changed');
    }
  });
  // The wake is a round trip through the IPC bus and a database read; the
  // settle time is what the product itself needs before the list is painted.
  await page.waitForTimeout(options.settleMs ?? 3000);
  return readHydrationState(page);
}

/**
 * What the renderer knows about its own hydration, for the report.
 *
 * `persisted` is the store's own persist payload — it is the proof that the
 * NEXT boot will hydrate without any help (the persist middleware calls
 * `set()` when a stored value exists, which is what notifies the subscribers).
 */
export async function readHydrationState(page) {
  return page
    .evaluate(() => {
      const raw = localStorage.getItem('duya-conversations');
      let persisted = null;
      if (raw) {
        try {
          persisted = JSON.parse(raw).state ?? null;
        } catch {
          persisted = null;
        }
      }
      const splash = document.querySelector('.duya-startup-landing');
      const editable = document.querySelector('[role="textbox"]');
      return {
        persisted: persisted
          ? {
            currentView: persisted.currentView ?? null,
            activeThreadId: persisted.activeThreadId ?? null,
            lastSyncAt: persisted.lastSyncAt ?? null,
          }
          : null,
        splash: splash ? splash.getAttribute('data-phase') : null,
        threadRows: document.querySelectorAll('div.thread-item').length,
        projectName: document.querySelector('.welcome-project-name')?.textContent ?? null,
        composerEditable:
          editable === null ? null : editable.getAttribute('contenteditable') === 'true',
      };
    })
    .catch(() => null);
}

/**
 * Create a session and seed it with messages, through the product's own
 * bridge (preload -> ipcMain -> Host -> SQLite).
 *
 * Nothing is written behind the product's back: the rows land in the same
 * store the app reads from, in the same shape the app writes.
 *
 * The seed RETRIES while the Host is not up yet: the desktop Host answers
 * "Desktop Host session API is not running" for the first seconds of a cold
 * launch, and a seed that lands in that window would fail the whole sample
 * for a reason that has nothing to do with the measurement.
 */
export async function seedSession(page, options) {
  const { sessionId, title, workingDirectory, messages } = options;
  const deadline = Date.now() + (options.timeoutMs ?? 90_000);
  let lastError = null;
  for (;;) {
    try {
      const result = await seedSessionOnce(page, {
        sessionId,
        title,
        workingDirectory,
        messages,
        permissionProfile: options.permissionProfile,
      });
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
    } catch (error) {
      lastError = error;
      const message = String(error?.message ?? error);
      const hostNotReady =
        message.includes('is not running')
        || message.includes('not ready')
        || message.includes('Session API');
      if (!hostNotReady || Date.now() >= deadline) throw error;
      await page.waitForTimeout(1000);
    }
  }
}

async function seedSessionOnce(page, args) {
  return page.evaluate(
    async (input) => {
      const api = window.electronAPI;
      if (!api) throw new Error('window.electronAPI is not available');
      // The folder becomes a project of the profile, the way it does when a
      // user opens one. Without it the session has no project group: the
      // sidebar groups sessions by project, so it would list nothing, and
      // the welcome view would have no project to select (and its composer
      // stays disabled).
      let projectRegistered = null;
      try {
        if (api.projects?.addRecentFolder) {
          projectRegistered = await api.projects.addRecentFolder(input.workingDirectory);
        }
      } catch (error) {
        projectRegistered = `ERROR: ${String(error?.message ?? error).slice(0, 160)}`;
      }
      const created = await api.thread.create({
        id: input.sessionId,
        title: input.title,
        working_directory: input.workingDirectory,
        // 'auto' keeps a tool call from waiting for an approval prompt, which
        // would stall a measurement instead of exercising the streaming path.
        permission_profile: input.permissionProfile,
      });
      const replaced = await api.message.replace(input.sessionId, input.messages, 0);
      // Read the transcript back through the same bridge: a seed that the
      // product cannot read back is not a seed, and a scenario that measures
      // an empty transcript reports numbers about nothing.
      const readBack = await api.message.getBySession(input.sessionId, {
        includeSuperseded: true,
      });
      return {
        createdId: created?.id ?? null,
        replaced,
        readBackCount: Array.isArray(readBack) ? readBack.length : null,
        projectRegistered,
      };
    },
    args,
  );
}

/**
 * Mark the onboarding as done, through the app's own flag.
 *
 * The first-launch wizard covers the whole shell, so a profile that has not
 * been through it cannot be measured at all. This is the same localStorage
 * key the app itself writes when the wizard finishes.
 */
export async function completeOnboarding(page) {
  await page.evaluate(() => {
    localStorage.setItem('duya-onboarding-completed', 'true');
  });
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
