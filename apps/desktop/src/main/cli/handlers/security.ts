/**
 * apps/desktop/src/main/cli/handlers/security.ts
 *
 * CLI API handlers for `duya security` — read-only security audit
 * and optional auto-fix.
 *
 * Endpoints:
 *   POST /v1/security/audit  — read-only audit (deep flag in body)
 *   POST /v1/security/fix    — apply auto-fixes; Phase 7 --yes gated
 *
 * Audit is idempotent and never throws into the caller. Fixes run
 * only on findings that explicitly opt in via `autoFixable: true`,
 * so a fix call without --yes is still safe (it just does nothing).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runAudit, runFix, type AuditResult, type FixResult } from '../../services/security';
import { appendAuditEvent, type AuditEvent } from '../../services/controlPlaneAudit';

interface ElectronApp {
  getPath(name: 'userData'): string;
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
 * use; returning `''` instead would resolve the audit / credential paths
 * below against the process cwd, which is not a directory anyone chose.
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
  id: string,
  note?: string,
): Promise<void> {
  const userDataDir = getUserDataDir();
  if (!userDataDir) return;
  const event: AuditEvent = {
    kind: 'security.audit.fix',
    id,
    ts: Date.now(),
    invokedBy: readInvokedByHeader(req, correlationId),
    ...(correlationId ? { correlationId } : {}),
    ...(note ? { note } : {}),
  };
  await appendAuditEvent(userDataDir, event);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX = 1024 * 1024;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}

export async function handleSecurityAudit(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const raw = (await readJsonBody(req)) as { deep?: unknown };
    const result: AuditResult = await runAudit({ deep: asBool(raw.deep) });
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function handleSecurityFix(
  req: IncomingMessage,
  res: ServerResponse,
  correlationId?: string,
): Promise<void> {
  try {
    const raw = (await readJsonBody(req)) as {
      deep?: unknown;
      onlyFixIds?: unknown;
    };
    const audit = await runAudit({ deep: true });
    const onlyFixIds = Array.isArray(raw.onlyFixIds)
      ? new Set(raw.onlyFixIds.filter((x): x is string => typeof x === 'string'))
      : undefined;
    const result: FixResult = await runFix(audit, { onlyFixIds });
    await recordAudit(
      req,
      correlationId,
      'cli',
      `applied=${result.applied.length} skipped=${result.skipped.length}`,
    );
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
