import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { getAgentProcessPool } from '../agents/process-pool/agent-process-pool.js';
import { getConfigManager, toLLMProvider } from '../config/manager.js';
import { getLogger, LogComponent } from '../logging/logger.js';
import { CronPersistence, computeNextRunAtMs, rowToSchedule } from './persistence.js';
import type { AutomationCron, AutomationCronRun } from './types.js';
import { prepareAutomationWorkspace } from './workspace.js';

export { computeNextRunAtMs } from './persistence.js';

const RUN_TIMEOUT_MS = 10 * 60_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

type RunningExecution = { runId: string; sessionId: string; startedAt: number };

export class AutomationScheduler {
  private persistence: CronPersistence;
  private timers = new Map<string, NodeJS.Timeout>();
  private running = new Map<string, RunningExecution[]>();
  private queued = new Map<string, number>();
  private started = false;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(db: Database.Database) {
    this.persistence = new CronPersistence(db);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const cron of this.persistence.loadEnabledCrons()) this.reschedule(cron);

    this.cleanupInterval = setInterval(() => {
      try {
        const result = this.persistence.cleanupOldRuns();
        if (result.deletedCount > 0) {
          getLogger().info('Automation run history cleaned up', {
            deletedCount: result.deletedCount,
          }, LogComponent.Automation);
        }
      } catch (error) {
        getLogger().warn('Automation run-history cleanup failed', {
          error: error instanceof Error ? error.message : String(error),
        }, LogComponent.Automation);
      }
    }, 12 * 60 * 60 * 1000); // every 12 hours
  }

  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear(); this.running.clear(); this.queued.clear(); this.started = false;
  }

  listCrons(): AutomationCron[] { return this.persistence.listCrons(); }
  listCronRuns(input: import('./types.js').ListCronRunsInput): AutomationCronRun[] { return this.persistence.listCronRuns(input); }

  createCron(input: import('./types.js').CreateAutomationCronInput): AutomationCron {
    const cron = this.persistence.createCron(input);
    this.reschedule(cron);
    return cron;
  }

  updateCron(id: string, patch: import('./types.js').UpdateAutomationCronInput): AutomationCron {
    const cron = this.persistence.updateCron(id, patch);
    this.reschedule(cron);
    return cron;
  }

  deleteCron(id: string): { success: boolean } {
    this.unschedule(id);
    this.running.delete(id);
    this.queued.delete(id);
    return this.persistence.deleteCron(id);
  }

  async runCronNow(id: string): Promise<AutomationCronRun> {
    const cron = this.persistence.getCron(id);
    if (!cron) throw new Error(`cron not found: ${id}`);
    const runId = await this.executeCron(cron, true);
    const run = this.persistence.getRun(runId);
    if (!run) throw new Error('run not found');
    return run;
  }

  private reschedule(cron: AutomationCron): void {
    this.unschedule(cron.id);
    if (cron.status !== 'enabled') return;
    try {
      const schedule = rowToSchedule(cron);
      const nextRunAt = computeNextRunAtMs(schedule, Date.now());
      this.persistence.updateNextRunAt(cron.id, nextRunAt);
      if (!nextRunAt) {
        if (schedule.kind === 'at' || schedule.endAt) this.persistence.disableExhaustedCron(cron.id);
        return;
      }
      this.armTimer(cron.id, nextRunAt);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.persistence.markScheduleError(cron.id, reason);
      getLogger().error('Failed to schedule automation', error instanceof Error ? error : new Error(reason), {
        cronId: cron.id,
      }, LogComponent.Automation);
    }
  }

  private armTimer(cronId: string, nextRunAt: number): void {
    const remaining = Math.max(0, nextRunAt - Date.now());
    const delay = Math.min(remaining, MAX_TIMER_DELAY_MS);
    this.timers.set(cronId, setTimeout(() => {
      this.timers.delete(cronId);
      if (nextRunAt - Date.now() > 500) {
        this.armTimer(cronId, nextRunAt);
        return;
      }
      void this.onCronTimer(cronId).catch((error) => {
        getLogger().error('Automation timer execution failed', error instanceof Error ? error : new Error(String(error)), {
          cronId,
        }, LogComponent.Automation);
      });
    }, delay));
  }

  private unschedule(id: string): void {
    const t = this.timers.get(id);
    if (t) { clearTimeout(t); this.timers.delete(id); }
  }

  private async onCronTimer(cronId: string): Promise<void> {
    this.timers.delete(cronId);
    const cron = this.persistence.getCron(cronId);
    if (!cron || cron.status !== 'enabled') return;
    await this.executeCron(cron, false);
    const latest = this.persistence.getCron(cronId);
    if (latest) this.reschedule(latest);
  }

  private async executeCron(cron: AutomationCron, manual: boolean): Promise<string> {
    const pool = getAgentProcessPool();
    const policy = cron.concurrency_policy;
    const runningList = this.running.get(cron.id) ?? [];

    if (runningList.length > 0) {
      if (policy === 'skip') return this.persistence.insertRun(cron.id, 'skipped-by-concurrency');
      if (policy === 'queue') { const c = this.queued.get(cron.id) ?? 0; this.queued.set(cron.id, c + 1); return this.persistence.insertRun(cron.id, 'queued'); }
      if (policy === 'replace') for (const exec of runningList) pool.release(exec.sessionId);
    }

    const runId = randomUUID();
    const now = Date.now();
    const sessionId = `cron:${cron.id}:${now}:${runId}`;
    this.persistence.beginRun(runId, cron.id, sessionId, manual);

    const exec: RunningExecution = { runId, sessionId, startedAt: now };
    this.running.set(cron.id, [...runningList, exec]);

    try {
      const output = await this.runInSession(cron, sessionId);
      this.persistence.finishRunSuccess(cron.id, runId, output);
      return runId;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const { shouldRetry, retryDelay } = this.persistence.finishRunFailure(cron, runId, reason);
      if (shouldRetry) {
        setTimeout(() => { const c = this.persistence.getCron(cron.id); if (c?.status === 'enabled') void this.executeCron(c, false); }, retryDelay);
      }
      return runId;
    } finally {
      this.running.set(cron.id, (this.running.get(cron.id) ?? []).filter(i => i.runId !== runId));
      pool.release(sessionId);
      const q = this.queued.get(cron.id) ?? 0;
      if (q > 0) {
        this.queued.set(cron.id, q - 1);
        const c = this.persistence.getCron(cron.id);
        if (c?.status === 'enabled') void this.executeCron(c, false);
      }
    }
  }

  private async runInSession(cron: AutomationCron, sessionId: string): Promise<string> {
    const pool = getAgentProcessPool();
    const activeProvider = getConfigManager().getActiveProvider();
    if (!activeProvider) throw new Error('no active provider configured');
    const model = cron.model?.trim();
    if (!model) throw new Error('cron model is not configured');

    // Older cron rows did not retain their project path. Never initialise an
    // agent with an empty cwd: it can stall project discovery before `ready`.
    const workingDirectory = prepareAutomationWorkspace(cron.working_directory);
    this.persistence.insertChatSession(
      sessionId,
      `[Cron] ${cron.name}`,
      model,
      activeProvider.id,
      workingDirectory,
    );
    await pool.acquire(sessionId);
    // Subscribe before sending init. A fast child can otherwise emit `ready`
    // between send() and waitForReady(), turning a healthy start into 30s timeout.
    const ready = pool.waitForReady(sessionId);
    const initSent = pool.send(sessionId, {
      type: 'init', sessionId,
      providerConfig: { apiKey: activeProvider.apiKey, baseURL: activeProvider.baseUrl, model, provider: toLLMProvider(activeProvider.providerType), authStyle: 'api_key' },
      workingDirectory, systemPrompt: '',
    });
    if (!initSent) {
      void ready.catch(() => undefined);
      throw new Error(`Agent process ${sessionId} stopped before initialization`);
    }
    await ready;

    return await new Promise<string>((resolve, reject) => {
      const chunks: string[] = [];
      const startedAt = Date.now();
      const timeout = setTimeout(() => { pool.removeMessageHandler(sessionId); reject(new Error('cron run timeout')); }, RUN_TIMEOUT_MS);
      pool.onMessage(sessionId, (msg) => {
        const m = msg as Record<string, unknown>;
        if (m.type === 'chat:text' && typeof m.content === 'string') { chunks.push(m.content); return; }
        if (m.type === 'chat:error') { clearTimeout(timeout); pool.removeMessageHandler(sessionId); reject(new Error(typeof m.message === 'string' ? m.message : 'chat error')); return; }
        if (m.type === 'chat:done') { clearTimeout(timeout); pool.removeMessageHandler(sessionId); resolve(chunks.join('').trim() || `completed in ${Date.now() - startedAt}ms`); }
      });
      // Pass agentProfileId: 'cron' so the cron profile (deny list:
      // AskUserQuestion/show_widget/Agent/canvas:*/mode-switch/worktree)
      // is applied. Without this, options: undefined caused the agent to
      // fall back to the general-purpose profile with ALL tools, including
      // interactive ones that would hang forever in a headless cron run.
      const chatSent = pool.send(sessionId, { type: 'chat:start', id: randomUUID(), sessionId, prompt: cron.prompt, options: { agentProfileId: 'cron' } });
      if (!chatSent) {
        clearTimeout(timeout);
        pool.removeMessageHandler(sessionId);
        reject(new Error(`Agent process ${sessionId} stopped before the cron prompt was sent`));
      }
    });
  }
}

let instance: AutomationScheduler | null = null;

export function initAutomationScheduler(db: Database.Database): AutomationScheduler {
  if (!instance) { instance = new AutomationScheduler(db); instance.start(); }
  return instance;
}

export function getAutomationScheduler(): AutomationScheduler | null {
  return instance;
}

export function resetAutomationSchedulerForTests(): void {
  instance?.shutdown();
  instance = null;
}
