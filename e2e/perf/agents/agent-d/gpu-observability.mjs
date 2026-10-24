#!/usr/bin/env node
/**
 * gpu-observability.mjs — Agent D's GPU measurement harness.
 *
 * WHAT IT MEASURES
 *   - `frame.p95_ms`     — p95 of the interval between adjacent
 *                          `requestAnimationFrame` callbacks. This is the
 *                          COMPOSITOR-visible frame cadence.
 *   - `longtask.total_ms` / `longtask.count` — the PerformanceObserver
 *                          `longtask` entries: total main-thread blocking
 *                          time and how many tasks blocked for >50ms.
 *
 *   The two are reported SEPARATELY on purpose. A frame interval says how
 *   often the screen updated; a long task says how long the MAIN THREAD was
 *   blocked. A GPU problem shows up in the first; a React/JS problem shows up
 *   in the second. Merging them hides exactly the distinction this whole
 *   measurement exists to make.
 *
 * THE THREE GPU STATES
 *   1. `gpu-normal`         - the app as shipped. `app.getGPUFeatureStatus()`
 *                             reports GPU compositing.
 *   2. `gpu-unavailable`    - the same build launched with `--disable-gpu`.
 *                             This is a LAUNCH SWITCH: it changes nothing in
 *                             the product, it only reproduces the state a
 *                             user hits with a broken driver.
 *   3. `webgl-context-lost` - the shipped build, with the terminal's WebGL
 *                             context lost at runtime (`WEBGL_lose_context`),
 *                             which is the product's own degradation path.
 *
 * USAGE
 *   node e2e/perf/agents/agent-d/gpu-observability.mjs --mode gpu-normal
 *   node e2e/perf/agents/agent-d/gpu-observability.mjs --mode all --repeats 3
 *
 * The script drives the REAL Electron main process from `dist-electron/`
 * through Playwright's `_electron` API. It is deliberately NOT a Playwright
 * test file: `e2e/playwright.config.ts` collects only the smoke/ipc/turn/
 * ui-states projects, and a performance harness that runs inside `npm test`
 * would pollute every other agent's baseline.
 */

import { _electron as electron } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const RESULTS_DIR = path.join(HERE, 'results');

/** Progress marker. Goes to stderr so it is never mixed into the result
 *  summary on stdout, and is flushed immediately so a hung run says WHERE. */
function step(message) {
  process.stderr.write(`[agent-d ${new Date().toISOString()}] ${message}\n`);
}

const MODES = ['gpu-normal', 'gpu-unavailable', 'webgl-context-lost'];

/**
 * The measurement lock state, handed over by `run-with-lock.mjs`.
 *
 * The wrapper resolves the lock script and acquires the lock, then passes the
 * outcome down through the environment. The state is recorded even when the
 * lock was never held: a report that admits it was taken without the lock is
 * better than a report that pretends otherwise.
 */
function readLockState() {
  const raw = process.env.DUYA_PERF_LOCK_STATE;
  if (!raw) {
    return {
      enabled: false,
      held: false,
      reason: 'no lock state provided (harness started without run-with-lock.mjs)',
    };
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    return { enabled: false, held: false, reason: `unreadable lock state: ${String(err)}` };
  }
}

/** How long each scenario runs. Long enough to be a measurement, short
 *  enough that a full three-mode sweep stays inside one bench-lock window. */
const SCENARIO_MS = {
  'shell-idle': 4000,
  'terminal-output': 10000,
};

// =============================================================================
// CLI
// =============================================================================

function parseArgs(argv) {
  const args = { mode: 'gpu-normal', repeats: 1, out: null, smoke: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--mode') args.mode = argv[++i];
    else if (flag === '--repeats') args.repeats = Number(argv[++i]);
    else if (flag === '--out') args.out = argv[++i];
    else if (flag === '--smoke') args.smoke = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
  }
  return args;
}

// =============================================================================
// Metric collection (runs inside the renderer)
// =============================================================================

/**
 * Install the collectors.
 *
 * The rAF loop records the DELTA between adjacent callbacks, not the absolute
 * timestamp: the delta is the frame interval the user perceives. The
 * longtask observer is installed with `buffered: true` so tasks that started
 * before the collector was installed are not lost.
 */
const START_COLLECTORS = () => {
  const state = {
    frames: [],
    longTasks: [],
    startedAt: performance.now(),
    running: true,
  };
  window.__agentDPerf = state;

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
    state.observer = observer;
  } catch (err) {
    state.longTaskError = String(err);
  }

  let previous = performance.now();
  const tick = (now) => {
    if (!state.running) return;
    state.frames.push(now - previous);
    previous = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
};

/** Stop the collectors and return the raw samples. */
const STOP_COLLECTORS = () => {
  const state = window.__agentDPerf;
  if (!state) return null;
  state.running = false;
  try {
    state.observer?.disconnect();
  } catch {
    // Already disconnected.
  }
  return { frames: state.frames.slice(), longTasks: state.longTasks.slice(), longTaskError: state.longTaskError ?? null };
};

/**
 * Summarise the raw samples.
 *
 * `frame.p95_ms` uses the NEAREST-RANK method (the ceil(0.95 * n)-th
 * smallest sample), which is the definition the perf plan's metric contract
 * uses. The mean is reported alongside it because a mean alone hides a
 * bimodal distribution - and a GPU stall shows up as exactly that.
 */
function summarise({ frames, longTasks, longTaskError }) {
  const sorted = frames.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const nearestRank = (p) => {
    if (sorted.length === 0) return null;
    const rank = Math.max(1, Math.ceil(p * sorted.length));
    return sorted[rank - 1];
  };
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const total = longTasks.reduce((acc, t) => acc + t.duration, 0);
  return {
    frame_count: sorted.length,
    'frame.p95_ms': nearestRank(0.95),
    'frame.p50_ms': nearestRank(0.5),
    'frame.mean_ms': sorted.length ? Number((sum / sorted.length).toFixed(3)) : null,
    'frame.max_ms': sorted.length ? Number(sorted[sorted.length - 1].toFixed(3)) : null,
    'longtask.count': longTasks.length,
    'longtask.total_ms': Number(total.toFixed(3)),
    'longtask.max_ms': longTasks.length
      ? Number(Math.max(...longTasks.map((t) => t.duration)).toFixed(3))
      : 0,
    longtask_error: longTaskError ?? null,
  };
}

// =============================================================================
// App driving
// =============================================================================

async function launchApp(mode, namespace) {
  const userDataRoot = path.join(REPO_ROOT, '.e2e-userdata', namespace);
  fs.mkdirSync(userDataRoot, { recursive: true });

  const args = ['.', `--duya-namespace=${namespace}`, `--user-data-dir=${userDataRoot}`];
  if (mode === 'gpu-unavailable') {
    // Reproduce "the GPU is not usable" WITHOUT changing the product: this is
    // a Chromium launch switch, not a product setting.
    args.push('--disable-gpu');
  }

  const app = await electron.launch({
    args,
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

  const deadline = Date.now() + 60_000;
  let page = app.windows()[0];
  while (!page && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    page = app.windows()[0];
  }
  if (!page) throw new Error('Electron did not open a window within 60s');

  await page.waitForLoadState('domcontentloaded', { timeout: 60_000 });
  await page.waitForFunction(() => typeof window.electronAPI !== 'undefined', { timeout: 30_000 });

  return { app, page };
}

/** Read the GPU state straight out of the main process. */
async function readMainProcessGpuState(app) {
  const featureStatus = await app.evaluate(({ app: electronApp }) => electronApp.getGPUFeatureStatus());
  let gpuInfo = null;
  try {
    gpuInfo = await app.evaluate(({ app: electronApp }) => electronApp.getGPUInfo('basic'));
  } catch (err) {
    gpuInfo = { error: String(err) };
  }
  return { featureStatus, gpuInfo };
}

/** Read the status the renderer sees through the new `gpu` bridge. */
async function readRendererGpuStatus(page) {
  try {
    return await page.evaluate(async () => {
      const api = window.electronAPI;
      if (!api || !api.gpu || !api.gpu.getStatus) return null;
      return await api.gpu.getStatus();
    });
  } catch (err) {
    return { error: String(err) };
  }
}

/**
 * Open a real session and the terminal panel.
 *
 * Everything here goes through the product's own paths: the session is
 * created over the preload bridge, the sidebar row is CLICKED, and the
 * terminal is opened with the panel launcher the user clicks. Nothing
 * fabricates renderer state, because a fabricated state would measure a
 * screen the product never renders.
 */
async function openTerminalPanel(page, title, namespace) {
  const workspace = path.join(REPO_ROOT, '.e2e-userdata', namespace, 'workspace-agent-d');
  fs.mkdirSync(workspace, { recursive: true });

  // Creating the session goes through the desktop host's session API, which
  // is still starting up when the window first appears. A failed create is a
  // startup race, not a broken product, so it is retried rather than
  // reported as a failed measurement.
  let created = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 5 && !created; attempt += 1) {
    try {
      created = await page.evaluate(async ({ id, title: threadTitle, working_directory }) => {
        const api = window.electronAPI;
        return api.thread.create({ id, title: threadTitle, working_directory });
      }, { id: `agentd-${Date.now()}-${attempt}`, title, working_directory: workspace });
    } catch (err) {
      lastError = err;
      await page.waitForTimeout(2000);
    }
  }
  if (!created?.id) {
    throw new Error(`thread.create did not return a session id: ${String(lastError)}`);
  }

  // Reload so the sidebar lists the new session, then CLICK it. The panel
  // zone force-closes itself outside a session view, so the terminal can only
  // be opened once a session is really active.
  //
  // Two localStorage writes, both the product's own state format and both
  // used by the repository's existing E2E specs (`e2e/ipc/
  // session-archive-ui.spec.ts`):
  //   - `duya-onboarding-completed` skips the onboarding wizard, which
  //     otherwise covers the sidebar on a fresh userData;
  //   - `duya-conversations` with `lastSyncAt: 0` defeats the store's
  //     30-second staleness short-circuit, so the hydrated store really
  //     reads the session that was just created.
  await page.evaluate(({ sessionId }) => {
    window.localStorage.setItem('duya-onboarding-completed', 'true');
    window.localStorage.setItem(
      'duya-conversations',
      JSON.stringify({
        state: {
          currentView: 'chat',
          settingsTab: 'general',
          activeThreadId: null,
          collapsedProjects: [],
          expandedThreads: [],
          lastSyncAt: 0,
        },
        version: 0,
      }),
    );
  }, { sessionId: created.id });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.electronAPI !== 'undefined', { timeout: 30_000 });
  await page.waitForFunction(() => !!document.querySelector('.app-sidebar'), { timeout: 60_000 });

  // The sidebar has two tabs and comes up on Bots; the session list lives on
  // the Work tab. Switch first, then wait for the row.
  const workTab = page.getByTestId('sidebar-tab-work');
  if (await workTab.count()) {
    if ((await workTab.getAttribute('aria-selected')) !== 'true') {
      await workTab.click();
    }
  }

  // Clicking the session row is the user path, and it is not always a
  // one-shot: the row can be clicked before the store has hydrated the
  // session, and the click then lands on nothing. The titlebar launchers are
  // the proof that a session view is really active (they only render when
  // `currentView === 'chat' && activeThreadId`), so wait for them and retry
  // the click if they do not show up.
  const launcher = page.locator('.titlebar-panel-launcher[data-page-id="terminal"]');
  const threadRow = page.locator(`.thread-item[title="${title}"]`).first();
  let opened = false;
  for (let attempt = 1; attempt <= 3 && !opened; attempt += 1) {
    await threadRow.waitFor({ state: 'visible', timeout: 30_000 });
    await threadRow.click();
    try {
      await launcher.waitFor({ state: 'visible', timeout: 10_000 });
      opened = true;
    } catch {
      step(`session view did not open after click ${attempt}`);
    }
  }
  if (!opened) throw new Error('the session view never opened (titlebar launchers missing)');
  await page.bringToFront();

  await launcher.click();

  await page.waitForSelector('.terminal-panel', { timeout: 30_000 });
  // The WebGL renderer draws into a canvas; the DOM renderer does not create
  // one at all. Wait for the screen element, which both have.
  await page.waitForSelector('.terminal-xterm-host .xterm-screen', { timeout: 30_000 });
  // The helper textarea is xterm's real input surface. Waiting for it means
  // the terminal is open AND mounted, so the workload that follows is typed
  // into a live terminal instead of into nothing.
  await page.waitForSelector('.terminal-xterm-host .xterm-helper-textarea', {
    state: 'attached',
    timeout: 30_000,
  });
  await page.bringToFront();
  return { sessionId: created.id, workspace };
}

/** Which renderer the terminal is actually using right now. */
async function readTerminalRenderer(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('.terminal-panel');
    return {
      dataRenderer: panel?.getAttribute('data-renderer') ?? null,
      badge: document.querySelector('.terminal-appearance-menu-foot-renderer')?.textContent ?? null,
      canvasCount: document.querySelectorAll('.terminal-xterm-host canvas').length,
    };
  });
}

/**
 * Force a WebGL context loss on the terminal's canvas.
 *
 * `WEBGL_lose_context` is the standard way to simulate a driver reset. The
 * xterm WebGL renderer waits 3000ms after `webglcontextlost` before it
 * declares the context lost (it first waits for a restore), so the caller
 * has to wait longer than that.
 */
async function triggerWebglContextLoss(page) {
  return page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll('.terminal-xterm-host canvas'));
    // The terminal host holds more than one canvas: the renderer's own
    // WebGL canvas plus the texture-atlas and decoration canvases, which are
    // 2D canvases. A canvas only ever has one context type, so asking for a
    // 2D context first tells the two kinds apart WITHOUT creating a context
    // on a canvas that had none.
    for (const canvas of canvases) {
      if (canvas.getContext('2d')) continue;
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) continue;
      const ext = gl.getExtension('WEBGL_lose_context');
      if (!ext) continue;
      ext.loseContext();
      return { ok: true, canvasCount: canvases.length };
    }
    return { ok: false, reason: 'no webgl context', canvasCount: canvases.length };
  });
}

/**
 * Flood the terminal with real output.
 *
 * The command runs in the terminal's own PTY, so the bytes travel the same
 * path a user's command does: main process -> pty -> renderer -> xterm.
 *
 * The volume is deliberately moderate. A heavier flood saturates the MAIN
 * THREAD, and a saturated main thread hides the difference a GPU comparison
 * is looking for: the long-task time then dwarfs the frame time and every
 * mode looks the same. This workload keeps the renderer busy without
 * saturating it, so the compositor's cost is still visible.
 */
async function terminalOutputWorkload(page, ms) {
  const textarea = page.locator('.terminal-xterm-host .xterm-helper-textarea').first();
  await textarea.waitFor({ state: 'attached', timeout: 30_000 });
  await textarea.focus();
  const deadline = Date.now() + ms;
  let i = 0;
  while (Date.now() < deadline) {
    i += 1;
    await page.keyboard.type(
      `node -e "for(let k=0;k<120;k++)console.log('agent-d line '+k+' '+'x'.repeat(60))"`,
      { delay: 0 },
    );
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
  }
  return i;
}

/**
 * A snapshot of what the renderer currently shows.
 *
 * Used when a scenario fails: "the element was not found" is a useless
 * failure message, and the interesting question is always "what was on the
 * screen instead".
 */
async function diagnose(page) {
  try {
    return await page.evaluate(() => ({
      titlebarLaunchers: document.querySelectorAll('.titlebar-panel-launcher').length,
      terminalPanels: document.querySelectorAll('.terminal-panel').length,
      xtermHosts: document.querySelectorAll('.terminal-xterm-host').length,
      helperTextareas: document.querySelectorAll('.xterm-helper-textarea').length,
      composerShells: document.querySelectorAll('.chat-composer-shell').length,
      composerInputs: document.querySelectorAll('[role="textbox"][contenteditable]').length,
      threadItems: document.querySelectorAll('.thread-item').length,
      bodyText: (document.body.innerText ?? '').slice(0, 300),
    }));
  } catch (err) {
    return { error: String(err) };
  }
}

/** Measure one scenario: collect, run the workload, collect again. */
async function measureScenario(page, name, workload) {
  await page.evaluate(START_COLLECTORS);
  await page.waitForTimeout(500);
  const workloadResult = await workload();
  const raw = await page.evaluate(STOP_COLLECTORS);
  if (!raw) throw new Error(`collectors for scenario "${name}" never started`);
  return { scenario: name, workloadResult, ...summarise(raw) };
}

// =============================================================================
// One run
// =============================================================================

async function runOnce(mode, repeat, smoke = false) {
  const namespace = `agentd-gpu-${mode}-${repeat}-${Date.now()}`;
  const startedAt = new Date().toISOString();
  step(`launching mode=${mode} repeat=${repeat} namespace=${namespace}`);
  const { app, page } = await launchApp(mode, namespace);
  step('window ready');

  const result = {
    mode,
    repeat,
    startedAt,
    build: 'worktree build (dist-electron/main.js + dist/index.html)',
    mainProcessGpu: null,
    rendererGpuStatus: null,
    terminal: null,
    scenarios: [],
    errors: [],
  };

  try {
    result.mainProcessGpu = await readMainProcessGpuState(app);
    step('main-process GPU state read');
    result.rendererGpuStatus = await readRendererGpuStatus(page);
    step('renderer GPU status read');

    // Scenario 1: the shell at rest, with a real session open.
    const sessionTitle = `agent-d ${mode} ${repeat} ${Date.now() % 100000}`;
    await openTerminalPanel(page, sessionTitle, namespace);
    step('terminal panel open');
    result.terminal = await readTerminalRenderer(page);

    if (smoke) {
      // Functional check only: the flow works, the GPU state is readable.
      // No timing is collected, so this run is not a measurement.
      result.smoke = true;
    } else {
      // Each scenario is isolated: a scenario that throws must not take the
      // remaining scenarios with it, because a missing measurement is worse
      // than a failed one - it reads as "no long tasks" instead of "no data".
      const scenario = async (name, workload) => {
        try {
          const measured = await measureScenario(page, name, workload);
          result.scenarios.push(measured);
          step(
            `${name}: frame.p95=${measured['frame.p95_ms']}ms ` +
              `longtask.count=${measured['longtask.count']} ` +
              `longtask.total=${measured['longtask.total_ms']}ms`,
          );
        } catch (err) {
          const state = await diagnose(page);
          result.errors.push(`${name}: ${String(err && err.stack ? err.stack : err)} | dom=${JSON.stringify(state)}`);
          step(`${name} FAILED: ${JSON.stringify(state)}`);
        }
      };

      await scenario('shell-idle', async () => {
        await page.waitForTimeout(SCENARIO_MS['shell-idle']);
        return null;
      });

      // The terminal's WebGL renderer under real PTY output. This is the
      // scenario the GPU domain actually owns: the bytes travel main process
      // -> pty -> renderer -> xterm, so the compositor and the WebGL canvas
      // are both exercised the way a user's command exercises them.
      await scenario('terminal-output', async () => {
        const commands = await terminalOutputWorkload(page, SCENARIO_MS['terminal-output']);
        return { commands };
      });

      result.terminalAfter = await readTerminalRenderer(page);

      // Scenario 4 (only for the context-loss mode): the same terminal
      // workload AFTER the context was lost, so the WebGL and DOM renderers
      // are compared under identical output.
      if (mode === 'webgl-context-lost') {
        const loss = await triggerWebglContextLoss(page);
        result.contextLoss = { ...loss, at: new Date().toISOString() };
        if (loss.ok) {
          // xterm waits 3000ms for a restore before declaring the loss.
          await page.waitForTimeout(4000);
        }
        result.terminalAfterLoss = await readTerminalRenderer(page);
        result.rendererGpuStatusAfterLoss = await readRendererGpuStatus(page);
        await scenario('terminal-output-after-context-loss', async () => {
          const commands = await terminalOutputWorkload(page, SCENARIO_MS['terminal-output']);
          return { commands };
        });
      }
    }
  } catch (err) {
    result.errors.push(String(err && err.stack ? err.stack : err));
  } finally {
    step('closing the app');
    try {
      // A graceful close can hang (the app keeps background workers alive),
      // and a hung close would keep the measurement lock held. Give it a
      // deadline, then force the process tree down.
      const pid = app.process().pid;
      await Promise.race([
        app.close(),
        new Promise((resolve) => setTimeout(resolve, 8000)),
      ]);
      if (pid && app.process().pid) {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
      }
    } catch {
      // The app may already be gone; the metrics are what matter.
    }
    step('app closed');
  }

  result.finishedAt = new Date().toISOString();
  return result;
}

// =============================================================================
// Entry point
// =============================================================================

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      'Usage: node e2e/perf/agents/agent-d/gpu-observability.mjs --mode <gpu-normal|gpu-unavailable|webgl-context-lost|all> [--repeats N] [--out file.json]\n',
    );
    return;
  }

  const modes = args.mode === 'all' ? MODES : [args.mode];
  for (const mode of modes) {
    if (!MODES.includes(mode)) throw new Error(`unknown mode: ${mode}`);
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runs = [];

  for (const mode of modes) {
    for (let repeat = 1; repeat <= args.repeats; repeat += 1) {
      process.stdout.write(`[agent-d] mode=${mode} repeat=${repeat}/${args.repeats}\n`);
      const run = await runOnce(mode, repeat, args.smoke);
      runs.push(run);
      for (const scenario of run.scenarios) {
        process.stdout.write(
          `  ${scenario.scenario}: frame.p95=${scenario['frame.p95_ms']}ms ` +
            `longtask.count=${scenario['longtask.count']} longtask.total=${scenario['longtask.total_ms']}ms\n`,
        );
      }
      if (run.errors.length) {
        process.stdout.write(`  ERRORS: ${run.errors.join(' | ')}\n`);
      }
    }
  }

  const outFile = args.out ?? path.join(RESULTS_DIR, `gpu-${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ lock: readLockState(), runs }, null, 2), 'utf8');
  process.stdout.write(`[agent-d] wrote ${outFile}\n`);
}

main().catch((err) => {
  process.stderr.write(`[agent-d] fatal: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
