import { Cron } from 'croner';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { CronJob } from '../config/schema.js';
import type { ConfigStore } from '../config/store.js';
import { getConfigStore } from '../config/store-instance.js';
import type {
  AutomationCron,
  AutomationCronRun,
  ConcurrencyPolicy,
  CreateAutomationCronInput,
  CronSchedule,
  CronStatus,
  ListCronRunsInput,
  UpdateAutomationCronInput,
} from './types.js';
import { resolveAutomationWorkspace } from './workspace.js';

const DEFAULT_MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = [30_000, 60_000, 300_000];
const MAX_RUNS_PER_CRON = 500;

interface CronStateRow {
  cron_id: string;
  status: CronStatus | null;
  next_run_at: number | null;
  last_run_at: number | null;
  last_error: string | null;
  retry_count: number;
  created_at: number;
  updated_at: number;
}

export function normalizeCronStatus(value: string | undefined): CronStatus {
  if (value === 'enabled' || value === 'disabled' || value === 'error') return value;
  return 'enabled';
}

export function assertValidSchedule(schedule: CronSchedule): void {
  if (!schedule || typeof schedule !== 'object') throw new Error('schedule is required');
  if (schedule.endAt && Number.isNaN(Date.parse(schedule.endAt))) {
    throw new Error(`schedule.endAt must be an ISO date-time; got: ${JSON.stringify(schedule.endAt)}`);
  }
  if (schedule.kind === 'at') {
    if (!schedule.at || Number.isNaN(Date.parse(schedule.at))) {
      throw new Error(
        `schedule.at is required for kind="at" (e.g. "2026-12-31T23:59:00Z"); got: ${JSON.stringify(schedule.at)}.\n` +
          `  Example: { "name": "...", "prompt": "...", "schedule": { "kind": "at", "at": "2026-12-31T23:59:00Z" } }`,
      );
    }
    return;
  }
  if (schedule.kind === 'every') {
    if (!schedule.everyMs || !Number.isFinite(schedule.everyMs) || schedule.everyMs <= 0) {
      throw new Error(
        `schedule.everyMs is required for kind="every" (positive ms, e.g. 300000 for 5 min); got: ${JSON.stringify(schedule.everyMs)}.\n` +
          `  Example: { "name": "...", "prompt": "...", "schedule": { "kind": "every", "everyMs": 300000 } }`,
      );
    }
    return;
  }
  if (schedule.kind === 'cron') {
    if (!schedule.cronExpr?.trim()) {
      throw new Error(
        `schedule.cronExpr is required for kind="cron" (5-field expression, e.g. "0 9 * * *"); got: ${JSON.stringify(schedule.cronExpr)}.\n` +
          `  Example: { "name": "...", "prompt": "...", "schedule": { "kind": "cron", "cronExpr": "0 9 * * *" } }`,
      );
    }
    try { new Cron(schedule.cronExpr, { timezone: schedule.cronTz || undefined, catch: false }); }
    catch (error) { throw new Error(`invalid cron expression "${schedule.cronExpr}": ${error instanceof Error ? error.message : String(error)}`); }
    return;
  }
  throw new Error(
    `unsupported schedule.kind: ${(schedule as { kind?: string }).kind ?? 'unknown'} (expected one of: "at", "every", "cron")`,
  );
}

export function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | null {
  const endAtMs = schedule.endAt ? Date.parse(schedule.endAt) : null;
  const withinEnd = (candidate: number | null): number | null => {
    if (candidate === null) return null;
    if (endAtMs !== null && Number.isFinite(endAtMs) && candidate > endAtMs) return null;
    return candidate;
  };
  if (schedule.kind === 'at') {
    const at = Date.parse(schedule.at || '');
    if (!Number.isFinite(at) || at <= nowMs) return null;
    return withinEnd(at);
  }
  if (schedule.kind === 'every') {
    const everyMs = Math.max(1, Math.floor(schedule.everyMs || 0));
    if (!Number.isFinite(everyMs) || everyMs <= 0) return null;
    return withinEnd(nowMs + everyMs);
  }
  if (schedule.kind === 'cron') {
    const expr = schedule.cronExpr?.trim() || '';
    if (!expr) return null;
    const cron = new Cron(expr, { timezone: schedule.cronTz || undefined, catch: false });
    const next = cron.nextRun(new Date(nowMs));
    if (!next) return null;
    const nextMs = next.getTime();
    if (!Number.isFinite(nextMs) || nextMs <= nowMs) return null;
    return withinEnd(nextMs);
  }
  return null;
}

export function rowToSchedule(row: AutomationCron): CronSchedule {
  const endAt = row.schedule_end_at || undefined;
  if (row.schedule_kind === 'at') return { kind: 'at', at: row.schedule_at || undefined, endAt };
  if (row.schedule_kind === 'every') return { kind: 'every', everyMs: row.schedule_every_ms || undefined, endAt };
  return { kind: 'cron', cronExpr: row.schedule_cron_expr || undefined, cronTz: row.schedule_cron_tz || undefined, endAt };
}

export class CronStore {
  private readonly db: Database.Database;
  private readonly store: ConfigStore;

  constructor(db: Database.Database) {
    this.db = db;
    this.store = getConfigStore();
  }

  // ==== definition / state helpers ====

  private defs(): CronJob[] {
    const raw = this.store.getByPath('cron.jobs');
    return Array.isArray(raw) ? (raw as CronJob[]) : [];
  }

  private def(id: string): CronJob | undefined {
    return this.defs().find((d) => d.id === id);
  }

  private setDefs(jobs: CronJob[]): void {
    this.store.set('cron.jobs', jobs);
  }

  private state(id: string): CronStateRow | null {
    const row = this.db
      .prepare(
        'SELECT cron_id, status, next_run_at, last_run_at, last_error, retry_count, created_at, updated_at FROM automation_cron_state WHERE cron_id = ?',
      )
      .get(id) as CronStateRow | undefined;
    return row ?? null;
  }

  private ensureState(id: string, created: number): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO automation_cron_state (cron_id, status, next_run_at, last_run_at, last_error, retry_count, created_at, updated_at) VALUES (?, NULL, NULL, NULL, NULL, 0, ?, ?)',
      )
      .run(id, created, created);
  }

  private setStateStatus(id: string, status: CronStatus | null): void {
    this.db.prepare('UPDATE automation_cron_state SET status = ?, updated_at = ? WHERE cron_id = ?').run(status, Date.now(), id);
  }

  private defToCron(def: CronJob, st: CronStateRow | null): AutomationCron {
    const now = Date.now();
    return {
      id: def.id,
      name: def.name,
      description: def.description ?? null,
      tags: def.tags ?? [],
      schedule_kind: def.schedule_kind,
      schedule_at: def.schedule_at ?? null,
      schedule_every_ms: def.schedule_every_ms ?? null,
      schedule_cron_expr: def.schedule_cron_expr ?? null,
      schedule_cron_tz: def.schedule_cron_tz ?? null,
      schedule_end_at: def.schedule_end_at ?? null,
      workflow_id: def.workflow_id ?? null,
      working_directory: def.working_directory,
      prompt: def.prompt,
      input_params: JSON.stringify(def.input_params ?? {}),
      session_target: 'isolated',
      delivery_mode: 'none',
      status: st?.status ?? def.status,
      model: def.model,
      last_run_at: st?.last_run_at ?? null,
      next_run_at: st?.next_run_at ?? null,
      last_error: st?.last_error ?? null,
      retry_count: st?.retry_count ?? 0,
      concurrency_policy: def.concurrency_policy,
      max_retries: def.max_retries,
      created_at: st?.created_at ?? now,
      updated_at: st?.updated_at ?? now,
    };
  }

  // ==== public API ====

  getCron(id: string): AutomationCron | null {
    const d = this.def(id);
    if (!d) return null;
    return this.defToCron(d, this.state(id));
  }

  listCrons(): AutomationCron[] {
    return this.defs()
      .map((d) => this.defToCron(d, this.state(d.id)))
      .sort((a, b) => b.updated_at - a.updated_at);
  }

  listCronRuns(input: ListCronRunsInput): AutomationCronRun[] {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 200);
    const offset = Math.max(input.offset ?? 0, 0);
    return this.db.prepare('SELECT * FROM automation_cron_runs WHERE cron_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(input.cronId, limit, offset) as AutomationCronRun[];
  }

  createCron(input: CreateAutomationCronInput): AutomationCron {
    assertValidSchedule(input.schedule);
    if (!input.prompt?.trim()) {
      throw new Error(
        `prompt is required (the natural-language instruction the scheduled run will execute); got: ${JSON.stringify(input.prompt)}`,
      );
    }
    if (!input.model?.trim()) {
      throw new Error(
        `model is required (provider model id, e.g. "minimax"); got: ${JSON.stringify(input.model)}`,
      );
    }

    const now = Date.now();
    const id = randomUUID();
    const status: CronStatus = input.enabled === false ? 'disabled' : 'enabled';
    const def: CronJob = {
      id,
      name: input.name,
      description: input.description ?? undefined,
      tags: input.tags,
      schedule_kind: input.schedule.kind,
      schedule_at: input.schedule.kind === 'at' ? input.schedule.at ?? undefined : undefined,
      schedule_every_ms: input.schedule.kind === 'every' ? input.schedule.everyMs ?? undefined : undefined,
      schedule_cron_expr: input.schedule.kind === 'cron' ? input.schedule.cronExpr ?? undefined : undefined,
      schedule_cron_tz: input.schedule.kind === 'cron' ? (input.schedule.cronTz ?? undefined) : undefined,
      schedule_end_at: input.schedule.endAt ?? undefined,
      working_directory: resolveAutomationWorkspace(input.workingDirectory),
      prompt: input.prompt.trim(),
      input_params: input.inputParams ?? {},
      model: input.model.trim(),
      status,
      concurrency_policy: (input.concurrencyPolicy ?? 'skip') as ConcurrencyPolicy,
      max_retries: input.maxRetries ?? DEFAULT_MAX_RETRIES,
    };

    this.setDefs([...this.defs(), def]);
    this.ensureState(id, now);
    if (status === 'enabled') {
      this.updateNextRunAt(id, computeNextRunAtMs(input.schedule, now));
    }

    return this.getCron(id)!;
  }

  updateCron(id: string, patch: UpdateAutomationCronInput): AutomationCron {
    const current = this.getCron(id);
    if (!current) throw new Error(`cron not found: ${id}`);
    const currentDef = this.def(id)!;

    const now = Date.now();
    const mergedSchedule = patch.schedule ?? rowToSchedule(current);
    assertValidSchedule(mergedSchedule);
    const nextStatus = patch.status ? normalizeCronStatus(patch.status) : current.status;

    const updated: CronJob = {
      ...currentDef,
      name: patch.name ?? currentDef.name,
      description: patch.description !== undefined ? (patch.description ?? undefined) : currentDef.description,
      tags: patch.tags !== undefined ? patch.tags : currentDef.tags,
      schedule_kind: mergedSchedule.kind,
      schedule_at: mergedSchedule.kind === 'at' ? mergedSchedule.at ?? undefined : undefined,
      schedule_every_ms: mergedSchedule.kind === 'every' ? mergedSchedule.everyMs ?? undefined : undefined,
      schedule_cron_expr: mergedSchedule.kind === 'cron' ? mergedSchedule.cronExpr ?? undefined : undefined,
      schedule_cron_tz: mergedSchedule.kind === 'cron' ? (mergedSchedule.cronTz ?? undefined) : undefined,
      schedule_end_at: mergedSchedule.endAt ?? undefined,
      working_directory: patch.workingDirectory !== undefined ? resolveAutomationWorkspace(patch.workingDirectory) : currentDef.working_directory,
      prompt: patch.prompt !== undefined ? patch.prompt.trim() : currentDef.prompt,
      input_params: patch.inputParams !== undefined ? patch.inputParams : currentDef.input_params,
      model: patch.model !== undefined ? patch.model.trim() : currentDef.model,
      status: nextStatus,
      concurrency_policy: (patch.concurrencyPolicy ?? currentDef.concurrency_policy) as ConcurrencyPolicy,
      max_retries: patch.maxRetries ?? currentDef.max_retries,
    };

    this.setDefs(this.defs().map((d) => (d.id === id ? updated : d)));

    // A user-provided status clears any runtime override stored in state.
    if (patch.status !== undefined) this.setStateStatus(id, null);

    if (patch.schedule || patch.status !== undefined) {
      this.updateNextRunAt(id, nextStatus === 'enabled' ? computeNextRunAtMs(mergedSchedule, now) : null);
    }

    return this.getCron(id)!;
  }

  deleteCron(id: string): { success: boolean } {
    const defs = this.defs();
    const filtered = defs.filter((d) => d.id !== id);
    // Capture existence before writing, since setDefs may mutate the array
    // reference returned by defs() in place.
    const success = defs.length !== filtered.length;
    this.setDefs(filtered);
    this.db.prepare('DELETE FROM automation_cron_state WHERE cron_id = ?').run(id);
    return { success };
  }

  insertRun(cronId: string, reason: string): string {
    const runId = randomUUID();
    const now = Date.now();
    this.db.prepare(`INSERT INTO automation_cron_runs (id, cron_id, run_status, started_at, ended_at, output, error_message, logs, created_at) VALUES (?, ?, 'cancelled', ?, ?, NULL, ?, ?, ?)`)
      .run(runId, cronId, now, now, reason, reason, now);
    return runId;
  }

  beginRun(runId: string, cronId: string, sessionId: string, manual: boolean): void {
    const now = Date.now();
    this.db.prepare(`INSERT INTO automation_cron_runs (id, cron_id, run_status, started_at, ended_at, output, error_message, logs, session_id, created_at) VALUES (?, ?, 'running', ?, NULL, NULL, NULL, ?, ?, ?)`).run(runId, cronId, now, manual ? 'manual-trigger' : 'scheduled', sessionId, now);
  }

  getRun(runId: string): AutomationCronRun | undefined {
    return this.db.prepare('SELECT * FROM automation_cron_runs WHERE id = ?').get(runId) as AutomationCronRun | undefined;
  }

  finishRunSuccess(cronId: string, runId: string, output: string): void {
    const now = Date.now();
    this.db.prepare(`UPDATE automation_cron_runs SET run_status='success', ended_at=?, output=?, error_message=NULL WHERE id=?`).run(now, output, runId);
    this.db.prepare(`UPDATE automation_cron_state SET last_run_at=?, last_error=NULL, retry_count=0, updated_at=? WHERE cron_id=?`).run(now, now, cronId);
  }

  finishRunFailure(cron: AutomationCron, runId: string, reason: string): { shouldRetry: boolean; retryDelay: number } {
    const now = Date.now();
    const shouldRetry = cron.retry_count < cron.max_retries;
    const nextRetryCount = cron.retry_count + 1;
    const state = this.state(cron.id);
    const status: CronStatus | null = shouldRetry ? (state?.status ?? null) : 'error';

    this.db.prepare(`UPDATE automation_cron_runs SET run_status='failed', ended_at=?, error_message=?, logs=? WHERE id=?`).run(now, reason, reason, runId);
    this.db.prepare(`UPDATE automation_cron_state SET last_error=?, retry_count=?, updated_at=?, status=? WHERE cron_id=?`).run(reason, nextRetryCount, now, status, cron.id);

    const retryDelay = RETRY_BACKOFF_MS[Math.min(cron.retry_count, RETRY_BACKOFF_MS.length - 1)];
    return { shouldRetry, retryDelay };
  }

  loadEnabledCrons(): AutomationCron[] {
    return this.listCrons().filter((c) => c.status === 'enabled');
  }

  updateNextRunAt(id: string, nextRunAt: number | null): void {
    this.db.prepare('UPDATE automation_cron_state SET next_run_at = ?, updated_at = ? WHERE cron_id = ?').run(nextRunAt, Date.now(), id);
  }

  disableExhaustedCron(id: string): void {
    this.db.prepare("UPDATE automation_cron_state SET status = 'disabled', next_run_at = NULL, updated_at = ? WHERE cron_id = ?")
      .run(Date.now(), id);
  }

  markScheduleError(id: string, reason: string): void {
    this.db.prepare("UPDATE automation_cron_state SET status = 'error', next_run_at = NULL, last_error = ?, updated_at = ? WHERE cron_id = ?")
      .run(reason, Date.now(), id);
  }

  cleanupOldRuns(): { deletedCount: number } {
    const ids = this.defs().map((d) => d.id);
    let totalDeleted = 0;

    for (const cronId of ids) {
      const row = this.db.prepare(
        'SELECT id FROM automation_cron_runs WHERE cron_id = ? ORDER BY created_at DESC LIMIT 1 OFFSET ?'
      ).get(cronId, MAX_RUNS_PER_CRON) as { id: string } | undefined;

      if (row) {
        const result = this.db.prepare(
          'DELETE FROM automation_cron_runs WHERE cron_id = ? AND created_at <= (SELECT created_at FROM automation_cron_runs WHERE id = ?) AND id != ?'
        ).run(cronId, row.id, row.id);
        totalDeleted += result.changes;
      }
    }

    return { deletedCount: totalDeleted };
  }
}
