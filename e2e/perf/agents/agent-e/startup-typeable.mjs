#!/usr/bin/env node
/**
 * Agent E — `startup.typeable_ms` for the shared renderer.
 *
 * Measures the Desktop cold-start path against the PRODUCTION renderer
 * bundle (`dist/`), never a Vite dev server: a dev server measures esbuild
 * transform latency, not the shipped artifact.
 *
 * Why preview mode (`DUYA_PREVIEW_MODE=true`): `dev-detector.ts` only probes
 * ports 3000-3005, and this machine usually has another worktree's Vite on
 * 3000. Preview mode makes the main process load `file://<cwd>/dist/index.html`
 * from THIS checkout, so the numbers belong to the code under test.
 *
 * Metrics per sample (contract: `docs/exec-plans/active/2026-10-23-desktop-performance-hill-climbing.md`):
 *   startup.typeable_ms   launch call -> composer accepts a keystroke
 *   startup.firstPaint_ms launch call -> first contentful paint
 *   scriptDurationMs      CDP `Performance.getMetrics` ScriptDuration (main-thread script time)
 *   jsBytesFetched        bytes of JS the renderer actually fetched
 *
 * Usage:
 *   node e2e/perf/agents/agent-e/startup-typeable.mjs [--samples 5] [--json out.json]
 *
 * Requires: `dist/index.html` (vite build) and `dist-electron/main.js`
 * (npm run build:electron). No packages/ import — this file lives under e2e/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');

const args = process.argv.slice(2);
const samples = Number(args[args.indexOf('--samples') + 1]) || 5;
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;

if (!fs.existsSync(path.join(repoRoot, 'dist', 'index.html'))) {
  console.error('[agent-e] dist/index.html missing — run `npx vite build` first');
  process.exit(2);
}
if (!fs.existsSync(path.join(repoRoot, 'dist-electron', 'main.js'))) {
  console.error('[agent-e] dist-electron/main.js missing — run `npm run build:electron` first');
  process.exit(2);
}

const COMPOSER = '[role="textbox"][contenteditable="true"]';

/**
 * Environment for a measurement launch.
 *
 * The git settings point every clone at a closed port. The app clones the
 * official plugin marketplace at boot; that clone has a 120s timeout, and
 * it keeps the main process alive long past the point where the renderer
 * is measurable. It is irrelevant to renderer startup, so the measurement
 * makes it fail in milliseconds instead.
 */
function launchEnv(userDataRoot) {
  return {
    ...process.env,
    DUYA_TEST: '1',
    DUYA_PREVIEW_MODE: 'true',
    DUYA_TEST_USER_DATA_DIR: userDataRoot,
    DUYA_DAEMON_PORT: '0',
    LOG_LEVEL: 'ERROR',
    GIT_TERMINAL_PROMPT: '0',
    GIT_HTTP_PROXY: 'http://127.0.0.1:9',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.proxy',
    GIT_CONFIG_VALUE_0: 'http://127.0.0.1:9',
  };
}

/**
 * Close the app under a hard bound.
 *
 * `app.close()` alone is not enough here: the main process kicks off a
 * plugin-marketplace `git clone` at boot, and that clone keeps the process
 * alive for its own 120s timeout. Close with a deadline, then kill the
 * process tree.
 */
async function closeApp(app) {
  const pid = app.process().pid;
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('close timeout')), 8_000)),
    ]);
  } catch {
    if (pid && process.platform === 'win32') {
      const { execSync } = await import('node:child_process');
      try {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
      } catch {
        /* already gone */
      }
    }
  }
}

async function launch(userDataRoot, namespace) {
  const app = await electron.launch({
    args: ['.', `--duya-namespace=${namespace}`, `--user-data-dir=${userDataRoot}`],
    cwd: repoRoot,
    env: launchEnv(userDataRoot),
  });
  const deadline = Date.now() + 30_000;
  let page = app.windows()[0];
  while (!page && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    page = app.windows()[0];
  }
  if (!page) throw new Error('Electron did not create a BrowserWindow within 30s');
  await page.waitForFunction(() => typeof window.electronAPI !== 'undefined', null, { timeout: 30_000 });
  return { app, page };
}

/**
 * Seed the profile so the measured launches open a REAL chat session.
 *
 * This is not cosmetic. The composer on the home screen is
 * `<MessageInput disabled={!isHydrated || !selectedProject}>`: it only
 * becomes editable once the store has hydrated AND a project is selected,
 * and both of those are reached through `loadFromDatabase()`, which is
 * itself gated on `isHydrated`. A profile without a session therefore has a
 * permanently disabled composer, and "typeable" would never be reachable —
 * a measurement that waits for an enabled field would time out rather than
 * measure anything.
 *
 * The chat surface's own composer is rendered with `disabled={false}`
 * (`components/chat/ChatView.tsx`), so a profile that opens a real session
 * has a composer that becomes typeable as soon as the session renders.
 *
 * The seed runs in its own, unmeasured launch.
 */
async function prepareProfile(userDataRoot) {
  try {
    fs.rmSync(userDataRoot, { recursive: true, force: true });
  } catch {
    /* a leftover instance may still hold the directory */
  }
  fs.mkdirSync(userDataRoot, { recursive: true });

  const { app, page } = await launch(userDataRoot, 'agentE-seed');
  try {
    // The onboarding overlay would sit on top of the composer in every
    // measured sample. It is a localStorage flag, so setting it here
    // persists into the measured launches.
    await page.evaluate(() => localStorage.setItem('duya-onboarding-completed', 'true'));

    const sessionId = randomUUID();
    const created = await page.evaluate(
      async ({ id, dir }) => {
        const row = await window.electronAPI.thread.create({
          id,
          title: 'perf-fixture',
          working_directory: dir,
          project_name: 'perf-fixture',
          agent_type: 'main',
          agent_name: '',
        });
        await window.electronAPI.projects.addRecentFolder(dir);
        const listed = await window.electronAPI.thread.list();
        const ids = (Array.isArray(listed) ? listed : []).map((r) => r && r.id);
        return { id, rowId: row && row.id ? row.id : null, visible: ids.includes(id), listed: ids.length };
      },
      { id: sessionId, dir: repoRoot },
    );
    if (!created.rowId) throw new Error('could not seed a session row');
    // The store's orphan handling drops an `activeThreadId` that has no
    // matching row, so a session the renderer cannot see would send the
    // next launch back to the home screen.
    if (!created.visible) {
      throw new Error(`seeded session ${created.id} is not visible to the renderer (listed=${created.listed})`);
    }

    // Persist the UI state the app restores on boot: the chat view, with
    // the seeded session selected. `activeThreadId` and `currentView` are
    // both part of the persisted slice (stores/conversation-store.ts).
    await page.evaluate((id) => {
      localStorage.setItem(
        'duya-conversations',
        JSON.stringify({
          state: {
            currentView: 'chat',
            settingsTab: 'general',
            activeThreadId: id,
            collapsedProjects: [],
            expandedThreads: [],
            projectSortBy: 'lastActivity',
            projectGroupBy: 'project',
            lastSyncAt: 0,
            newChatDraft: null,
          },
          version: 0,
        }),
      );
    }, created.id);

    // Give the store a beat to persist before the profile is closed.
    await page.waitForTimeout(1500);
  } finally {
    await closeApp(app);
  }
}

async function runSample(index, userDataRoot) {
  const namespace = `agentE-perf-${process.pid}-${index}`;

  const t0 = Date.now();
  const { app, page } = await launch(userDataRoot, namespace);
  try {
    // The composer must EXIST and accept a keystroke. "Enabled" is not
    // enough: the field is contentEditable and can be present but inert
    // while React is still hydrating.
    //
    // One `waitForFunction` covers both halves — the element may not be in
    // the DOM yet, and it may exist while still being disabled.
    const typeable = await page
      .waitForFunction(
        (sel) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          el.focus();
          if (document.activeElement !== el) return false;
          el.textContent = 'x';
          const ok = (el.textContent || '').includes('x');
          el.textContent = '';
          return ok;
        },
        COMPOSER,
        { timeout: 30_000, polling: 50 },
      )
      .then(() => true)
      .catch(() => false);
    const t1 = Date.now();

    // The renderer-side metrics are collected even when the composer
    // milestone fails: the paint timings are independent of the store's
    // hydration, and dropping them would throw away most of the sample.
    const renderer = await page.evaluate(() => {
      const paints = performance.getEntriesByType('paint');
      const fcp = paints.find((p) => p.name === 'first-contentful-paint');
      const fp = paints.find((p) => p.name === 'first-paint');
      const scripts = performance.getEntriesByType('resource').filter((r) => r.name.endsWith('.js'));
      return {
        timeOrigin: performance.timeOrigin,
        fcp: fcp ? fcp.startTime : null,
        fp: fp ? fp.startTime : null,
        jsBytes: scripts.reduce((sum, r) => sum + (r.encodedBodySize || r.transferSize || 0), 0),
        jsCount: scripts.length,
        domNodes: document.getElementsByTagName('*').length,
      };
    });

    if (!typeable) {
      // Report WHY, so a failed sample is evidence rather than a shrug.
      const diag = await page
        .evaluate(() => ({
          url: location.href,
          textboxes: Array.from(document.querySelectorAll('[role="textbox"]')).map((e) => ({
            contenteditable: e.getAttribute('contenteditable'),
          })),
          body: (document.body?.innerText ?? '').slice(0, 200),
        }))
        .catch(() => ({ url: 'unknown' }));
      const error = `composer never became typeable: ${JSON.stringify(diag)}`;
      return {
        sample: index,
        startup_typeable_ms: null,
        startup_firstPaint_ms:
          renderer.fcp !== null ? Math.round(renderer.timeOrigin + renderer.fcp - t0) : null,
        renderer_fcp_after_nav_ms: renderer.fcp,
        domNodes: renderer.domNodes,
        jsBytesFetched: renderer.jsBytes,
        jsResources: renderer.jsCount,
        error,
      };
    }

    return {
      sample: index,
      startup_typeable_ms: t1 - t0,
      startup_firstPaint_ms: renderer.fcp !== null ? Math.round(renderer.timeOrigin + renderer.fcp - t0) : null,
      renderer_fcp_after_nav_ms: renderer.fcp,
      domNodes: renderer.domNodes,
      jsBytesFetched: renderer.jsBytes,
      jsResources: renderer.jsCount,
    };
  } finally {
    await closeApp(app);
  }
}

const results = [];
const profileRoot = path.join(repoRoot, '.e2e-userdata', `agentE-profile-${process.pid}`);
process.stderr.write('[agent-e] preparing profile (one unmeasured launch) ... ');
await prepareProfile(profileRoot);
process.stderr.write('done\n');

for (let i = 0; i < samples; i += 1) {
  process.stderr.write(`[agent-e] sample ${i + 1}/${samples} ... `);
  try {
    const r = await runSample(i, profileRoot);
    results.push(r);
    if (r.error) {
      process.stderr.write(`composer not typeable (fcp=${r.startup_firstPaint_ms}ms)\n`);
    } else {
      process.stderr.write(`typeable=${r.startup_typeable_ms}ms fcp=${r.startup_firstPaint_ms}ms\n`);
    }
  } catch (error) {
    process.stderr.write(`FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    results.push({ sample: i, error: error instanceof Error ? error.message : String(error) });
  }
}
// A killed Electron may still hold a lock on the profile directory for a
// moment; the profile is a scratch artifact, so a failed cleanup must not
// fail the run.
try {
  fs.rmSync(profileRoot, { recursive: true, force: true });
} catch {
  /* left behind on purpose */
}

const ok = results.filter((r) => !r.error);
function stats(key) {
  const values = ok.map((r) => r[key]).filter((v) => typeof v === 'number');
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    n: values.length,
    min: sorted[0],
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    max: sorted[sorted.length - 1],
    mean: Math.round(sum / values.length),
  };
}

const summary = {
  samples: results.length,
  succeeded: ok.length,
  startup_typeable_ms: stats('startup_typeable_ms'),
  startup_firstPaint_ms: stats('startup_firstPaint_ms'),
  scriptDurationMs: stats('scriptDurationMs'),
  jsBytesFetched: stats('jsBytesFetched'),
  results,
};

console.log(JSON.stringify(summary, null, 2));
if (jsonOut) {
  fs.mkdirSync(path.dirname(path.resolve(repoRoot, jsonOut)), { recursive: true });
  fs.writeFileSync(path.resolve(repoRoot, jsonOut), JSON.stringify(summary, null, 2));
}
process.exit(ok.length > 0 ? 0 : 1);
