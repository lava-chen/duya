import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { getAgentProcessPool } from '../agents/process-pool/agent-process-pool.js';
import { getConfigManager, toLLMProvider } from '../config/manager.js';
import { CronPersistence, computeNextRunAtMs, rowToSchedule } from './persistence.js';
import type { AutomationCron, AutomationCronRun } from './types.js';

const RUN_TIMEOUT_MS = 10 * 60_000;

type RunningExecution = { runId: string; sessionId: string; startedAt: number };

export class AutomationScheduler {
  private persistence: CronPersistence;
  private timers = new Map<string, NodeJS.Timeout>();
  private running = new Map<string, RunningExecution[]>();
  private queued = new Map<string, number>();
  private started = false;

  constructor(db: Database.Database) {
    this.persistence = new CronPersistence(db);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const cron of this.persistence.loadEnabledCrons()) this.reschedule(cron);
  }

  shutdown(): void {
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
    const now = Date.now();
    const schedule = rowToSchedule(cron);
    const nextRunAt = computeNextRunAtMs(schedule, now);
    this.persistence.updateNextRunAt(cron.id, nextRunAt);
    if (!nextRunAt) return;
    this.timers.set(cron.id, setTimeout(() => void this.onCronTimer(cron.id), Math.max(0, nextRunAt - now)));
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

    this.persistence.insertChatSession(sessionId, `[Cron] ${cron.name}`, model, activeProvider.id);
    await pool.acquire(sessionId);
    pool.send(sessionId, {
      type: 'init', sessionId,
      providerConfig: { apiKey: activeProvider.apiKey, baseURL: activeProvider.baseUrl, model, provider: toLLMProvider(activeProvider.providerType), authStyle: 'api_key' },
      workingDirectory: '', systemPrompt: '',
    });
    await pool.waitForReady(sessionId);

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
      pool.send(sessionId, { type: 'chat:start', id: randomUUID(), sessionId, prompt: cron.prompt, options: undefined });
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
