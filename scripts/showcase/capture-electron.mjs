// scripts/showcase/capture-electron.mjs
// Spawn a real Electron instance of duya, wait for the renderer to signal
// "ready-for-screenshot" via a stable data attribute, then capture the
// window via webContents.capturePage() and save a PNG.
//
// This is the Stage-1 (low-intrusion) implementation. It only depends on
// the existing DUYA_PREVIEW_MODE env switch that electron:preview already
// uses. No changes to electron/main.ts are required for Stage 1.
//
// Stage 2 (tool-card scenarios 02..05) will require adding a small
// DUYA_SHOWCASE branch in electron/main.ts to inject the fixture tasks
// into the agent worker. That change is intentionally NOT made here.

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'assets', 'showcase');

/**
 * Run duya in Electron and capture one screenshot.
 *
 * @param {object} opts
 * @param {string} opts.name          Output basename, e.g. "01-launcher"
 * @param {number} [opts.width=1440]  Window width
 * @param {number} [opts.height=900]  Window height
 * @param {number} [opts.waitMs=2500] How long to wait after window opens
 * @param {string} [opts.readySelector] Optional CSS selector to wait for
 * @param {object} [opts.env]         Extra env vars to pass to Electron
 * @returns {Promise<string>}         Absolute path of the saved PNG
 */
export async function captureOne({
  name,
  width = 1440,
  height = 900,
  waitMs = 2500,
  readySelector = '[data-showcase-ready="true"]',
  env = {},
} = {}) {
  await mkdir(OUT_DIR, { recursive: true });

  const outPath = path.join(OUT_DIR, `${name}.png`);
  const markerPath = path.join(OUT_DIR, `${name}.ready.json`);

  // We use a Node-based screenshot driver via Electron's --remote-debugging-port
  // and a tiny in-page probe. This avoids requiring Spectron / Playwright
  // _and_ keeps the app code untouched for Stage 1.
  //
  // The driver writes a JSON file to OUT_DIR when the renderer is ready,
  // then this script captures the page via CDP Page.captureScreenshot.

  const debugPort = 9222 + Math.floor(Math.random() * 200);
  const driverScript = buildDriverScript({ readySelector, markerPath });

  const child = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['electron', '.', '--remote-debugging-port=' + debugPort],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        DUYA_PREVIEW_MODE: 'true',
        ...env,
        // The driver script reads this and injects the probe.
        DUYA_SHOWCASE_DRIVER: driverScript,
        DUYA_SHOWCASE_WIDTH: String(width),
        DUYA_SHOWCASE_HEIGHT: String(height),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  child.stdout.on('data', (d) => process.stdout.write(`[electron] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[electron:err] ${d}`));

  try {
    await waitForRenderer(debugPort, markerPath, waitMs + 8000);
    const png = await captureViaCDP(debugPort);
    await writeFile(outPath, png);
    return outPath;
  } finally {
    // Graceful shutdown then hard kill.
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (!child.killed) child.kill('SIGKILL');
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * Build the small driver script that the main process should evaluate in
 * the renderer once the window is created. For Stage 1 we DO NOT modify
 * main.ts; instead we read DUYA_SHOWCASE_DRIVER from env and require the
 * user to add ONE LINE in core/window-manager.ts after createWindow:
 *
 *   if (process.env.DUYA_SHOWCASE_DRIVER) eval(process.env.DUYA_SHOWCASE_DRIVER);
 *
 * Until that one-liner is added, Stage 1 falls back to a fixed wait
 * (waitMs) and captures whatever is on screen.
 */
function buildDriverScript({ readySelector, markerPath }) {
  return `
(function () {
  function markReady() {
    try {
      const fs = require('fs');
      fs.writeFileSync(${JSON.stringify(markerPath)},
        JSON.stringify({ ready: true, t: Date.now() }));
    } catch (e) { /* renderer fs may be sandboxed */ }
    document.documentElement.setAttribute('data-showcase-ready', 'true');
  }
  // Wait for the target selector or fallback timeout.
  const start = Date.now();
  const tick = setInterval(() => {
    const el = document.querySelector(${JSON.stringify(readySelector)});
    if (el || Date.now() - start > 6000) {
      clearInterval(tick);
      // small settle delay so animations finish
      setTimeout(markReady, 300);
    }
  }, 150);
})();
`.trim();
}

/**
 * Wait for either the marker file or the CDP target to appear.
 */
async function waitForRenderer(debugPort, markerPath, maxMs) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (existsSync(markerPath)) return;
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (res.ok) {
        // Wait one extra tick for the renderer page to register.
        await new Promise((r) => setTimeout(r, 400));
        if (existsSync(markerPath)) return;
        // Even without marker, give the page time to settle.
        return;
      }
    } catch {
      // CDP not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  // Timed out — proceed anyway and capture whatever we have.
  return;
}

/**
 * Capture the first renderer page via CDP.
 */
async function captureViaCDP(debugPort) {
  const list = await fetch(`http://127.0.0.1:${debugPort}/json`).then((r) => r.json());
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('No renderer page found on CDP');

  const WebSocket = (await import('ws')).default;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  let id = 0;
  const pending = new Map();
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const _id = ++id;
      pending.set(_id, { resolve, reject });
      ws.send(JSON.stringify({ id: _id, method, params }));
    });

  await send('Page.enable', {});
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  ws.close();
  return Buffer.from(data, 'base64');
}