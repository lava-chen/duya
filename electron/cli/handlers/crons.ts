/**
 * electron/cli/handlers/crons.ts
 *
 * CLI API handlers for the cron (scheduled jobs) control plane.
 *
 * Plan 99 P2: routes are PATCH /v1/crons/:id (not POST) and
 * DELETE /v1/crons/:id (not POST /:id/delete). The wire DTO
 * `CreateCronBody` uses `at: string` (ISO8601), no `workflowId`,
 * optional `enabled` flag.
 *
 * Read surface:
 *   GET    /v1/crons             → { crons: CronListItemDTO[] }
 *   GET    /v1/crons/:id         → { cron: CronInfoItemDTO }
 *   GET    /v1/crons/:id/runs    → { runs: CronRunItemDTO[] }   (paginated)
 *
 * Write surface (Phase 7 + Plan 99 P2):
 *   POST   /v1/crons             → create cron (body: CreateCronBody)
 *   PATCH  /v1/crons/:id         → update cron (body: UpdateCronBody)
 *   DELETE /v1/crons/:id         → delete cron
 *   POST   /v1/crons/:id/run     → trigger run
 *
 * Write ops write to `control-plane-audit.log.jsonl` via the
 * unified recorder. `invokedBy` is set to `'cli'` for external
 * script invocations; the agent tool's call path passes
 * `'agent-tool'` or `'agent-tool:{sessionId}'` separately.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getAutomationScheduler } from '../../automation/Scheduler';
import { formatEveryDuration, parseEveryDuration } from '../../automation/schedule.js';
import { getCoreStores } from '../../db/core-connection';
import { appendAuditEvent, type AuditEvent } from '../../services/controlPlaneAudit';
import type {
  AutomationCron,
  CreateAutomationCronInput,
  CronSchedule,
  UpdateAutomationCronInput,
} from '../../automation/types';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// DTOs (frozen in roadmap §3.4, Plan 99 P2 alignment)
// ---------------------------------------------------------------------------

export type ScheduleKind = 'at' | 'every' | 'cron';
export type CronStatus = 'enabled' | 'disabled' | 'error';
export type ConcurrencyPolicy = 'skip' | 'parallel' | 'queue' | 'replace';
export type RunStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled' | 'skipped';

export interface CronListItemDTO {
  id: string;
  name: string;
  description?: string;
  status: CronStatus;
  scheduleKind: ScheduleKind;
  /** Human-readable schedule summary, e.g. "every 5m" or "0 * * * *". */
  scheduleExpr: string;
  nextRunAt?: number;
  lastRunAt?: number;
  lastError?: string;
}

export interface CronInfoItemDTO extends CronListItemDTO {
  workingDirectory?: string;
  scheduleAt?: string;
  scheduleEveryMs?: number;
  scheduleCronExpr?: string;
  scheduleCronTz?: string;
  scheduleEndAt?: string;
  prompt: string;
  model?: string;
  concurrencyPolicy: ConcurrencyPolicy;
  maxRetries: number;
  inputParams?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface CronRunItemDTO {
  id: string;
  cronId: string;
  runStatus: RunStatus;
  startedAt?: number;
  endedAt?: number;
  output?: string;
  errorMessage?: string;
  sessionId?: string;
  createdAt: number;
}

/** Wire shape for `POST /v1/crons` (Plan 99 P2 alignment). */
export interface CreateCronBody {
  name: string;
  description?: string;
  workingDirectory?: string;
  schedule: {
    kind: ScheduleKind;
    at?: string;
    everyMs?: number;
    cronExpr?: string;
    cronTz?: string;
    endAt?: string;
  };
  prompt: string;
  model?: string;
  inputParams?: Record<string, unknown>;
  concurrencyPolicy?: ConcurrencyPolicy;
  maxRetries?: number;
  enabled?: boolean;
}

/** Wire shape for `PATCH /v1/crons/:id` (Plan 99 P2). */
export interface UpdateCronBody {
  name?: string;
  description?: string;
  workingDirectory?: string;
  schedule?: CreateCronBody['schedule'];
  prompt?: string;
  model?: string;
  inputParams?: Record<string, unknown>;
  concurrencyPolicy?: ConcurrencyPolicy;
  maxRetries?: number;
  status?: CronStatus;
}

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
  // Unknown value: fall back to 'cli' so we never write a typo into
  // the audit log. Callers wanting a custom value should extend the
  // discriminated union in `controlPlaneAudit.ts` first.
  return 'cli';
}

function makeAuditEvent(
  req: IncomingMessage,
  kind: AuditEvent['kind'],
  id: string,
  correlationId: string | undefined,
): AuditEvent {
  return {
    kind,
    id,
    ts: Date.now(),
    invokedBy: readInvokedByHeader(req, correlationId),
    ...(correlationId ? { correlationId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Row → DTO mappers
// ---------------------------------------------------------------------------

function scheduleSummary(row: AutomationCron): string {
  const s = row.schedule;
  if (s.kind === 'once') return s.at ? `at ${s.at}` : '-';
  if (s.kind === 'every') return `every ${s.every}`;
  if (s.kind === 'cron') return s.expr || '-';
  return '-';
}

/** Effective wire status: the user toggle is `enabled`; a run error pauses the job. */
function effectiveStatus(row: AutomationCron): CronStatus {
  if (!row.enabled) return 'disabled';
  return row.lastError ? 'error' : 'enabled';
}

function toListItem(row: AutomationCron): CronListItemDTO {
  return {
    id: row.id,
    name: row.name,
    description: undefined,
    status: effectiveStatus(row),
    scheduleKind: row.schedule.kind === 'once' ? 'at' : row.schedule.kind,
    scheduleExpr: scheduleSummary(row),
    nextRunAt: row.nextRunAt ?? undefined,
    lastRunAt: row.lastRunAt ?? undefined,
    lastError: row.lastError ?? undefined,
  };
}

function toInfoItem(row: AutomationCron): CronInfoItemDTO {
  const s = row.schedule;
  let everyMs: number | undefined;
  if (s.kind === 'every') {
    try {
      everyMs = parseEveryDuration(s.every);
    } catch {
      everyMs = undefined;
    }
  }
  return {
    ...toListItem(row),
    workingDirectory: row.workingDirectory || undefined,
    scheduleAt: s.kind === 'once' ? s.at : undefined,
    scheduleEveryMs: everyMs,
    scheduleCronExpr: s.kind === 'cron' ? s.expr : undefined,
    scheduleCronTz: s.kind === 'cron' ? (s.tz ?? undefined) : undefined,
    scheduleEndAt: s.endAt ?? undefined,
    prompt: row.prompt,
    model: row.model,
    concurrencyPolicy: row.concurrencyPolicy,
    maxRetries: row.maxRetries,
    inputParams: undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A cron run is an ordinary session; map it to the frozen run DTO. */
function toRunItem(
  session: { id: string; created_at: number; updated_at: number; model: string },
  job: AutomationCron,
  isLatest: boolean,
): CronRunItemDTO {
  return {
    id: session.id,
    cronId: job.id,
    runStatus: isLatest && job.lastError ? 'failed' : 'success',
    startedAt: session.created_at,
    endedAt: session.updated_at,
    output: undefined,
    errorMessage: isLatest ? (job.lastError ?? undefined) : undefined,
    sessionId: session.id,
    createdAt: session.created_at,
  };
}

// ---------------------------------------------------------------------------
// Wire DTO → scheduler input mappers
// ---------------------------------------------------------------------------

/** Map the frozen wire schedule (at/everyMs/cronExpr) to the new nested shape. */
function toSchedulerSchedule(s: CreateCronBody['schedule']): CronSchedule {
  if (s.kind === 'at') return { kind: 'once', at: s.at ?? '', endAt: s.endAt };
  if (s.kind === 'every') return { kind: 'every', every: formatEveryDuration(s.everyMs ?? 3_600_000), endAt: s.endAt };
  return { kind: 'cron', expr: s.cronExpr ?? '', tz: s.cronTz, endAt: s.endAt };
}

function toCreateInput(body: CreateCronBody): CreateAutomationCronInput {
  return {
    name: body.name,
    workingDirectory: body.workingDirectory,
    schedule: toSchedulerSchedule(body.schedule),
    prompt: body.prompt,
    model: body.model,
    concurrencyPolicy: body.concurrencyPolicy as CreateAutomationCronInput['concurrencyPolicy'],
    maxRetries: body.maxRetries,
    enabled: body.enabled,
  };
}

function toUpdateInput(body: UpdateCronBody): UpdateAutomationCronInput {
  return {
    name: body.name,
    workingDirectory: body.workingDirectory,
    schedule: body.schedule ? toSchedulerSchedule(body.schedule) : undefined,
    prompt: body.prompt,
    model: body.model,
    concurrencyPolicy: body.concurrencyPolicy as UpdateAutomationCronInput['concurrencyPolicy'],
    maxRetries: body.maxRetries,
    enabled: body.status ? body.status === 'enabled' : undefined,
  };
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8');
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on('error', reject);
  });
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

function getScheduler() {
  const s = getAutomationScheduler();
  if (!s) {
    throw new Error('automation scheduler is not initialized; open DUYA and retry');
  }
  return s;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleListCrons(_req: IncomingMessage, res: ServerResponse): void {
  void _req;
  try {
    const scheduler = getScheduler();
    const rows = scheduler.listCrons();
    sendJson(res, 200, { crons: rows.map(toListItem) });
  } catch (err) {
    sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
  }
}

export function handleGetCron(req: IncomingMessage, res: ServerResponse, id: string): void {
  void req;
  if (!id || id.trim().length === 0) {
    sendError(res, 400, 'invalid_id', 'Cron id must be a non-empty string');
    return;
  }
  try {
    const scheduler = getScheduler();
    const match = scheduler.listCrons().find((c) => c.id === id);
    if (!match) {
      sendError(res, 404, 'cron_not_found', `Cron not found: ${id}`);
      return;
    }
    // Wrap in `{ cron }` so the client can read `body.cron` (mirrors the
    // shape used by `list` and `create`). Earlier we returned the bare
    // DTO which made `body.cron` undefined on the client and surfaced
    // as "Cannot read properties of undefined (reading 'id')".
    sendJson(res, 200, { cron: toInfoItem(match) });
  } catch (err) {
    sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
  }
}

export function handleListCronRuns(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  query: { limit?: number; offset?: number } = {},
): void {
  void _req;
  if (!id || id.trim().length === 0) {
    sendError(res, 400, 'invalid_id', 'Cron id must be a non-empty string');
    return;
  }
  try {
    const scheduler = getScheduler();
    const job = scheduler.listCrons().find((c) => c.id === id);
    if (!job) {
      sendError(res, 404, 'cron_not_found', `Cron not found: ${id}`);
      return;
    }
    // A cron's run history is its ordinary sessions (id prefix `cron:<jobId>:`).
    const { sessions } = getCoreStores();
    const rows = sessions.listByPrefix(`cron:${id}:`, { limit: query.limit, offset: query.offset });
    sendJson(res, 200, { runs: rows.map((r, i) => toRunItem(r, job, i === 0)) });
  } catch (err) {
    sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
  }
}

export async function handleCreateCron(
  req: IncomingMessage,
  res: ServerResponse,
  correlationId: string | undefined,
): Promise<void> {
  try {
    const body = (await readJsonBody(req)) as CreateCronBody | undefined;
    if (!body) {
      sendError(res, 400, 'invalid_body', 'Request body is required');
      return;
    }
    if (!body.name || !body.prompt || !body.schedule?.kind) {
      sendError(res, 400, 'invalid_body', 'Body must include name, prompt, schedule.kind');
      return;
    }
    const scheduler = getScheduler();
    const input = toCreateInput(body);
    const created = scheduler.createCron(input);
    await appendAuditEvent(
      getUserDataDir(),
      makeAuditEvent(req, 'cron.create', created.id, correlationId),
    );
    sendJson(res, 201, { cron: toListItem(created) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('schedule') || msg.includes('prompt is required') || msg.includes('model is required')) {
      sendError(res, 400, 'invalid_body', msg);
      return;
    }
    sendError(res, 500, 'internal_error', msg);
  }
}

export async function handleUpdateCron(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  correlationId: string | undefined,
): Promise<void> {
  if (!id || id.trim().length === 0) {
    sendError(res, 400, 'invalid_id', 'Cron id must be a non-empty string');
    return;
  }
  try {
    const body = (await readJsonBody(req)) as UpdateCronBody | undefined;
    if (!body) {
      sendError(res, 400, 'invalid_body', 'Request body is required');
      return;
    }
    const scheduler = getScheduler();
    const updated = scheduler.updateCron(id, toUpdateInput(body));
    await appendAuditEvent(
      getUserDataDir(),
      makeAuditEvent(req, 'cron.update', id, correlationId),
    );
    sendJson(res, 200, { cron: toListItem(updated) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('cron not found')) {
      sendError(res, 404, 'cron_not_found', msg);
      return;
    }
    if (msg.startsWith('schedule')) {
      sendError(res, 400, 'invalid_body', msg);
      return;
    }
    sendError(res, 500, 'internal_error', msg);
  }
}

export async function handleDeleteCron(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  correlationId: string | undefined,
): Promise<void> {
  void req;
  if (!id || id.trim().length === 0) {
    sendError(res, 400, 'invalid_id', 'Cron id must be a non-empty string');
    return;
  }
  try {
    const scheduler = getScheduler();
    const result = scheduler.deleteCron(id);
    if (!result.success) {
      sendError(res, 404, 'cron_not_found', `Cron not found: ${id}`);
      return;
    }
    // appendAuditEvent is best-effort and swallows its own errors,
    // but await it inside the try so a stray throw still surfaces.
    // (Bug history: this branch used to reference an undefined `req`
    // and crashed with ReferenceError, which the outer catch turned
    // into 500 — so the row was already deleted from the DB but the
    // client thought the request failed, and a retry returned 404.)
    await appendAuditEvent(
      getUserDataDir(),
      makeAuditEvent(req, 'cron.delete', id, correlationId),
    );
    sendJson(res, 200, { ok: true, id });
  } catch (err) {
    sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
  }
}

export async function handleRunCron(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  correlationId: string | undefined,
): Promise<void> {
  void req;
  if (!id || id.trim().length === 0) {
    sendError(res, 400, 'invalid_id', 'Cron id must be a non-empty string');
    return;
  }
  try {
    const scheduler = getScheduler();
    const run = await scheduler.runCronNow(id);
    await appendAuditEvent(
      getUserDataDir(),
      makeAuditEvent(req, 'cron.run', id, correlationId),
    );
    sendJson(res, 202, {
      run: {
        id: run.runId,
        cronId: run.cronId,
        runStatus: 'running',
        sessionId: run.sessionId,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('cron not found')) {
      sendError(res, 404, 'cron_not_found', msg);
      return;
    }
    sendError(res, 500, 'internal_error', msg);
  }
}

/** Generate a correlation id when the client didn't supply one. */
export function ensureCorrelationId(header: string | string[] | undefined): string {
  if (typeof header === 'string' && header.trim().length > 0) return header;
  return randomUUID();
}
