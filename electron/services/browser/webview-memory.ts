/**
 * Webview memory management for the built-in browser (`<webview>` guests).
 *
 * Why this exists: every built-in-browser tab is a `<webview>` guest sharing
 * one persistent partition (`persist:duya-local-browser`). Chromium keeps that
 * partition's HTTP disk cache, V8 code cache, shader cache and host/auth
 * caches alive for the whole app lifetime, and a long-lived guest running a
 * heavy page (or driven by agent automation) can accumulate a multi-gigabyte
 * JS heap + DOM that never shrinks on its own. This module adds the two pieces
 * the app was missing:
 *
 *   1. `releaseBrowserMemory()` — an explicit "discard on close" path. When the
 *      last browser tab closes, the partition *caches* are cleared so the
 *      footprint does not carry into the next session. Cookies and
 *      localStorage are intentionally preserved so the user stays logged in;
 *      `clearPartitionData()` (cookie-writer.ts) remains the explicit full wipe.
 *   2. `checkWebviewMemory()` / the watchdog — while a guest is alive, sample
 *      its renderer memory and reload any guest that exceeds the per-tab
 *      budget, letting Chromium drop the accumulated heap/DOM.
 *
 * Main-process only (uses `session` / `webContents`). It deliberately does not
 * import `webview-bridge`; instead the bridge registers an id provider via
 * `setWebviewIdProvider()` so the dependency stays one-way (no import cycle).
 */

import { app, session, webContents } from 'electron';
import { getLogger, LogComponent } from '../../logging/logger';

export const BROWSER_PARTITION = 'persist:duya-local-browser';

/** Per-guest renderer memory budget in MB. Above this the guest is reloaded. */
export const DEFAULT_WEBVIEW_MEMORY_BUDGET_MB = 800;
/** How often the watchdog samples live guests. */
export const WEBVIEW_WATCHDOG_INTERVAL_MS = 60_000;

interface WebviewRef {
  sessionId: string;
  webContentsId: number;
}

type WebviewIdProvider = () => WebviewRef[];

let idProvider: WebviewIdProvider | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

/** Register the source of live (sessionId → webContentsId) pairs. */
export function setWebviewIdProvider(fn: WebviewIdProvider | null): void {
  idProvider = fn;
}

function memoryBudgetMb(): number {
  const raw = parseInt(process.env.DUYA_WEBVIEW_MEMORY_MB ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WEBVIEW_MEMORY_BUDGET_MB;
}

/**
 * Clear the browser partition's caches — HTTP/disk cache, V8 code cache,
 * host-resolver and auth caches, plus the regenerable heavy storage caches
 * (shader / CacheStorage / service workers). Cookies, localStorage, IndexedDB
 * and filesystem are deliberately left intact so logins survive a tab close.
 */
export async function releaseBrowserMemory(reason: string): Promise<void> {
  const logger = getLogger();
  try {
    const ses = session.fromPartition(BROWSER_PARTITION);
    await Promise.all([
      ses.clearCache(),
      ses.clearCodeCaches({ urls: [] }),
      ses.clearHostResolverCache(),
      ses.clearAuthCache(),
    ]);
    await ses.clearStorageData({
      storages: ['shadercache', 'cachestorage', 'serviceworkers'],
    });
    logger.info('Released browser partition caches', { reason }, LogComponent.BrowserDaemon);
  } catch (err) {
    logger.warn(
      'releaseBrowserMemory failed',
      { reason, error: err instanceof Error ? err.message : String(err) },
      LogComponent.BrowserDaemon,
    );
  }
}

/**
 * Renderer memory of a guest in MB, or null when it cannot be sampled. Uses
 * `app.getAppMetrics()` (per-process working set) because Electron exposes no
 * per-WebContents memory API — `getProcessMemoryInfo` lives on UtilityProcess.
 */
function guestMemoryMb(webContentsId: number): number | null {
  const wc = webContents.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) return null;
  let pid: number;
  try {
    pid = wc.getOSProcessId();
  } catch {
    return null;
  }
  const metric = app.getAppMetrics().find((m) => m.pid === pid);
  // workingSetSize is reported in KB.
  const kb = metric?.memory?.workingSetSize ?? 0;
  return kb > 0 ? Math.round(kb / 1024) : null;
}

export interface WebviewMemorySample {
  sessionId: string;
  webContentsId: number;
  mb: number | null;
  reloaded: boolean;
}

/**
 * Sample every live guest and reload those over budget. Returns the samples so
 * callers/tests can inspect the decision. Never throws.
 */
export async function checkWebviewMemory(): Promise<WebviewMemorySample[]> {
  const refs = idProvider?.() ?? [];
  const budget = memoryBudgetMb();
  const logger = getLogger();
  const samples: WebviewMemorySample[] = [];

  for (const { sessionId, webContentsId } of refs) {
    const mb = guestMemoryMb(webContentsId);
    let reloaded = false;
    if (mb !== null && mb > budget) {
      const wc = webContents.fromId(webContentsId);
      if (wc && !wc.isDestroyed()) {
        logger.warn(
          'Reloading over-budget browser guest',
          { sessionId, webContentsId, mb, budget },
          LogComponent.BrowserDaemon,
        );
        wc.reload();
        reloaded = true;
      }
    }
    samples.push({ sessionId, webContentsId, mb, reloaded });
  }
  return samples;
}

/** Start the periodic watchdog (idempotent). */
export function startWebviewMemoryWatchdog(intervalMs = WEBVIEW_WATCHDOG_INTERVAL_MS): void {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    void checkWebviewMemory().catch(() => {
      // A sampling failure must never escape into the timer.
    });
  }, intervalMs);
  if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();
}

export function stopWebviewMemoryWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

/** Total memory (MB) across live guests, sampled on demand. */
export async function getWebviewMemoryTotalMb(): Promise<number> {
  const refs = idProvider?.() ?? [];
  let total = 0;
  for (const { webContentsId } of refs) {
    const mb = guestMemoryMb(webContentsId);
    if (mb !== null) total += mb;
  }
  return total;
}
