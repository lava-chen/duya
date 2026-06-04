/**
 * electron/cli/handlers/update.ts
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
 * Behavior matches the IPC handlers in `electron/ipc/updater-handlers.ts`.
 * The CLI is just a transport. `install` is gated on --yes in the CLI
 * to avoid accidentally restarting the running desktop.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { app } from 'electron';
import {
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  getUpdaterState,
} from '../../services/updater';
import { appendAuditEvent, type AuditEvent } from '../../services/controlPlaneAudit';

function getUserDataDir(): string {
  const envOverride = process.env.DUYA_CLI_USER_DATA_DIR;
  if (envOverride && envOverride.trim().length > 0) return envOverride;
  try {
    return app.getPath('userData');
  } catch {
    return '';
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
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
