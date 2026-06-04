/**
 * electron/cli/handlers/backup.ts
 *
 * CLI API handlers for `duya backup` — local state archive control plane.
 *
 * Endpoints (Phase 7-style: --yes gated for create / restore):
 *   POST /v1/backup/plan     — list the paths that would be included
 *   POST /v1/backup/create   — write a new .tar.gz archive
 *   POST /v1/backup/verify   — verify an existing archive
 *   POST /v1/backup/restore  — restore from an archive (Phase 2: dry-run only)
 *
 * The handler is a thin transport — all work happens in
 * `electron/services/backup.ts`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { app } from 'electron';
import {
  createBackup,
  verifyBackup,
  planRestore,
  createPlan,
  BackupError,
  type BackupManifest,
  type CreateOptions,
  type RestoreOptions,
} from '../../services/backup';
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

interface CreateBody {
  outputDir?: string;
  includeWorkspace?: boolean;
  onlyConfig?: boolean;
  dryRun?: boolean;
  verify?: boolean;
}

interface ArchiveBody {
  archivePath?: string;
  dryRun?: boolean;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX = 1024 * 1024; // 1 MiB is plenty for these endpoints
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

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof BackupError) {
    sendJson(res, statusFor(err.kind), { error: { code: err.kind, message: err.message } });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, 500, { error: { code: 'internal_error', message } });
}

function statusFor(kind: string): number {
  switch (kind) {
    case 'not_found':
      return 404;
    case 'unsafe_path':
    case 'malformed':
    case 'malformed_manifest':
    case 'unsupported_version':
    case 'multiple_manifests':
    case 'no_manifest':
    case 'missing_payload':
    case 'self_include':
    case 'output_exists':
      return 400;
    case 'not_implemented':
      return 501;
    default:
      return 500;
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleBackupPlan(_req: IncomingMessage, res: ServerResponse): void {
  try {
    const { sources, outputPath } = createPlan();
    sendJson(res, 200, {
      outputPath,
      sources: sources.map((s) => ({
        label: s.label,
        archivePath: s.archivePath,
        absolutePath: s.absolutePath,
        sizeBytes: s.sizeBytes,
        exists: s.exists,
      })),
    });
  } catch (err) {
    sendError(res, err);
  }
}

export async function handleBackupCreate(
  req: IncomingMessage,
  res: ServerResponse,
  correlationId?: string,
): Promise<void> {
  try {
    const raw = (await readJsonBody(req)) as CreateBody;
    const opts: CreateOptions = {
      outputDir: asString(raw.outputDir) ?? process.cwd(),
      includeWorkspace: asBool(raw.includeWorkspace),
      onlyConfig: asBool(raw.onlyConfig),
      dryRun: asBool(raw.dryRun),
      verifyAfterWrite: asBool(raw.verify),
    };
    const result = await createBackup(opts);
    await recordAudit(
      req,
      correlationId,
      'backup.create',
      result.outputPath,
      opts.dryRun ? 'dry-run' : undefined,
    );
    sendJson(res, 200, result);
  } catch (err) {
    sendError(res, err);
  }
}

export async function handleBackupVerify(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const raw = (await readJsonBody(req)) as ArchiveBody;
    const archivePath = asString(raw.archivePath);
    if (!archivePath) {
      sendJson(res, 400, { error: { code: 'missing_arg', message: 'archivePath required' } });
      return;
    }
    const result = await verifyBackup({ archivePath });
    sendJson(res, 200, result);
  } catch (err) {
    sendError(res, err);
  }
}

export async function handleBackupRestore(
  req: IncomingMessage,
  res: ServerResponse,
  correlationId?: string,
): Promise<void> {
  try {
    const raw = (await readJsonBody(req)) as ArchiveBody;
    const archivePath = asString(raw.archivePath);
    if (!archivePath) {
      sendJson(res, 400, { error: { code: 'missing_arg', message: 'archivePath required' } });
      return;
    }
    const opts: RestoreOptions = {
      archivePath,
      dryRun: asBool(raw.dryRun),
    };
    const result = await planRestore(opts);
    await recordAudit(
      req,
      correlationId,
      'backup.restore',
      archivePath,
      opts.dryRun ? 'dry-run' : undefined,
    );
    sendJson(res, 200, result);
  } catch (err) {
    sendError(res, err);
  }
}

export type { BackupManifest };
