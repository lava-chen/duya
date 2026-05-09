import { randomUUID } from 'crypto';
import { Cron } from 'croner';
import type Database from 'better-sqlite3';
import { getAgentProcessPool } from '../agent-process-pool.js';
import { getConfigManager, toLLMProvider } from '../config-manager.js';
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
const RUN_TIMEOUT_MS = 10 * 60_000;

type RunningExecution = {
  runId: string;
  sessionId: string;
  startedAt: number;
};

function normalizeCronStatus(value: string | undefined): CronStatus {
  if (value === 'enabled' || value === 'disabled' || value === 'error') {
    return value;
  }
  return 'enabled';
}

function assertValidSchedule(schedule: CronSchedule): void {
  if (!schedule || typeof schedule !== 'object') {
    throw new Error('schedule is required');
  }
  if (schedule.kind === 'at') {
    if (!schedule.at || Number.isNaN(Date.parse(schedule.at))) {
      throw new Error('schedule.at must be a valid ISO date');
    }
    return;
  }
  if (schedule.kind === 'every') {
    if (!schedule.everyMs || !Number.isFinite(schedule.everyMs) || schedule.everyMs <= 0) {
      throw new Error('schedule.everyMs must be a positive number');
    }
    return;
  }
  if (schedule.kind === 'cron') {
    if (!schedule.cronExpr || !schedule.cronExpr.trim()) {
      throw new Error('schedule.cronExpr is required');
    }
    try {
      new Cron(schedule.cronExpr, { timezone: schedule.cronTz || undefined, catch: false });
    } catch (error) {
      throw new Error(`invalid cron expression: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  throw new Error(`unsupported schedule kind: ${(schedule as { kind?: string }).kind ?? 'unknown'}`);
}

function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | null {
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

function rowToSchedule(row: AutomationCron): CronSchedule {
  if (row.schedule_kind === 'at') {
    return { kind: 'at', at: row.schedule_at || undefined };
  }
  if (row.schedule_kind === 'every') {
    return { kind: 'every', everyMs: row.schedule_every_ms || undefined };
  }
  return {
    kind: 'cron',
    cronExpr: row.schedule_cron_expr || undefined,
    cronTz: row.schedule_cron_tz || undefined,
  };
}

export class AutomationScheduler {
  private readonly db: Database.Database;
  private timers = new Map<string, NodeJS.Timeout>();
  private running = new Map<string, RunningExecution[]>();
  private queued = new Map<string, number>();
  private started = false;

  constructor(db: Database.Database) {
    this.db = db;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.loadEnabledCrons();
  }

  shutdown(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.running.clear();
    this.queued.clear();
    this.started = false;
  }

  listCrons(): AutomationCron[] {
    return this.db
      .prepare('SELECT * FROM automation_crons ORDER BY updated_at DESC')
      .all() as AutomationCron[];
  }

  listCronRuns(input: ListCronRunsInput): AutomationCronRun[] {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 200);
    const offset = Math.max(input.offset ?? 0, 0);
    return this.db
      .prepare(`
        SELECT * FROM automation_cron_runs
        WHERE cron_id = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `)
      .all(input.cronId, limit, offset) as AutomationCronRun[];
  }

  createCron(input: CreateAutomationCronInput): AutomationCron {
    assertValidSchedule(input.schedule);
    if (!input.prompt || !input.prompt.trim()) {
      throw new Error('prompt is required');
    }
    if (!input.model || !input.model.trim()) {
      throw new Error('model is required');
    }

    const now = Date.now();
    const id = randomUUID();
    const status: CronStatus = input.enabled === false ? 'disabled' : 'enabled';
    const nextRunAt = status === 'enabled' ? computeNextRunAtMs(input.schedule, now) : null;
    const maxRetries = input.maxRetries ?? DEFAULT_MAX_RETRIES;
    const concurrencyPolicy: ConcurrencyPolicy = input.concurrencyPolicy ?? 'skip';

    this.db.prepare(`
      INSERT INTO automation_crons (
        id, name, description, schedule_kind, schedule_at, schedule_every_ms, schedule_cron_expr, schedule_cron_tz,
        workflow_id, prompt, input_params, session_target, delivery_mode, status, model, last_run_at, next_run_at, last_error,
        retry_count, concurrency_policy, max_retries, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'isolated', 'none', ?, ?, NULL, ?, NULL, 0, ?, ?, ?, ?)
    `).run(
      id,
      input.name,
      input.description ?? null,
      input.schedule.kind,
      input.schedule.kind === 'at' ? input.schedule.at ?? null : null,
      input.schedule.kind === 'every' ? input.schedule.everyMs ?? null : null,
      input.schedule.kind === 'cron' ? input.schedule.cronExpr ?? null : null,
      input.schedule.kind === 'cron' ? input.schedule.cronTz ?? null : null,
      null,
      input.prompt.trim(),
      JSON.stringify(input.inputParams ?? {}),
      status,
      input.model.trim(),
      nextRunAt,
      concurrencyPolicy,
      maxRetries,
      now,
      now,
    );

    const created = this.getCron(id);
    if (!created) {
      throw new Error('failed to create cron');
    }
    this.reschedule(created);
    return created;
  }

  updateCron(id: string, patch: UpdateAutomationCronInput): AutomationCron {
    const current = this.getCron(id);
    if (!current) {
      throw new Error(`cron not found: ${id}`);
    }

    const now = Date.now();
    const mergedSchedule: CronSchedule = patch.schedule ? patch.schedule : rowToSchedule(current);
    assertValidSchedule(mergedSchedule);

    const nextStatus = patch.status ? normalizeCronStatus(patch.status) : current.status;
    const shouldRecomputeNext = patch.schedule || patch.status !== undefined;
    const nextRunAt = shouldRecomputeNext && nextStatus === 'enabled'
      ? computeNextRunAtMs(mergedSchedule, now)
      : current.next_run_at;

    this.db.prepare(`
      UPDATE automation_crons SET
        name = ?,
        description = ?,
        schedule_kind = ?,
        schedule_at = ?,
        schedule_every_ms = ?,
        schedule_cron_expr = ?,
        schedule_cron_tz = ?,
        prompt = ?,
        input_params = ?,
        status = ?,
        model = ?,
        next_run_at = ?,
        concurrency_policy = ?,
        max_retries = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      patch.name ?? current.name,
      patch.description !== undefined ? patch.description : current.description,
      mergedSchedule.kind,
      mergedSchedule.kind === 'at' ? mergedSchedule.at ?? null : null,
      mergedSchedule.kind === 'every' ? mergedSchedule.everyMs ?? null : null,
      mergedSchedule.kind === 'cron' ? mergedSchedule.cronExpr ?? null : null,
      mergedSchedule.kind === 'cron' ? mergedSchedule.cronTz ?? null : null,
      patch.prompt !== undefined ? patch.prompt.trim() : current.prompt,
      patch.inputParams !== undefined ? JSON.stringify(patch.inputParams) : current.input_params,
      nextStatus,
      patch.model !== undefined ? patch.model.trim() : current.model,
      nextRunAt,
      patch.concurrencyPolicy ?? current.concurrency_policy,
      patch.maxRetries ?? current.max_retries,
      now,
      id,
    );

    const updated = this.getCron(id);
    if (!updated) {
      throw new Error('failed to load updated cron');
    }
    this.reschedule(updated);
    return updated;
  }

  deleteCron(id: string): { success: boolean } {
    this.unschedule(id);
    this.running.delete(id);
    this.queued.delete(id);
    const result = this.db.prepare('DELETE FROM automation_crons WHERE id = ?').run(id);
    return { success: result.changes > 0 };
  }

  async runCronNow(id: string): Promise<AutomationCronRun> {
    const cron = this.getCron(id);
    if (!cron) {
      throw new Error(`cron not found: ${id}`);
    }
    const runId = await this.executeCron(cron, true);
    const run = this.db.prepare('SELECT * FROM automation_cron_runs WHERE id = ?').get(runId) as AutomationCronRun | undefined;
    if (!run) throw new Error('run not found');
    return run;
  }

  private getCron(id: string): AutomationCron | null {
    const row = this.db.prepare('SELECT * FROM automation_crons WHERE id = ?').get(id) as AutomationCron | undefined;
    return row ?? null;
  }

  private loadEnabledCrons(): void {
    const rows = this.db
      .prepare('SELECT * FROM automation_crons WHERE status = ?')
      .all('enabled') as AutomationCron[];
    for (const row of rows) {
      this.reschedule(row);
    }
  }

  private reschedule(cron: AutomationCron): void {
    this.unschedule(cron.id);
    if (cron.status !== 'enabled') return;

    const now = Date.now();
    const schedule = rowToSchedule(cron);
    const nextRunAt = computeNextRunAtMs(schedule, now);
    this.db.prepare('UPDATE automation_crons SET next_run_at = ?, updated_at = ? WHERE id = ?').run(nextRunAt, now, cron.id);
    if (!nextRunAt) {
      return;
    }

    const delayMs = Math.max(0, nextRunAt - now);
    const timer = setTimeout(() => {
      void this.onCronTimer(cron.id);
    }, delayMs);
    this.timers.set(cron.id, timer);
  }

  private unschedule(cronId: string): void {
    const timer = this.timers.get(cronId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(cronId);
    }
  }

  private async onCronTimer(cronId: string): Promise<void> {
    this.timers.delete(cronId);
    const cron = this.getCron(cronId);
    if (!cron || cron.status !== 'enabled') {
      return;
    }

    await this.executeCron(cron, false);
    const latest = this.getCron(cronId);
    if (latest) {
      this.reschedule(latest);
    }
  }

  private async executeCron(cron: AutomationCron, manual: boolean): Promise<string> {
    const policy = cron.concurrency_policy;
    const runningList = this.running.get(cron.id) ?? [];
    const hasRunning = runningList.length > 0;

    if (hasRunning) {
      if (policy === 'skip') {
        const runId = this.insertRun(cron.id, 'skipped-by-concurrency');
        return runId;
      }
      if (policy === 'queue') {
        const queuedCount = this.queued.get(cron.id) ?? 0;
        this.queued.set(cron.id, queuedCount + 1);
        const runId = this.insertRun(cron.id, 'queued');
        return runId;
      }
      if (policy === 'replace') {
        for (const execution of runningList) {
          getAgentProcessPool().release(execution.sessionId);
        }
      }
    }

    const runId = randomUUID();
    const now = Date.now();
    const sessionId = `cron:${cron.id}:${now}:${runId}`;

    this.db.prepare(`
      INSERT INTO automation_cron_runs (id, cron_id, run_status, started_at, ended_at, output, error_message, logs, session_id, created_at)
      VALUES (?, ?, 'running', ?, NULL, NULL, NULL, ?, ?, ?)
    `).run(runId, cron.id, now, manual ? 'manual-trigger' : 'scheduled', sessionId, now);
    const execution: RunningExecution = { runId, sessionId, startedAt: now };
    this.running.set(cron.id, [...runningList, execution]);

    try {
      const output = await this.runCronInSession(cron, sessionId);
      this.finishRunSuccess(cron.id, runId, output);
      return runId;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.finishRunFailure(cron, runId, reason);
      return runId;
    } finally {
      const currentList = this.running.get(cron.id) ?? [];
      this.running.set(
        cron.id,
        currentList.filter((item) => item.runId !== runId),
      );
      getAgentProcessPool().release(sessionId);
      const queuedCount = this.queued.get(cron.id) ?? 0;
      if (queuedCount > 0) {
        this.queued.set(cron.id, queuedCount - 1);
        const latest = this.getCron(cron.id);
        if (latest && latest.status === 'enabled') {
          void this.executeCron(latest, false);
        }
      }
    }
  }

  private insertRun(cronId: string, reason: string): string {
    const runId = randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO automation_cron_runs (id, cron_id, run_status, started_at, ended_at, output, error_message, logs, created_at)
      VALUES (?, ?, 'cancelled', ?, ?, NULL, ?, ?, ?)
    `).run(runId, cronId, now, now, reason, reason, now);
    return runId;
  }

  private async runCronInSession(cron: AutomationCron, sessionId: string): Promise<string> {
    const pool = getAgentProcessPool();
    const configManager = getConfigManager();
    const activeProvider = configManager.getActiveProvider();
    if (!activeProvider) {
      throw new Error('no active provider configured');
    }

    const now = Date.now();
    const cronModel = cron.model?.trim();
    if (!cronModel) {
      throw new Error('cron model is not configured');
    }
    this.db.prepare(`
      INSERT INTO chat_sessions (
        id, title, created_at, updated_at, model, system_prompt, working_directory, project_name,
        status, mode, permission_profile, provider_id, context_summary, context_summary_updated_at,
        is_deleted, generation
      ) VALUES (?, ?, ?, ?, ?, '', '', '', 'active', 'automation', 'default', ?, '', 0, 0, 0)
    `).run(
      sessionId,
      `[Cron] ${cron.name}`,
      now,
      now,
      cronModel,
      activeProvider.id,
    );

    await pool.acquire(sessionId);
    pool.send(sessionId, {
      type: 'init',
      sessionId,
      providerConfig: {
        apiKey: activeProvider.apiKey,
        baseURL: activeProvider.baseUrl,
        model: cronModel,
        provider: toLLMProvider(activeProvider.providerType),
        authStyle: 'api_key',
      },
      workingDirectory: '',
      systemPrompt: '',
    });
    await pool.waitForReady(sessionId);

    return await new Promise<string>((resolve, reject) => {
      const startedAt = Date.now();
      const outputChunks: string[] = [];
      const timeout = setTimeout(() => {
        pool.removeMessageHandler(sessionId);
        reject(new Error('cron run timeout'));
      }, RUN_TIMEOUT_MS);

      pool.onMessage(sessionId, (message) => {
        if (message.type === 'chat:text' && typeof message.content === 'string') {
          outputChunks.push(message.content);
          return;
        }
        if (message.type === 'chat:error') {
          clearTimeout(timeout);
          pool.removeMessageHandler(sessionId);
          const msg = typeof message.message === 'string' ? message.message : 'chat error';
          reject(new Error(msg));
          return;
        }
        if (message.type === 'chat:done') {
          clearTimeout(timeout);
          pool.removeMessageHandler(sessionId);
          const output = outputChunks.join('').trim();
          const elapsed = Date.now() - startedAt;
          resolve(output || `run completed in ${elapsed}ms`);
        }
      });

      pool.send(sessionId, {
        type: 'chat:start',
        id: randomUUID(),
        sessionId,
        prompt: cron.prompt,
        options: undefined,
      });
    });
  }

  private finishRunSuccess(cronId: string, runId: string, output: string): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE automation_cron_runs
      SET run_status = 'success', ended_at = ?, output = ?, error_message = NULL
      WHERE id = ?
    `).run(now, output, runId);

    this.db.prepare(`
      UPDATE automation_crons
      SET last_run_at = ?, last_error = NULL, retry_count = 0, updated_at = ?
      WHERE id = ?
    `).run(now, now, cronId);
  }

  private async finishRunFailure(cron: AutomationCron, runId: string, reason: string): Promise<void> {
    const now = Date.now();
    const shouldRetry = cron.retry_count < cron.max_retries;

    this.db.prepare(`
      UPDATE automation_cron_runs
      SET run_status = 'failed', ended_at = ?, error_message = ?, logs = ?
      WHERE id = ?
    `).run(now, reason, reason, runId);

    const nextRetryCount = cron.retry_count + 1;
    this.db.prepare(`
      UPDATE automation_crons
      SET last_error = ?, retry_count = ?, updated_at = ?, status = ?
      WHERE id = ?
    `).run(reason, nextRetryCount, now, shouldRetry ? cron.status : 'error', cron.id);

    if (shouldRetry) {
      const retryDelay = RETRY_BACKOFF_MS[Math.min(cron.retry_count, RETRY_BACKOFF_MS.length - 1)];
      setTimeout(() => {
        const latest = this.getCron(cron.id);
        if (latest && latest.status === 'enabled') {
          void this.executeCron(latest, false);
        }
      }, retryDelay);
    }
  }
}

let scheduler: AutomationScheduler | null = null;

export function initAutomationScheduler(db: Database.Database): AutomationScheduler {
  if (scheduler) {
    return scheduler;
  }
  scheduler = new AutomationScheduler(db);
  scheduler.start();
  return scheduler;
}

export function getAutomationScheduler(): AutomationScheduler | null {
  return scheduler;
}

export { computeNextRunAtMs };
