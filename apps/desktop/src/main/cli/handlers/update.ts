/**
 * apps/desktop/src/main/cli/handlers/update.ts
 *
 * CLI API handlers for `duya update` — manage the desktop app's
 * auto-update flow from the CLI control plane.
 *
 * Endpoints (all POST are Phase 7-style, --yes gated in CLI):
 *   GET  /v1/update/status    — current updater state (no side effects)
 *   POST /v1/update/check     — kick off a check; returns
 *                               { success, updateAvailable?, currentVersion, latestVersion? }
 *   POST /v1/update/download  — start downloading the latest update
 *   POST /v1/update/install   — quit & install (will restart the app)
 *
 * Behavior matches the IPC handlers in `apps/desktop/src/main/ipc/updater-handlers.ts`.
 * The CLI is just a transport. `install` is gated on --yes in the CLI
 * to avoid accidentally restarting the running desktop.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  getUpdaterState,
} from '../../services/updater';
import { appendAuditEvent, type AuditEvent } from '../../services/controlPlaneAudit';

interface ElectronApp {
  getPath(name: 'userData'): string;
  getVersion(): string;
}

/**
 * Electron is OPTIONAL in this layer: the same handler graph has to load in a
 * process that has no Electron runtime
 * (`01-headless-control-plane.md` §2.1). A module-scope
 * `import { app } from 'electron'` is evaluated when the module is and throws
 * THERE, taking the whole graph with it, so `app` is resolved through a
 * guarded require and reported as absent instead.
 */
function electronApp(): ElectronApp | undefined {
  try {
    const { app } = require('electron') as { app?: ElectronApp };
    return app;
  } catch {
    return undefined;
  }
}

/**
 * `DUYA_CLI_USER_DATA_DIR` is the existing headless entry point
 * (`handlers/plugins.ts:170`) and wins whenever it is set. Without Electron,
 * `~/.duya` is the same directory the sessions / attachments paths already
 * use; returning `''` instead would resolve the audit path below against the
 * process cwd, which is not a directory anyone chose.
 */
function getUserDataDir(): string {
  const envOverride = process.env.DUYA_CLI_USER_DATA_DIR;
  if (envOverride && envOverride.trim().length > 0) return envOverride;
  const app = electronApp();
  if (app && typeof app.getPath === 'function') return app.getPath('userData');
  return join(homedir(), '.duya');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * The updater updates the INSTALLED DESKTOP APP: it resolves a feed through
 * `electron-updater` and `installUpdate` quits the running app. A headless
 * process has no installed app, so these endpoints have no counterpart there
 * and say so explicitly (501) instead of reporting a check that can never
 * succeed — `01-headless-control-plane.md` §2.1: a capability with no
 * headless equivalent must return "unsupported", never degrade silently.
 */
function sendUnsupportedWithoutDesktop(res: ServerResponse): void {
  sendJson(res, 501, {
    error: {
      code: 'unsupported_without_desktop',
      message: 'Auto-update targets an installed Electron desktop app; this control plane has none.',
    },
  });
}

function readInvokedByHeader(
  req: IncomingMessage,
  correlationId: string | undefined,
): AuditEvent['invokedBy'] {
  const raw = req.headers['x-duya-invoked-by'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return 'cli';
  if (value === 'agent-tool') {
    const cid = correlationId ?? req.headers['x-correlation-id'];
    if (typeof cid === 'string' && cid.trim().length > 0) {
      return `agent-tool:${cid}`;
    }
    return 'agent-tool';
  }
  return 'cli';
}

async function recordAudit(
  req: IncomingMessage,
  correlationId: string | undefined,
  kind: AuditEvent['kind'],
  id: string,
  note?: string,
): Promise<void> {
  const userDataDir = getUserDataDir();
  if (!userDataDir) return;
  const event: AuditEvent = {
    kind,
    id,
    ts: Date.now(),
    invokedBy: readInvokedByHeader(req, correlationId),
    ...(correlationId ? { correlationId } : {}),
    ...(note ? { note } : {}),
  };
  await appendAuditEvent(userDataDir, event);
}

/**
 * GET /v1/update/status — current updater state.
 */
export function handleGetUpdateStatus(_req: IncomingMessage, res: ServerResponse): void {
  const app = electronApp();
  if (!app) {
    sendUnsupportedWithoutDesktop(res);
    return;
  }
  try {
    const state = getUpdaterState();
    const body = {
      currentVersion: app.getVersion(),
      isChecking: state.isChecking,
      isDownloading: state.isDownloading,
      updateAvailable: state.updateInfo !== null,
      updateInfo: state.updateInfo
        ? {
            version: state.updateInfo.version,
            releaseDate: state.updateInfo.releaseDate,
          }
        : null,
      downloadProgress: state.downloadProgress,
      error: state.error,
    };
    sendJson(res, 200, body);
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * POST /v1/update/check — kick off a check.
 */
export async function handleUpdateCheck(
  req: IncomingMessage,
  res: ServerResponse,
  correlationId?: string,
): Promise<void> {
  const app = electronApp();
  if (!app) {
    sendUnsupportedWithoutDesktop(res);
    return;
  }
  try {
    const result = await checkForUpdates();
    await recordAudit(req, correlationId, 'update.check', 'desktop', result.error);
    sendJson(res, result.success ? 200 : 500, {
      ...result,
      currentVersion: app.getVersion(),
    });
  } catch (err) {
    sendJson(res, 500, {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * POST /v1/update/download — start downloading the latest update.
 */
export async function handleUpdateDownload(
  req: IncomingMessage,
  res: ServerResponse,
  correlationId?: string,
): Promise<void> {
  if (!electronApp()) {
    sendUnsupportedWithoutDesktop(res);
    return;
  }
  try {
    const result = await downloadUpdate();
    await recordAudit(req, correlationId, 'update.download', 'desktop', result.error);
    sendJson(res, result.success ? 200 : 500, result);
  } catch (err) {
    sendJson(res, 500, {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * POST /v1/update/install — quit and install. Caller is restarted by
 * electron-updater. The CLI expects this to take a few seconds; the
 * HTTP response is fired before the app actually exits so the client
 * can show "restarting…" cleanly.
 */
export async function handleUpdateInstall(
  req: IncomingMessage,
  res: ServerResponse,
  correlationId?: string,
): Promise<void> {
  if (!electronApp()) {
    sendUnsupportedWithoutDesktop(res);
    return;
  }
  try {
    await recordAudit(req, correlationId, 'update.install', 'desktop');
    // Respond first so the CLI gets an ack; then quitAndInstall kills us.
    sendJson(res, 200, { ok: true, message: 'Restarting to install update…' });
    // Run on next tick so the response is flushed before the app exits.
    setImmediate(() => {
      void installUpdate();
    });
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
