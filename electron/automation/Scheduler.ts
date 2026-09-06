/**
 * electron/automation/Scheduler.ts
 *
 * Cron scheduler. A 60-second polling tick re-reads `~/.duya/cronjob.toml`
 * (single source of truth) and fires due jobs. Execution goes through the main
 * agent HTTP channel (see agent-run.ts) — a cron run is an ordinary agent
 * session that a system component kicks off by sending it a prompt.
 *
 * This replaces the old per-job setTimeout chains / process-pool copies.
 * Crash-safety: `next_run_at` is derived on each tick from (schedule,
 * lastRunAt, now), and a due job claims its fire (last_run_at = now) before
 * running, so a crash mid-run never re-fires forever and a restart naturally
 * catches up.
 */

import { randomUUID } from 'crypto';
import { getLogger, LogComponent } from '../logging/logger.js';
import { CronFileStore } from './cron-file.js';
import { computeNextRunAt } from './schedule.js';
import { createCronSessionRow, interruptCronSession, runCronInSession } from './agent-run.js';
import { resolveCronProvider } from './provider.js';
import { prepareAutomationWorkspace } from './workspace.js';
import { getBotSessionId } from '../wake/bot-session-id.js';
import type { AutomationCron, CreateAutomationCronInput, CronRunHandle, UpdateAutomationCronInput } from './types.js';

export { computeNextRunAt } from './schedule.js';

const TICK_INTERVAL_MS = 60_000;
const RETRY_BACKOFF_MS = [30_000, 60_000, 300_000];

export class AutomationScheduler {
  private store: CronFileStore;
  private running = new Map<string, Set<string>>(); // cronId -> sessionIds
  private retryTimers = new Map<string, NodeJS.Timeout>();
  private tickTimer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(store?: CronFileStore) {
    this.store = store ?? new CronFileStore();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    try {
      this.store.load();
    } catch (error) {
      getLogger().error('Failed to load cronjob.toml', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Automation);
    }
    void this.tick().catch((error) => {
      getLogger().error('Cron tick failed', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Automation);
    });
    this.tickTimer = setInterval(() => {
      void this.tick().catch((error) => {
        getLogger().error('Cron tick failed', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Automation);
      });
    }, TICK_INTERVAL_MS);
  }

  shutdown(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
    this.running.clear();
    this.started = false;
  }

  listCrons(): AutomationCron[] {
    return this.store.listCrons();
  }

  getCron(id: string): AutomationCron | null {
    return this.store.getCron(id);
  }

  /** Listener-hub access to the same store (cursors + external-edit reloads). */
  getCronStore(): CronFileStore {
    return this.store;
  }

  createCron(input: CreateAutomationCronInput): AutomationCron {
    return this.store.createCron(input);
  }

  updateCron(id: string, patch: UpdateAutomationCronInput): AutomationCron {
    return this.store.updateCron(id, patch);
  }

  deleteCron(id: string): { success: boolean } {
    const result = this.store.deleteCron(id);
    this.running.delete(id);
    const t = this.retryTimers.get(id);
    if (t) {
      clearTimeout(t);
      this.retryTimers.delete(id);
    }
    return result;
  }

  /**
   * Collapse duplicate jobs in `cronjob.toml` (legacy rows that pre-date
   * the create-side dedupe in `CronFileStore.createCron`). Also clears any
   * in-memory running/retry bookkeeping for the removed ids so the next
   * tick does not try to fire a job that no longer exists.
   */
  dedupeCrons(): { removedIds: string[]; kept: number } {
    const result = this.store.dedupeCrons();
    for (const id of result.removedIds) {
      this.running.delete(id);
      const t = this.retryTimers.get(id);
      if (t) {
        clearTimeout(t);
        this.retryTimers.delete(id);
      }
    }
    return result;
  }

  /**
   * Trigger a cron immediately. Creates the session row eagerly (so the caller
   * can open the run view with a session_id right away) and executes in the
   * background — awaiting completion would block the IPC handler up to the run
   * timeout, leaving the UI stuck on "run now".
   */
  /**
   * P2.3b — enqueue one fire into the bot's resident session. The wake-bus
   * imports are dynamic: the dispatcher chain (session-manager, core-db
   * adapters) is heavy and Scheduler tests must not have to mock it, and
   * this also avoids a Scheduler ↔ wake-dispatcher static import cycle.
   */
  private async enqueueBotFire(
    job: AutomationCron,
    trigger: 'schedule' | 'manual',
  ): Promise<'added' | 'merged' | 'deduped'> {
    const [{ enqueueAutomationWake }, { createBotSessionIfMissing }] = await Promise.all([
      import('../wake/wake-dispatcher.js'),
      import('../wake/agent-dm-dispatcher.js'),
    ]);
    const agentId = job.agent as string;
    const sessionId = getBotSessionId(agentId);
    createBotSessionIfMissing(sessionId, agentId);
    return enqueueAutomationWake({
      jobKey: job.id,
      fireKey: randomUUID(),
      name: job.name,
      targetSessionId: sessionId,
      trigger,
    });
  }

  async runCronNow(id: string): Promise<CronRunHandle> {
    const job = this.store.getCron(id);
    if (!job) throw new Error(`cron not found: ${id}`);
    // P2.3b: agent-bound routines fire into the bot's resident session via
    // the wake bus (background lane). The wake dispatcher resolves the
    // prompt from cronjob.toml at dispatch time; the returned handle points
    // at the bot session so the UI opens the conversation the run lands in.
    if (job.agent) {
      const sessionId = getBotSessionId(job.agent);
      const outcome = await this.enqueueBotFire(job, 'manual');
      getLogger().info('Manual routine fire enqueued for bot', {
        cronId: job.id,
        agent: job.agent,
        sessionId,
        outcome,
      }, LogComponent.Automation);
      return { runId: randomUUID(), sessionId, cronId: job.id };
    }
    const runId = randomUUID();
    const sessionId = `cron:${job.id}:${Date.now()}:${runId}`;

    // Resolve provider + create the session row synchronously so provider
    // errors surface immediately to the caller instead of vanishing into a
    // background failure. runCronInSession reuses the row (idempotent create).
    const { provider, model } = resolveCronProvider(job.model);
    createCronSessionRow({
      sessionId,
      title: `[Cron] ${job.name}`,
      model,
      providerId: provider.id,
      workingDirectory: prepareAutomationWorkspace(job.workingDirectory),
      cronId: job.id,
      prompt: job.prompt,
    });

    void this.executeCron(job, true, { runId, sessionId }).catch((error) => {
      getLogger().error('Manual cron run failed asynchronously', error instanceof Error ? error : new Error(String(error)), {
        cronId: job.id,
        runId,
      }, LogComponent.Automation);
    });
    return { runId, sessionId, cronId: job.id };
  }

  /** One polling pass: fire every enabled job whose next run is due. */
  async tick(): Promise<void> {
    this.store.load();
    const now = Date.now();
    const due = this.store
      .listCrons()
      .filter((j) => j.enabled && j.nextRunAt !== null && j.nextRunAt <= now);
    for (const job of due) {
      void this.executeCron(job, false).catch((error) => {
        getLogger().error('Scheduled cron run failed asynchronously', error instanceof Error ? error : new Error(String(error)), {
          cronId: job.id,
        }, LogComponent.Automation);
      });
    }
  }

  private async executeCron(
    job: AutomationCron,
    manual: boolean,
    existing?: { runId: string; sessionId: string },
  ): Promise<void> {
    // P2.3b: agent-bound routines fire into the bot's resident session
    // (`bot:<agentId>`) through the wake bus instead of a throwaway cron
    // session. Claim the fire first (at-least-once, same as standalone);
    // the wake queue then serialises fires behind user/agent turns. No
    // retry ladder here — the queue owns redrive, and a failed wake run
    // simply waits for the next scheduled fire.
    if (job.agent) {
      this.store.markRunResult(job.id, {
        lastRunAt: Date.now(),
        error: job.lastError,
        retryCount: job.retryCount,
      });
      try {
        const outcome = await this.enqueueBotFire(job, 'schedule');
        getLogger().info('Scheduled routine fire enqueued for bot', {
          cronId: job.id,
          agent: job.agent,
          sessionId: getBotSessionId(job.agent),
          outcome,
        }, LogComponent.Automation);
      } catch (error) {
        getLogger().error('Routine fire: bot wake enqueue failed', error instanceof Error ? error : new Error(String(error)), {
          cronId: job.id,
          agent: job.agent,
        }, LogComponent.Automation);
        this.store.markRunResult(job.id, {
          lastRunAt: Date.now(),
          error: 'bot wake enqueue failed',
          retryCount: job.retryCount,
        });
      }
      return;
    }

    const runningList = this.running.get(job.id);

    // Manually-triggered runs (existing handle) bypass the concurrency policy:
    // the user explicitly asked to run now.
    if (!manual && runningList && runningList.size > 0) {
      if (job.concurrencyPolicy === 'skip') return;
      if (job.concurrencyPolicy === 'replace') {
        for (const sid of runningList) interruptCronSession(sid);
      }
      // 'parallel' → fall through and allow concurrent sessions.
    }

    const runId = existing?.runId ?? randomUUID();
    const sessionId = existing?.sessionId ?? `cron:${job.id}:${Date.now()}:${runId}`;

    // Claim the fire BEFORE executing (at-least-once): advancing last_run_at
    // moves the schedule forward so a crash mid-run does not re-fire forever;
    // the session history is the run record.
    if (!existing) {
      this.store.markRunResult(job.id, {
        lastRunAt: Date.now(),
        error: job.lastError,
        retryCount: job.retryCount,
      });
    }

    const nextRunning = new Set(runningList ?? []);
    nextRunning.add(sessionId);
    this.running.set(job.id, nextRunning);

    try {
      await runCronInSession(job, sessionId);
      this.store.markRunResult(job.id, { lastRunAt: Date.now(), error: null, retryCount: 0 });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const nextRetry = job.retryCount + 1;
      this.store.markRunResult(job.id, { lastRunAt: Date.now(), error: reason, retryCount: nextRetry });
      if (nextRetry < job.maxRetries) {
        const delay = RETRY_BACKOFF_MS[Math.min(job.retryCount, RETRY_BACKOFF_MS.length - 1)];
        this.scheduleRetry(job.id, delay);
      } else {
        // Retries exhausted: pause the job so the UI surfaces last_error instead
        // of it failing forever. (Replaces the old status:'error' override.)
        getLogger().error('Cron run failed after max retries; pausing job', new Error(reason), { cronId: job.id }, LogComponent.Automation);
        this.store.updateCron(job.id, { enabled: false });
      }
    } finally {
      const s = this.running.get(job.id);
      if (s) {
        s.delete(sessionId);
        if (s.size === 0) this.running.delete(job.id);
      }
    }
  }

  private scheduleRetry(cronId: string, delay: number): void {
    const existing = this.retryTimers.get(cronId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.retryTimers.delete(cronId);
      const job = this.store.getCron(cronId);
      if (job?.enabled) {
        void this.executeCron(job, false).catch((error) => {
          getLogger().error('Cron retry failed asynchronously', error instanceof Error ? error : new Error(String(error)), { cronId }, LogComponent.Automation);
        });
      }
    }, delay);
    this.retryTimers.set(cronId, t);
  }
}

let instance: AutomationScheduler | null = null;

export function initAutomationScheduler(): AutomationScheduler {
  if (!instance) {
    instance = new AutomationScheduler();
    instance.start();
  }
  return instance;
}

export function getAutomationScheduler(): AutomationScheduler | null {
  return instance;
}

export function resetAutomationSchedulerForTests(): void {
  instance?.shutdown();
  instance = null;
}
