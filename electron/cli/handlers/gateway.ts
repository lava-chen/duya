/**
 * electron/cli/handlers/gateway.ts
 *
 * CLI API handlers for the IM gateway lifecycle control plane.
 *
 * Plan 99 G2: four subcommands mirroring OpenClaw's `gateway`
 * command. Read:
 *   GET /v1/gateway
 *     → { running, pid, startedAt, uptimeSec, channelCount, channels[] }
 *
 * Write (Phase 7-style, --yes gated in CLI):
 *   POST /v1/gateway/start
 *     → { ok, pid, readyMs }   (waits up to 30s for ready)
 *   POST /v1/gateway/stop
 *     → { ok, stoppedMs }
 *   POST /v1/gateway/restart
 *     → { ok, pid, readyMs }   (waits up to 30s for ready)
 *
 * The start / stop / restart handlers reuse the same lifecycle
 * code that the IPC handlers use (`gateway:start` /
 * `gateway:stop`), so behavior is identical for both transports.
 * Each write op goes through the unified `control-plane-audit.log.jsonl`
 * recorder with `invokedBy` set by the `X-Duya-Invoked-By` header.
 *
 * We do NOT use `?wait=true` URL params — instead, the handler
 * always waits up to 30s. The CLI's `--no-wait` flag short-circuits
 * the wait on the client side (it returns early after the POST
 * resolves) so the user can opt into fire-and-forget mode without
 * changing the server contract.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  startGatewayProcess,
  stopGatewayProcess,
  isGatewayRunning,
  getGatewayProcess,
  waitForGatewayReady,
  getOrBuildInitConfig,
} from '../../gateway';
import {
  getChannelDirectory,
  getAllChannelStatuses,
} from '../../gateway/channel-directory';
import { appendAuditEvent, type AuditEvent } from '../../services/controlPlaneAudit';

// ---------------------------------------------------------------------------
// Audit logging
// ---------------------------------------------------------------------------

function getUserDataDir(): string {
  const envOverride = process.env.DUYA_CLI_USER_DATA_DIR;
  if (envOverride && envOverride.trim().length > 0) return envOverride;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return app.getPath('userData');
    }
  } catch {
    // not in electron context
  }
  return join(homedir(), '.duya');
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
  if (value === 'cli') return 'cli';
  return 'cli';
}

function makeAuditEvent(
  req: IncomingMessage,
  kind: AuditEvent['kind'],
  correlationId: string | undefined,
): AuditEvent {
  return {
    kind,
    id: 'gateway', // single-tenant: id is the constant 'gateway'
    ts: Date.now(),
    invokedBy: readInvokedByHeader(req, correlationId),
    ...(correlationId ? { correlationId } : {}),
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

const READY_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Status handler
// ---------------------------------------------------------------------------

interface GatewayChannelSummary {
  platform: string;
  id: string;
  name: string;
  bound: boolean;
}

interface GatewayStatusResponse {
  running: boolean;
  pid?: number;
  startedAt?: number;
  uptimeSec?: number;
  channelCount: number;
  channels: GatewayChannelSummary[];
}

export function handleGetGateway(_req: IncomingMessage, res: ServerResponse, startedAt: number): void {
  void _req;
  try {
    const running = isGatewayRunning();
    const proc = getGatewayProcess();
    const channelEntries = getChannelDirectory();
    const statuses = getAllChannelStatuses();
    const statusByPlatform = new Map(statuses.map((s) => [s.platform, s]));

    const channels: GatewayChannelSummary[] = channelEntries.map((c) => ({
      platform: c.platform,
      id: c.id,
      name: c.name,
      // A channel is "bound" if its platform has a live status snapshot.
      // (Plan 99: the gateway's own session-binding info is internal;
      //  status presence is the closest safe proxy exposed to CLI.)
      bound: statusByPlatform.has(c.platform),
    }));

    const out: GatewayStatusResponse = {
      running,
      channelCount: channelEntries.length,
      channels,
    };
    if (running && proc?.pid !== undefined) {
      out.pid = proc.pid;
      // The child process's spawn time is `proc.spawnfile`'s ctime;
      // we use proc.spawnargs as a sanity hint, but the most
      // accurate signal is `proc.connected` plus the runtime file
      // timestamp. We don't have a precise gateway-started-at
      // timestamp without a new field, so report the CLI API
      // server's startedAt as a stand-in for "the gateway has been
      // observable since …" (acknowledged limitation, see plan
      // note).
      out.startedAt = startedAt;
      out.uptimeSec = Math.floor((Date.now() - startedAt) / 1000);
    }
    sendJson(res, 200, out);
  } catch (err) {
    sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// start / stop / restart handlers
// ---------------------------------------------------------------------------

interface StartResult {
  ok: true;
  pid?: number;
  readyMs?: number;
  warning?: string;
}

interface StopResult {
  ok: true;
  stoppedMs: number;
}

interface RestartResult {
  ok: true;
  pid?: number;
  readyMs?: number;
  warning?: string;
}

async function performStart(
  req: IncomingMessage,
  res: ServerResponse,
  correlationId: string | undefined,
): Promise<void> {
  const t0 = Date.now();
  let child;
  let config;
  try {
    config = getOrBuildInitConfig();
    child = startGatewayProcess(config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendError(res, 500, 'start_failed', msg);
    return;
  }

  // Wait for ready, but don't let a slow start block the response
  // forever. We resolve with a `warning` if the timeout fires —
  // the gateway is still running and the user can `gateway status`
  // to check later.
  let readyMs: number | undefined;
  let warning: string | undefined;
  try {
    await waitForGatewayReady(config, child, READY_TIMEOUT_MS);
    readyMs = Date.now() - t0;
  } catch (err) {
    warning = err instanceof Error ? err.message : String(err);
  }

  // After the wait, send the init config (the same step the IPC
  // `gateway:start` handler does — see message-bus.ts:850). This
  // is the only safe place to do it; the gateway expects
  // `init` AFTER it announces ready.
  try {
    child.send({ type: 'init', config });
  } catch {
    // send() can throw if the channel closed between ready and here.
    // The handler has already returned ok; the user can re-trigger
    // start if the gateway misbehaves.
  }

  await appendAuditEvent(
    getUserDataDir(),
    makeAuditEvent(req, 'gateway.start', correlationId),
  );

  const out: StartResult = {
    ok: true,
    readyMs,
    ...(child.pid !== undefined ? { pid: child.pid } : {}),
    ...(warning ? { warning } : {}),
  };
  sendJson(res, 200, out);
}

async function performStop(
  req: IncomingMessage,
  res: ServerResponse,
  correlationId: string | undefined,
): Promise<void> {
  const t0 = Date.now();
  if (!isGatewayRunning()) {
    // Idempotent: stopping a not-running gateway is not an error.
    await appendAuditEvent(
      getUserDataDir(),
      makeAuditEvent(req, 'gateway.stop', correlationId),
    );
    sendJson(res, 200, { ok: true, stoppedMs: 0, alreadyStopped: true } satisfies StopResult & { alreadyStopped: true });
    return;
  }
  try {
    await stopGatewayProcess();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendError(res, 500, 'stop_failed', msg);
    return;
  }
  await appendAuditEvent(
    getUserDataDir(),
    makeAuditEvent(req, 'gateway.stop', correlationId),
  );
  const out: StopResult = { ok: true, stoppedMs: Date.now() - t0 };
  sendJson(res, 200, out);
}

async function performRestart(
  req: IncomingMessage,
  res: ServerResponse,
  correlationId: string | undefined,
): Promise<void> {
  const t0 = Date.now();
  if (isGatewayRunning()) {
    try {
      await stopGatewayProcess();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendError(res, 500, 'restart_failed_at_stop', msg);
      return;
    }
  }
  // performStart will append 'gateway.start' to the audit log. We
  // also append a separate 'gateway.restart' marker so the audit
  // log distinguishes the user's intent (a single restart op) from
  // the underlying start op.
  await appendAuditEvent(
    getUserDataDir(),
    makeAuditEvent(req, 'gateway.restart', correlationId),
  );
  return performStart(req, res, correlationId);
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export {
  performStart as handleStartGateway,
  performStop as handleStopGateway,
  performRestart as handleRestartGateway,
};

export type { GatewayStatusResponse, StartResult, StopResult, RestartResult };
