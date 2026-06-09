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
import { appendAuditEvent, type AuditEvent } from '../../services/controlPlaneAudit';
import type {
  AutomationCron,
  AutomationCronRun,
  CreateAutomationCronInput,
  UpdateAutomationCronInput,
  CronSchedule,
  CronStatus as DbCronStatus,
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
  scheduleAt?: string;
  scheduleEveryMs?: number;
  scheduleCronExpr?: string;
  scheduleCronTz?: string;
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
  schedule: {
    kind: ScheduleKind;
    at?: string;
    everyMs?: number;
    cronExpr?: string;
    cronTz?: string;
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
  if (row.schedule_kind === 'at') return row.schedule_at ? `at ${row.schedule_at}` : '-';
  if (row.schedule_kind === 'every') return row.schedule_every_ms ? `every ${row.schedule_every_ms}ms` : '-';
  if (row.schedule_kind === 'cron') return row.schedule_cron_expr || '-';
  return '-';
}

function toListItem(row: AutomationCron): CronListItemDTO {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    status: row.status as CronStatus,
    scheduleKind: row.schedule_kind,
    scheduleExpr: scheduleSummary(row),
    nextRunAt: row.next_run_at ?? undefined,
    lastRunAt: row.last_run_at ?? undefined,
    lastError: row.last_error ?? undefined,
  };
}

function toInfoItem(row: AutomationCron): CronInfoItemDTO {
  return {
    ...toListItem(row),
    scheduleAt: row.schedule_at ?? undefined,
    scheduleEveryMs: row.schedule_every_ms ?? undefined,
    scheduleCronExpr: row.schedule_cron_expr ?? undefined,
    scheduleCronTz: row.schedule_cron_tz ?? undefined,
    prompt: row.prompt,
    model: row.model,
    concurrencyPolicy: row.concurrency_policy,
    maxRetries: row.max_retries,
    inputParams: parseInputParams(row.input_params),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseInputParams(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function toRunItem(row: AutomationCronRun): CronRunItemDTO {
  return {
    id: row.id,
    cronId: row.cron_id,
    runStatus: row.run_status as RunStatus,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    output: row.output ?? undefined,
    errorMessage: row.error_message ?? undefined,
    sessionId: row.session_id ?? undefined,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Wire DTO → scheduler input mappers
// ---------------------------------------------------------------------------

function toSchedulerSchedule(s: CreateCronBody['schedule']): CronSchedule {
  return {
    kind: s.kind,
    at: s.at,
    everyMs: s.everyMs,
    cronExpr: s.cronExpr,
    cronTz: s.cronTz,
  };
}

function toCreateInput(body: CreateCronBody): CreateAutomationCronInput {
  return {
    name: body.name,
    description: body.description,
    schedule: toSchedulerSchedule(body.schedule),
    prompt: body.prompt,
    model: body.model ?? '',
    inputParams: body.inputParams,
    concurrencyPolicy: body.concurrencyPolicy,
    maxRetries: body.maxRetries,
    enabled: body.enabled,
  };
}

function toUpdateInput(body: UpdateCronBody): UpdateAutomationCronInput {
  return {
    name: body.name,
    description: body.description,
    schedule: body.schedule ? toSchedulerSchedule(body.schedule) : undefined,
    prompt: body.prompt,
    model: body.model,
    inputParams: body.inputParams,
    concurrencyPolicy: body.concurrencyPolicy,
    maxRetries: body.maxRetries,
    status: body.status as DbCronStatus | undefined,
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
    // Verify the cron exists so 404 trumps empty result.
    const exists = scheduler.listCrons().some((c) => c.id === id);
    if (!exists) {
      sendError(res, 404, 'cron_not_found', `Cron not found: ${id}`);
      return;
    }
    const runs = scheduler.listCronRuns({ cronId: id, limit: query.limit, offset: query.offset });
    sendJson(res, 200, { runs: runs.map(toRunItem) });
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
    sendJson(res, 202, { run: toRunItem(run) });
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
