/**
 * electron/cli/handlers/extra2.ts
 *
 * Phase 4.4: cron enable/disable/logs + gateway reload-secrets + gateway rpc.
 *
 *   POST /v1/crons/:id/enable      — set status = 'enabled'
 *   POST /v1/crons/:id/disable     — set status = 'disabled'
 *   GET  /v1/crons/:id/logs        — return the last N run records
 *   POST /v1/gateway/reload-secrets — re-resolve secret refs (stub)
 *   POST /v1/gateway/rpc            — proxy to the gateway subprocess (stub)
 *
 * The gateway rpc / reload-secrets paths in Phase 4.4 are stubs that
 * record the audit event and return ok:false with a clear reason
 * pointing at Plan 200 R4. They exist so the CLI surface is stable
 * while the underlying gateway work lands.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getDatabase } from '../../db/connection';
import { appendAuditEvent, type AuditEvent } from '../../services/controlPlaneAudit';
import { app } from 'electron';

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

// ---------------------------------------------------------------------------
// cron enable / disable
// ---------------------------------------------------------------------------

async function setCronStatus(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  next: 'enabled' | 'disabled',
  correlationId?: string,
): Promise<void> {
  try {
    const db = getDatabase();
    if (!db) {
      sendJson(res, 503, { error: { code: 'db_unavailable', message: 'database is not ready' } });
      return;
    }
    const row = db.prepare('SELECT id, status FROM automation_crons WHERE id = ?').get(id) as
      | { id: string; status: string }
      | undefined;
    if (!row) {
      sendJson(res, 404, { error: { code: 'cron_not_found', message: id } });
      return;
    }
    const now = Date.now();
    db.prepare('UPDATE automation_crons SET status = ?, updated_at = ? WHERE id = ?').run(
      next,
      now,
      id,
    );
    await recordAudit(
      req,
      correlationId,
      next === 'enabled' ? 'cron.enable' : 'cron.disable',
      id,
      `from=${row.status}`,
    );
    sendJson(res, 200, { ok: true, id, status: next, previousStatus: row.status });
  } catch (err) {
    sendJson(res, 500, {
      error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

export async function handleCronEnable(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  correlationId?: string,
): Promise<void> {
  return setCronStatus(req, res, id, 'enabled', correlationId);
}

export async function handleCronDisable(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  correlationId?: string,
): Promise<void> {
  return setCronStatus(req, res, id, 'disabled', correlationId);
}

// ---------------------------------------------------------------------------
// cron logs (last N runs)
// ---------------------------------------------------------------------------

interface CronRunRow {
  id: string;
  started_at: number;
  ended_at: number | null;
  run_status: string;
  error_message: string | null;
  output: string | null;
  logs: string | null;
}

export function handleCronLogs(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
): void {
  void _req;
  try {
    const db = getDatabase();
    if (!db) {
      sendJson(res, 503, { error: { code: 'db_unavailable', message: 'database is not ready' } });
      return;
    }
    const cron = db.prepare('SELECT id FROM automation_crons WHERE id = ?').get(id) as
      | { id: string }
      | undefined;
    if (!cron) {
      sendJson(res, 404, { error: { code: 'cron_not_found', message: id } });
      return;
    }
    const url = _req.url ?? '';
    const qIdx = url.indexOf('?');
    let limit = 20;
    if (qIdx >= 0) {
      for (const part of url.slice(qIdx + 1).split('&')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        const k = part.slice(0, eq);
        const v = part.slice(eq + 1);
        if (k === 'limit') limit = Math.max(1, Math.min(200, Number(v) || limit));
      }
    }
    const rows = db
      .prepare(
        'SELECT id, started_at, ended_at, run_status, error_message, output, logs FROM automation_cron_runs WHERE cron_id = ? ORDER BY started_at DESC LIMIT ?',
      )
      .all(id, limit) as CronRunRow[];
    sendJson(res, 200, { id, runs: rows });
  } catch (err) {
    sendJson(res, 500, {
      error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ---------------------------------------------------------------------------
// gateway reload-secrets (stub — ships fully in Plan 200 R4)
// ---------------------------------------------------------------------------

export async function handleGatewayReloadSecrets(
  req: IncomingMessage,
  res: ServerResponse,
  correlationId?: string,
): Promise<void> {
  await recordAudit(req, correlationId, 'gateway.reload_secrets', 'gateway');
  sendJson(res, 200, {
    ok: false,
    reason: 'gateway_secret_reload_ships_in_plan_200_r4',
  });
}

// ---------------------------------------------------------------------------
// gateway rpc (stub proxy)
// ---------------------------------------------------------------------------

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX = 1024 * 1024;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8');
      if (text.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text) as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export async function handleGatewayRpc(
  req: IncomingMessage,
  res: ServerResponse,
  correlationId?: string,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: { code: 'invalid_request', message: err instanceof Error ? err.message : String(err) } });
    return;
  }
  const method = typeof body.method === 'string' ? body.method : '';
  await recordAudit(req, correlationId, 'gateway.rpc', 'gateway', `method=${method}`);
  sendJson(res, 200, {
    ok: false,
    method,
    reason: 'gateway_rpc_proxy_ships_in_plan_200_r4',
  });
}
