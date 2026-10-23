#!/usr/bin/env node
/**
 * Agent C measurement runner — React state-update / unrelated-region re-render.
 *
 * Drives the real Electron app in preview mode (production renderer build,
 * `file://` URL — never the 3000-port dev server, which another worktree may
 * be holding) and measures what happens in the sidebar while the user types.
 *
 * Usage (from the repo root of this checkout):
 *
 *   node e2e/perf/agents/agent-c/measure.mjs --scenario draft --chars 60
 *   node e2e/perf/agents/agent-c/measure.mjs --scenario home  --chars 60 --out out.json
 *
 * Flags:
 *   --scenario draft|home   Which composer to type into.
 *                            draft = the lazy new-chat composer (its draft is
 *                                   persisted to the conversation store on every
 *                                   keystroke).
 *                            home  = the welcome-screen composer (local state).
 *   --chars N               How many characters to type (default 60).
 *   --interval MS           Delay between keystrokes (default 50).
 *   --repeats N             Measurement repeats; the script reports each run
 *                           separately and the median (default 1).
 *   --out FILE              Write the raw JSON report here.
 *   --no-lock               Do not take the shared benchmark lock (use only
 *                           when the caller already holds it).
 *   --keep-open             Leave the app open (debugging).
 *
 * The script takes the shared measurement lock by default so a run on this
 * machine is not contaminated by another agent's build or measurement.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const PROBE_SOURCE = fs.readFileSync(path.join(HERE, 'probe.js'), 'utf8');

const LOCK_SCRIPT =
  process.env.DUYA_PERF_LOCK ?? 'E:/Projects/duya/.claude/perf-bench-lock.mjs';

// ── args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : true;
};
const scenario = String(flag('scenario', 'draft'));
const chars = Number(flag('chars', 60));
const interval = Number(flag('interval', 50));
const repeats = Number(flag('repeats', 1));
const outFile = flag('out', null);
const useLock = flag('no-lock', false) !== true;
const keepOpen = flag('keep-open', false) === true;
const settle = Number(flag('settle', 3000));
// A fixed profile directory lets a run reuse a seeded fixture (see
// `seed-sessions.mjs`) instead of starting from an empty database.
const userDataFlag = flag('user-data', null);
// The Host process resolves its own database from the namespace config root
// (`~/.duya/test-namespaces/<ns>`), so a seeded fixture is only visible to a
// run that uses the SAME namespace the seeding run used.
const namespaceFlag = flag('namespace', null);

// ── helpers ─────────────────────────────────────────────────────────────────
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return round(sorted[low]);
  return round(sorted[low] + (sorted[high] - sorted[low]) * (rank - low));
};
const round = (value) => (value === null ? null : Math.round(value * 100) / 100);
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
};

let lockHeld = false;
function acquireLock() {
  if (!useLock) return;
  if (!fs.existsSync(LOCK_SCRIPT)) {
    console.warn(`[agent-c] lock script not found at ${LOCK_SCRIPT}; running unlocked`);
    return;
  }
  const result = spawnSync(process.execPath, [LOCK_SCRIPT, 'acquire', 'agentC-state'], {
    stdio: 'inherit',
  });
  if (result.status === 0) {
    lockHeld = true;
    return;
  }
  if (result.status === 2) {
    console.error('[agent-c] benchmark lock is busy; not measuring under contention.');
    process.exit(2);
  }
  throw new Error(`[agent-c] lock acquisition failed with status ${result.status}`);
}
function releaseLock() {
  if (!lockHeld) return;
  spawnSync(process.execPath, [LOCK_SCRIPT, 'release'], { stdio: 'inherit' });
  lockHeld = false;
}

// ── app launch ──────────────────────────────────────────────────────────────
async function launch(namespace) {
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
  const deadline = Date.now() + 60_000;
  let page = app.windows()[0];
  while (!page && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    page = app.windows()[0];
  }
  if (!page) throw new Error('Electron did not open a BrowserWindow');
  await page.waitForFunction(
    () => typeof window.electronAPI !== 'undefined',
    undefined,
    { timeout: 60_000 },
  );
  // The onboarding flow is a lazily imported full-screen overlay. It mounts
  // a beat after hydration and steals the caret from the composer, so the
  // keystrokes stop landing halfway through the run. Mark onboarding as done
  // and reload so the measured app is the app under test, not a modal.
  await page.evaluate(() => {
    try {
      window.localStorage.setItem('duya-onboarding-completed', '1');
    } catch {
      // storage unavailable; the overlay may still appear
    }
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.app-shell-root', { timeout: 60_000 });
  return { app, page };
}

/** Put the app into the scenario's state and focus the composer. */
async function prepareScenario(page) {
  const step = (message) => console.error(`[agent-c] ${message}`);
  if (scenario === 'draft') {
    // The "新对话" action lives on the Work tab as a plain button; the Bots
    // tab hides it behind the "+" dropdown.
    step('clicking the work tab');
    await clickInPage(page, '[data-testid="sidebar-tab-work"]');
    step('waiting for the new-chat button');
    await page.waitForSelector('.sidebar-new-chat-btn', { timeout: 30_000 });
    step('clicking the new-chat button');
    await clickInPage(page, '.sidebar-new-chat-btn');
  }
  step('waiting for the composer');
  const composer = page.locator('.app-content div[role="textbox"][contenteditable="true"]').first();
  await composer.waitFor({ state: 'visible', timeout: 30_000 });
  step('focusing the composer');
  // A real mouse click, not a synthetic one: the composer's own handlers
  // rely on the trusted event, and a synthetic click leaves the contenteditable
  // without the caret, so the keystrokes stop landing after a few hundred
  // characters.
  await composer.click({ timeout: 15_000 });
  await composer.evaluate((node) => node.focus());
  step('composer ready');
}

/**
 * Click an element by selector.
 *
 * `element.click()` from inside the page is used instead of Playwright's
 * actionability-checked click: the sidebar sits under overlays (onboarding,
 * dialogs) that never become "stable" for the actionability check, and the
 * check then waits out the whole timeout instead of reporting what is on
 * screen.
 */
async function clickInPage(page, selector) {
  const clicked = await page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node) return false;
    node.click();
    return true;
  }, selector);
  if (!clicked) throw new Error(`selector not found: ${selector}`);
}

/**
 * Positive control: switching the sidebar tab MUST re-render the sidebar.
 * If the probe cannot see that, it cannot see anything, and the typing
 * measurement below would silently report "no re-renders" for the wrong
 * reason. Fail loudly instead.
 */
async function runControl(page) {
  console.error('[agent-c] control: resetting the probe');
  await page.evaluate(() => window.__duyaPerfReset());
  console.error('[agent-c] control: switching the sidebar tab');
  await clickInPage(page, '[data-testid="sidebar-tab-work"]');
  await page.waitForTimeout(500);
  const raw = await page.evaluate(() => window.__duyaPerfRead());
  console.error(`[agent-c] control: ${raw.renders.sidebar} sidebar re-renders`);
  return raw.renders;
}

async function runOnce(page, index) {
  await page.evaluate(PROBE_SOURCE);
  await page.waitForFunction(() => typeof window.__duyaPerfReset === 'function');
  await page.evaluate(() => window.__duyaPerfReset());

  const composer = page.locator('.app-content div[role="textbox"][contenteditable="true"]').first();
  const text = 'a'.repeat(chars);
  const started = Date.now();
  // One `type` call with a per-key delay: a per-character round trip would
  // add driver overhead to every keystroke and inflate the wall clock.
  // The run is split into chunks so a focus loss (something in the shell
  // taking the caret) can be noticed and undone instead of silently
  // dropping the rest of the characters.
  const chunk = 20;
  let refocuses = 0;
  for (let offset = 0; offset < text.length; offset += chunk) {
    const focused = await page.evaluate(() => {
      const el = document.querySelector('.app-content div[role="textbox"][contenteditable="true"]');
      return Boolean(el) && document.activeElement === el;
    });
    if (!focused) {
      refocuses += 1;
      await composer.evaluate((node) => node.focus());
    }
    await page.keyboard.type(text.slice(offset, offset + chunk), { delay: interval });
  }
  const wallMs = Date.now() - started;
  // Let the last frame settle so the tail of the interaction window is not
  // cut off mid-commit.
  await page.waitForTimeout(500);

  const raw = await page.evaluate(() => window.__duyaPerfRead());
  // Sanity gate: if the keystrokes did not reach the composer, the run
  // measured an idle app and every number below is meaningless.
  if (raw.interactions.length < chars * 0.9) {
    throw new Error(
      `only ${raw.interactions.length} of ${chars} keystrokes reached the composer ` +
        `(focus losses: ${JSON.stringify(raw.focusLosses.slice(0, 5))}) — the run is not comparable`,
    );
  }
  return {
    run: index,
    wallClockMs: wallMs,
    typedCharacters: chars,
    'interact.p50_ms': percentile(raw.interactions, 50),
    'interact.p95_ms': percentile(raw.interactions, 95),
    'frame.p50_ms': percentile(raw.frames, 50),
    'frame.p95_ms': percentile(raw.frames, 95),
    'commit.count': raw.mutationBatches,
    'dom.mutations': raw.mutations,
    'dom.nodes': raw.domNodes,
    'longtask.count': raw.longtasks.length,
    'longtask.total_ms': round(raw.longtasks.reduce((sum, d) => sum + d, 0)),
    'renders.sidebar': raw.renders.sidebar,
    'renders.column': raw.renders.column,
    focusRefocuses: refocuses,
    focusLosses: raw.focusLosses.length,
    framesSampled: raw.samples,
    rawInteractions: raw.interactions.length,
  };
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(path.join(REPO_ROOT, 'dist', 'index.html'))) {
    throw new Error(
      'dist/index.html is missing. Build the renderer first: `npx vite build` ' +
        '(and `npm run build:electron` for the main/preload bundle).',
    );
  }
  acquireLock();
  const namespace = namespaceFlag
    ? String(namespaceFlag)
    : `perf-agent-c-${scenario}-${process.pid}`;
  const { app, page } = await launch(namespace);
  try {
    // Install the probe and let the app finish loading before measuring.
    console.error('[agent-c] installing the probe');
    await page.evaluate(PROBE_SOURCE);
    await page.waitForFunction(() => typeof window.__duyaPerfReset === 'function');
    console.error('[agent-c] waiting for the app to settle');
    if (settle > 0) await page.waitForTimeout(settle);

    // Positive control: switching the sidebar tab MUST re-render the
    // sidebar. If the probe cannot see that, it cannot see anything, and the
    // typing measurement below would silently report "no re-renders" for the
    // wrong reason. Fail loudly instead.
    const control = await runControl(page);
    if (!control || control.sidebar <= 0) {
      throw new Error(
        `probe control failed: a sidebar tab switch re-rendered ${control?.sidebar ?? 0} sidebar fibers`,
      );
    }
    console.error(`[agent-c] probe control ok (${control.sidebar} sidebar fibers re-rendered)`);

    await prepareScenario(page);
    const runs = [];
    for (let i = 0; i < repeats; i += 1) {
      runs.push(await runOnce(page, i));
    }
    const summary = {
      scenario,
      fixture: 'perf/typing-30s',
      chars,
      intervalMs: interval,
      repeats,
      runs,
      medians: {
        'interact.p95_ms': median(runs.map((r) => r['interact.p95_ms'])),
        'frame.p95_ms': median(runs.map((r) => r['frame.p95_ms'])),
        'commit.count': median(runs.map((r) => r['commit.count'])),
        'dom.mutations': median(runs.map((r) => r['dom.mutations'])),
        'renders.sidebar': median(runs.map((r) => r['renders.sidebar'])),
      },
      control: {
        note: 'sidebar tab switch — the probe must see this re-render',
        'renders.sidebar': control.sidebar,
      },      environment: {
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        os: process.env.PROCESSOR_IDENTIFIER ?? 'unknown cpu',
      },
      lockHeld,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (outFile) {
      fs.writeFileSync(path.resolve(REPO_ROOT, outFile), JSON.stringify(summary, null, 2));
      console.error(`[agent-c] wrote ${outFile}`);
    }
  } finally {
    if (!keepOpen) {
      // Kill the whole Electron tree FIRST. `app.close()` waits for the main
      // process to exit, and the desktop main process keeps background
      // services (bridge daemon, recorder worker) alive, so awaiting the
      // close can hang long after the report was written.
      const pid = app.process()?.pid;
      if (pid) {
        try {
          spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
        } catch {
          try {
            app.process()?.kill();
          } catch {
            // already gone
          }
        }
      }
      await app.close().catch(() => undefined);
    }
    releaseLock();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[agent-c] measurement failed:', error);
    releaseLock();
    process.exit(1);
  });
