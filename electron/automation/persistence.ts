import { Cron } from 'croner';
import type Database from 'better-sqlite3';
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

const DEFAULT_MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = [30_000, 60_000, 300_000];
const MAX_RUNS_PER_CRON = 500;

export function normalizeCronStatus(value: string | undefined): CronStatus {
  if (value === 'enabled' || value === 'disabled' || value === 'error') return value;
  return 'enabled';
}

export function assertValidSchedule(schedule: CronSchedule): void {
  if (!schedule || typeof schedule !== 'object') throw new Error('schedule is required');
  if (schedule.kind === 'at') {
    if (!schedule.at || Number.isNaN(Date.parse(schedule.at))) throw new Error('schedule.at must be a valid ISO date');
    return;
  }
  if (schedule.kind === 'every') {
    if (!schedule.everyMs || !Number.isFinite(schedule.everyMs) || schedule.everyMs <= 0) throw new Error('schedule.everyMs must be a positive number');
    return;
  }
  if (schedule.kind === 'cron') {
    if (!schedule.cronExpr?.trim()) throw new Error('schedule.cronExpr is required');
    try { new Cron(schedule.cronExpr, { timezone: schedule.cronTz || undefined, catch: false }); }
    catch (error) { throw new Error(`invalid cron expression: ${error instanceof Error ? error.message : String(error)}`); }
    return;
  }
  throw new Error(`unsupported schedule kind: ${(schedule as { kind?: string }).kind ?? 'unknown'}`);
}

export function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | null {
  if (schedule.kind === 'at') {
    const at = Date.parse(schedule.at || '');
    if (!Number.isFinite(at) || at <= nowMs) return null;
    return at;
  }
  if (schedule.kind === 'every') {
    const everyMs = Math.max(1, Math.floor(schedule.everyMs || 0));
    if (!Number.isFinite(everyMs) || everyMs <= 0) return null;
    return nowMs + everyMs;
  }
  if (schedule.kind === 'cron') {
    const expr = schedule.cronExpr?.trim() || '';
    if (!expr) return null;
    const cron = new Cron(expr, { timezone: schedule.cronTz || undefined, catch: false });
    const next = cron.nextRun(new Date(nowMs));
    if (!next) return null;
    const nextMs = next.getTime();
    if (!Number.isFinite(nextMs) || nextMs <= nowMs) return null;
    return nextMs;
  }
  return null;
}

export function rowToSchedule(row: AutomationCron): CronSchedule {
  if (row.schedule_kind === 'at') return { kind: 'at', at: row.schedule_at || undefined };
  if (row.schedule_kind === 'every') return { kind: 'every', everyMs: row.schedule_every_ms || undefined };
  return { kind: 'cron', cronExpr: row.schedule_cron_expr || undefined, cronTz: row.schedule_cron_tz || undefined };
}

export class CronPersistence {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  getCron(id: string): AutomationCron | null {
    const row = this.db.prepare('SELECT * FROM automation_crons WHERE id = ?').get(id) as AutomationCron | undefined;
    return row ?? null;
  }

  listCrons(): AutomationCron[] {
    return this.db.prepare('SELECT * FROM automation_crons ORDER BY updated_at DESC').all() as AutomationCron[];
  }

  listCronRuns(input: ListCronRunsInput): AutomationCronRun[] {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 200);
    const offset = Math.max(input.offset ?? 0, 0);
    return this.db.prepare('SELECT * FROM automation_cron_runs WHERE cron_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(input.cronId, limit, offset) as AutomationCronRun[];
  }

  createCron(input: CreateAutomationCronInput): AutomationCron {
    assertValidSchedule(input.schedule);
    if (!input.prompt?.trim()) throw new Error('prompt is required');
    if (!input.model?.trim()) throw new Error('model is required');

    const { randomUUID } = require('crypto');
    const now = Date.now();
    const id = randomUUID();
    const status: CronStatus = input.enabled === false ? 'disabled' : 'enabled';
    const nextRunAt = status === 'enabled' ? computeNextRunAtMs(input.schedule, now) : null;

    this.db.prepare(`
      INSERT INTO automation_crons (
        id, name, description, schedule_kind, schedule_at, schedule_every_ms, schedule_cron_expr, schedule_cron_tz,
        workflow_id, prompt, input_params, session_target, delivery_mode, status, model, last_run_at, next_run_at, last_error,
        retry_count, concurrency_policy, max_retries, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'isolated', 'none', ?, ?, NULL, ?, NULL, 0, ?, ?, ?, ?)
    `).run(
      id, input.name, input.description ?? null,
      input.schedule.kind, input.schedule.kind === 'at' ? input.schedule.at ?? null : null,
      input.schedule.kind === 'every' ? input.schedule.everyMs ?? null : null,
      input.schedule.kind === 'cron' ? input.schedule.cronExpr ?? null : null,
      input.schedule.kind === 'cron' ? input.schedule.cronTz ?? null : null,
      null, input.prompt.trim(), JSON.stringify(input.inputParams ?? {}),
      status, input.model.trim(), nextRunAt,
      input.concurrencyPolicy ?? 'skip' as ConcurrencyPolicy, input.maxRetries ?? DEFAULT_MAX_RETRIES, now, now
    );

    return this.getCron(id)!;
  }

  updateCron(id: string, patch: UpdateAutomationCronInput): AutomationCron {
    const current = this.getCron(id);
    if (!current) throw new Error(`cron not found: ${id}`);

    const now = Date.now();
    const mergedSchedule = patch.schedule ?? rowToSchedule(current);
    assertValidSchedule(mergedSchedule);
    const nextStatus = patch.status ? normalizeCronStatus(patch.status) : current.status;
    const nextRunAt = (patch.schedule || patch.status !== undefined) && nextStatus === 'enabled'
      ? computeNextRunAtMs(mergedSchedule, now) : current.next_run_at;

    this.db.prepare(`
      UPDATE automation_crons SET name=?, description=?, schedule_kind=?, schedule_at=?, schedule_every_ms=?,
        schedule_cron_expr=?, schedule_cron_tz=?, prompt=?, input_params=?, status=?, model=?, next_run_at=?,
        concurrency_policy=?, max_retries=?, updated_at=? WHERE id=?
    `).run(
      patch.name ?? current.name, patch.description !== undefined ? patch.description : current.description,
      mergedSchedule.kind, mergedSchedule.kind === 'at' ? mergedSchedule.at ?? null : null,
      mergedSchedule.kind === 'every' ? mergedSchedule.everyMs ?? null : null,
      mergedSchedule.kind === 'cron' ? mergedSchedule.cronExpr ?? null : null,
      mergedSchedule.kind === 'cron' ? mergedSchedule.cronTz ?? null : null,
      patch.prompt !== undefined ? patch.prompt.trim() : current.prompt,
      patch.inputParams !== undefined ? JSON.stringify(patch.inputParams) : current.input_params,
      nextStatus, patch.model !== undefined ? patch.model.trim() : current.model, nextRunAt,
      patch.concurrencyPolicy ?? current.concurrency_policy, patch.maxRetries ?? current.max_retries, now, id
    );

    return this.getCron(id)!;
  }

  deleteCron(id: string): { success: boolean } {
    const result = this.db.prepare('DELETE FROM automation_crons WHERE id = ?').run(id);
    return { success: result.changes > 0 };
  }

  insertRun(cronId: string, reason: string): string {
    const { randomUUID } = require('crypto');
    const runId = randomUUID();
    const now = Date.now();
    this.db.prepare(`INSERT INTO automation_cron_runs (id, cron_id, run_status, started_at, ended_at, output, error_message, logs, created_at) VALUES (?, ?, 'cancelled', ?, ?, NULL, ?, ?, ?)`)
      .run(runId, cronId, now, now, reason, reason, now);
    return runId;
  }

  finishRunSuccess(cronId: string, runId: string, output: string): void {
    const now = Date.now();
    this.db.prepare(`UPDATE automation_cron_runs SET run_status='success', ended_at=?, output=?, error_message=NULL WHERE id=?`).run(now, output, runId);
    this.db.prepare(`UPDATE automation_crons SET last_run_at=?, last_error=NULL, retry_count=0, updated_at=? WHERE id=?`).run(now, now, cronId);
  }

  finishRunFailure(cron: AutomationCron, runId: string, reason: string): { shouldRetry: boolean; retryDelay: number } {
    const now = Date.now();
    const shouldRetry = cron.retry_count < cron.max_retries;
    const nextRetryCount = cron.retry_count + 1;

    this.db.prepare(`UPDATE automation_cron_runs SET run_status='failed', ended_at=?, error_message=?, logs=? WHERE id=?`).run(now, reason, reason, runId);
    this.db.prepare(`UPDATE automation_crons SET last_error=?, retry_count=?, updated_at=?, status=? WHERE id=?`).run(reason, nextRetryCount, now, shouldRetry ? cron.status : 'error', cron.id);

    const retryDelay = RETRY_BACKOFF_MS[Math.min(cron.retry_count, RETRY_BACKOFF_MS.length - 1)];
    return { shouldRetry, retryDelay };
  }

  insertChatSession(sessionId: string, name: string, model: string, providerId: string): void {
    const now = Date.now();
    this.db.prepare(`INSERT INTO chat_sessions (id, title, created_at, updated_at, model, system_prompt, working_directory, project_name, status, mode, permission_profile, provider_id, context_summary, context_summary_updated_at, is_deleted, generation) VALUES (?, ?, ?, ?, ?, '', '', '', 'active', 'automation', 'default', ?, '', 0, 0, 0)`)
      .run(sessionId, name, now, now, model, providerId);
  }

  beginRun(runId: string, cronId: string, sessionId: string, manual: boolean): void {
    const now = Date.now();
    this.db.prepare(`INSERT INTO automation_cron_runs (id, cron_id, run_status, started_at, ended_at, output, error_message, logs, session_id, created_at) VALUES (?, ?, 'running', ?, NULL, NULL, NULL, ?, ?, ?)`).run(runId, cronId, now, manual ? 'manual-trigger' : 'scheduled', sessionId, now);
  }

  getRun(runId: string): AutomationCronRun | undefined {
    return this.db.prepare('SELECT * FROM automation_cron_runs WHERE id = ?').get(runId) as AutomationCronRun | undefined;
  }

  loadEnabledCrons(): AutomationCron[] {
    return this.db.prepare('SELECT * FROM automation_crons WHERE status = ?').all('enabled') as AutomationCron[];
  }

  updateNextRunAt(id: string, nextRunAt: number | null): void {
    this.db.prepare('UPDATE automation_crons SET next_run_at = ?, updated_at = ? WHERE id = ?').run(nextRunAt, Date.now(), id);
  }

  cleanupOldRuns(): { deletedCount: number } {
    const crons = this.db.prepare('SELECT id FROM automation_crons').all() as { id: string }[];
    let totalDeleted = 0;

    for (const cron of crons) {
      const row = this.db.prepare(
        'SELECT id FROM automation_cron_runs WHERE cron_id = ? ORDER BY created_at DESC LIMIT 1 OFFSET ?'
      ).get(cron.id, MAX_RUNS_PER_CRON) as { id: string } | undefined;

      if (row) {
        const result = this.db.prepare(
          'DELETE FROM automation_cron_runs WHERE cron_id = ? AND created_at <= (SELECT created_at FROM automation_cron_runs WHERE id = ?) AND id != ?'
        ).run(cron.id, row.id, row.id);
        totalDeleted += result.changes;
      }
    }

    return { deletedCount: totalDeleted };
  }
}
