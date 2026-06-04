/**
 * packages/agent/src/cli/commands/cron.ts
 *
 * `duya cron` — scheduled-job control plane.
 *
 * Read surface:
 *   list  — all scheduled jobs
 *   info  — single job + recent runs
 *   runs  — run history (paginated)
 *
 * Write surface (Phase 7):
 *   create  — POST /v1/crons
 *   update  — PATCH /v1/crons/:id
 *   delete  — DELETE /v1/crons/:id
 *   run     — POST /v1/crons/:id/run
 *
 * Data source: `electron/automation/Scheduler.ts` (no new logic; thin
 * HTTP facade via `electron/cli/handlers/crons.ts`).
 *
 * Write ops follow `docs/design-docs/cli-control-plane/roadmap.md §3.2`:
 *   - `--yes` required in non-interactive mode
 *   - Interactive confirm in TTY mode
 *   - X-Correlation-Id header
 *   - Audit log at `<userData>/control-plane-audit.log.jsonl`
 *
 * DTOs frozen in roadmap §3.4.
 */

import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stdin, stdout } from 'node:process';

import { CliApiClient } from '../api/client.js';
import { CliApiError } from '../api/errors.js';
import { renderJson, type OutputFormat } from '../api/format.js';
import type { CliSubcommandContext, ExitCode } from '../program/registry.js';

// ---------------------------------------------------------------------------
// DTOs (frozen v1.0.0)
// ---------------------------------------------------------------------------

export type ScheduleKind = 'at' | 'every' | 'cron';
export type CronStatus = 'active' | 'paused' | 'disabled' | 'failed';
export type ConcurrencyPolicy = 'skip' | 'parallel' | 'queue' | 'replace';
export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';

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
  scheduleAt?: number;
  scheduleEveryMs?: number;
  scheduleCronExpr?: string;
  scheduleCronTz?: string;
  workflowId: string;
  prompt: string;
  model?: string;
  concurrencyPolicy: ConcurrencyPolicy;
  maxRetries: number;
  inputParams?: Record<string, unknown>;
  sessionTarget?: string;
  deliveryMode?: string;
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

/**
 * Body sent to `POST /v1/crons`. Mirrors the shape of
 * `CreateAutomationCronInput` from `electron/automation/types.ts`,
 * minus the `id` (which the server generates) and `model` /
 * `sessionTarget` / `deliveryMode` (which are server-side concerns
 * derived from the active provider and CLI defaults).
 *
 * Plan 99 P2 alignment: `at` is now a string (ISO8601) to match
 * `CronSchedule.at`; `workflowId` is dropped (cron routes by id
 * post-create); `enabled` defaults to true when absent.
 */
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

/**
 * Body sent to `PATCH /v1/crons/:id`. Every field is optional.
 * `status` is the server's `CronStatus` ('enabled' | 'disabled' | 'error')
 * — distinct from `enabled?: boolean` (which is the create-side
 * convenience flag that maps to `status: 'enabled' | 'disabled'`).
 */
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
// Text renderers
// ---------------------------------------------------------------------------

function formatDate(ms?: number): string {
  if (!ms) return '-';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function renderListText(jobs: CronListItemDTO[]): string {
  if (jobs.length === 0) return '(no scheduled jobs)';
  const idWidth = Math.max(2, ...jobs.map((j) => j.id.length));
  const nameWidth = Math.max(4, ...jobs.map((j) => j.name.length));
  const header = [
    'ID'.padEnd(idWidth),
    'NAME'.padEnd(nameWidth),
    'STATUS'.padEnd(8),
    'SCHEDULE'.padEnd(20),
    'NEXT RUN'.padEnd(20),
    'LAST ERROR',
  ].join('  ');
  const sep = '-'.repeat(header.length);
  const rows = jobs.map((j) =>
    [
      j.id.padEnd(idWidth),
      j.name.padEnd(nameWidth),
      j.status.padEnd(8),
      j.scheduleExpr.padEnd(20),
      formatDate(j.nextRunAt).padEnd(20),
      j.lastError ? j.lastError.slice(0, 40) : '-',
    ].join('  '),
  );
  return [header, sep, ...rows].join('\n');
}

function renderInfoText(j: CronInfoItemDTO): string {
  const lines = [
    `${j.id}  (${j.name})`,
    `  description:     ${j.description ?? '-'}`,
    `  status:          ${j.status}`,
    `  schedule:`,
    `    kind:          ${j.scheduleKind}`,
    j.scheduleAt ? `    at:            ${formatDate(j.scheduleAt)}` : '',
    j.scheduleEveryMs ? `    everyMs:       ${j.scheduleEveryMs}` : '',
    j.scheduleCronExpr ? `    cronExpr:      ${j.scheduleCronExpr}` : '',
    j.scheduleCronTz ? `    cronTz:        ${j.scheduleCronTz}` : '',
    `  workflowId:      ${j.workflowId}`,
    `  prompt:          ${j.prompt.slice(0, 80)}${j.prompt.length > 80 ? '...' : ''}`,
    `  model:           ${j.model ?? '-'}`,
    `  concurrency:     ${j.concurrencyPolicy}`,
    `  maxRetries:      ${j.maxRetries}`,
    `  nextRunAt:       ${formatDate(j.nextRunAt)}`,
    `  lastRunAt:       ${formatDate(j.lastRunAt)}`,
    `  lastError:       ${j.lastError ?? '-'}`,
    `  createdAt:       ${formatDate(j.createdAt)}`,
    `  updatedAt:       ${formatDate(j.updatedAt)}`,
  ].filter(Boolean);
  return lines.join('\n');
}

function renderRunsText(runs: CronRunItemDTO[]): string {
  if (runs.length === 0) return '(no run history)';
  const lines: string[] = [`${runs.length} run${runs.length !== 1 ? 's' : ''}`];
  for (const r of runs) {
    const dur =
      r.startedAt && r.endedAt ? `${r.endedAt - r.startedAt}ms` : r.startedAt ? 'running' : '-';
    lines.push(
      `  ${r.id}  ${r.runStatus.padEnd(10)} ${formatDate(r.startedAt)}  dur=${dur}  ${r.errorMessage ? r.errorMessage.slice(0, 40) : ''}`,
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isInteractive(): boolean {
  return Boolean(stdin.isTTY);
}

async function promptConfirm(message: string): Promise<boolean> {
  if (!isInteractive()) return false;
  const rl = createInterface({ input: stdin, output: stdout, terminal: false });
  return new Promise<boolean>((resolveYes) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      const v = answer.trim().toLowerCase();
      resolveYes(v === 'y' || v === 'yes');
    });
  });
}

function readBodyFromFile(path: string): CreateCronBody {
  const resolved = resolve(process.cwd(), path);
  if (!existsSync(resolved)) {
    throw new Error(`file not found: ${resolved}`);
  }
  const text = readFileSync(resolved, 'utf-8');
  const parsed = JSON.parse(text) as CreateCronBody;
  if (!parsed.name || !parsed.prompt || !parsed.schedule?.kind) {
    throw new Error(
      'cron spec must include: name, prompt, schedule.kind (at/every/cron)',
    );
  }
  return parsed;
}

function reportError(err: unknown): ExitCode {
  if (err instanceof CliApiError) {
    process.stderr.write(err.hint + '\n');
    return (err.isAppUnavailable() ? 2 : 1) as ExitCode;
  }
  process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
}

async function guardWriteOp(action: string, target: string, yes: boolean): Promise<ExitCode | null> {
  if (!yes && !isInteractive()) {
    process.stderr.write(
      `interactive_required: ${action} requires --yes in non-interactive mode\n`,
    );
    return 3;
  }
  if (!yes) {
    const confirmed = await promptConfirm(`Confirm ${action} '${target}'?`);
    if (!confirmed) {
      process.stderr.write(`aborted: ${action} of '${target}' cancelled\n`);
      return 1;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Subcommand implementations
// ---------------------------------------------------------------------------

async function listJobs(format: OutputFormat): Promise<ExitCode> {
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<{ crons: CronListItemDTO[] }>('/v1/crons');
    process.stdout.write(
      format === 'json' ? renderJson(body) + '\n' : renderListText(body.crons) + '\n',
    );
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

async function infoJob(id: string, format: OutputFormat): Promise<ExitCode> {
  if (!id) {
    process.stderr.write('Usage: duya cron info <id>\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<{ cron: CronInfoItemDTO }>(
      `/v1/crons/${encodeURIComponent(id)}`,
    );
    process.stdout.write(
      format === 'json' ? renderJson(body) + '\n' : renderInfoText(body.cron) + '\n',
    );
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

async function createJob(ctx: CliSubcommandContext): Promise<ExitCode> {
  // Plan 99 P3: prefer `--cron <json>` (inline body) over `--from-file`
  const cronJson = (ctx.options as Record<string, unknown>)['cron'] as string | undefined;
  const fromFile = typeof ctx.options.fromFile === 'string' ? ctx.options.fromFile : undefined;
  const prompt = typeof ctx.options.prompt === 'string' ? ctx.options.prompt : undefined;

  if (!cronJson && !fromFile) {
    process.stderr.write(
      'duya cron create requires --cron <json> (inline body) or --from-file <path>\n',
    );
    return 64;
  }

  let body: CreateCronBody;
  try {
    if (cronJson) {
      body = JSON.parse(cronJson) as CreateCronBody;
    } else {
      body = readBodyFromFile(fromFile!);
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 64;
  }

  const guard = await guardWriteOp(
    'create cron',
    body.name,
    ctx.options.yes === true,
  );
  if (guard !== null) return guard;

  const correlationId = randomUUID();
  try {
    const client = await CliApiClient.connect();
    const res = await client.post<{ cron: CronListItemDTO }>(
      '/v1/crons',
      body,
      { correlationId },
    );
    if (ctx.format === 'json') {
      process.stdout.write(renderJson({ cron: res.cron, correlationId }) + '\n');
    } else {
      process.stdout.write(
        `created cron '${res.cron.id}' (${res.cron.name}) (correlationId=${correlationId})\n`,
      );
    }
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

async function updateJob(ctx: CliSubcommandContext): Promise<ExitCode> {
  const id = ctx.args[0];
  if (!id) {
    process.stderr.write('Usage: duya cron update <id> --from-file <path>\n');
    return 64;
  }
  const cronJson = (ctx.options as Record<string, unknown>)['cron'] as string | undefined;
  const fromFile = typeof ctx.options.fromFile === 'string' ? ctx.options.fromFile : undefined;
  if (!cronJson && !fromFile) {
    process.stderr.write('duya cron update requires --cron <json> or --from-file <path>\n');
    return 64;
  }

  let body: UpdateCronBody;
  try {
    if (cronJson) {
      body = JSON.parse(cronJson) as UpdateCronBody;
    } else {
      // --from-file may carry a CreateCronBody shape; we accept either
      // and pass through to PATCH, which ignores unknown server fields.
      body = readBodyFromFile(fromFile!);
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 64;
  }

  const guard = await guardWriteOp('update cron', id, ctx.options.yes === true);
  if (guard !== null) return guard;

  const correlationId = randomUUID();
  try {
    const client = await CliApiClient.connect();
    // Plan 99 P2: cron update uses PATCH /v1/crons/:id (was POST).
    const res = await client.patch<{ cron: CronListItemDTO }>(
      `/v1/crons/${encodeURIComponent(id)}`,
      body,
      { correlationId },
    );
    if (ctx.format === 'json') {
      process.stdout.write(renderJson({ cron: res.cron, correlationId }) + '\n');
    } else {
      process.stdout.write(`updated cron '${id}' (correlationId=${correlationId})\n`);
    }
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

async function deleteJob(ctx: CliSubcommandContext): Promise<ExitCode> {
  const id = ctx.args[0];
  if (!id) {
    process.stderr.write('Usage: duya cron delete <id>\n');
    return 64;
  }

  const guard = await guardWriteOp('delete cron', id, ctx.options.yes === true);
  if (guard !== null) return guard;

  const correlationId = randomUUID();
  try {
    const client = await CliApiClient.connect();
    // Plan 99 P2: cron delete uses DELETE /v1/crons/:id (was POST /:id/delete).
    await client.delete<{ ok: true }>(
      `/v1/crons/${encodeURIComponent(id)}`,
      { correlationId },
    );
    if (ctx.format === 'json') {
      process.stdout.write(renderJson({ ok: true, id, correlationId }) + '\n');
    } else {
      process.stdout.write(`deleted cron '${id}' (correlationId=${correlationId})\n`);
    }
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

async function runJob(ctx: CliSubcommandContext): Promise<ExitCode> {
  const id = ctx.args[0];
  if (!id) {
    process.stderr.write('Usage: duya cron run <id>\n');
    return 64;
  }

  const guard = await guardWriteOp('run cron', id, ctx.options.yes === true);
  if (guard !== null) return guard;

  const correlationId = randomUUID();
  try {
    const client = await CliApiClient.connect();
    const res = await client.post<{ run: CronRunItemDTO }>(
      `/v1/crons/${encodeURIComponent(id)}/run`,
      {},
      { correlationId },
    );
    if (ctx.format === 'json') {
      process.stdout.write(renderJson({ run: res.run, correlationId }) + '\n');
    } else {
      process.stdout.write(
        `triggered run ${res.run.id} for cron '${id}' (status=${res.run.runStatus}, correlationId=${correlationId})\n`,
      );
    }
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

async function listRuns(ctx: CliSubcommandContext): Promise<ExitCode> {
  const id = ctx.args[0];
  if (!id) {
    process.stderr.write('Usage: duya cron runs <id>\n');
    return 64;
  }
  const params = new URLSearchParams();
  if (typeof ctx.options.limit === 'string') params.set('limit', ctx.options.limit);
  if (typeof ctx.options.offset === 'string') params.set('offset', ctx.options.offset);
  const query = params.toString();
  const path = `/v1/crons/${encodeURIComponent(id)}/runs${query ? `?${query}` : ''}`;
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<{ runs: CronRunItemDTO[] }>(path);
    process.stdout.write(
      ctx.format === 'json' ? renderJson(body) + '\n' : renderRunsText(body.runs) + '\n',
    );
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

// ---------------------------------------------------------------------------
// Public surface (consumed by descriptors.ts)
// ---------------------------------------------------------------------------

export const runCronCommand = {
  list: (ctx: CliSubcommandContext): Promise<ExitCode> => listJobs(ctx.format),
  info: (ctx: CliSubcommandContext): Promise<ExitCode> =>
    infoJob(ctx.args[0] ?? '', ctx.format),
  create: createJob,
  update: updateJob,
  delete: deleteJob,
  run: runJob,
  runs: listRuns,
};
