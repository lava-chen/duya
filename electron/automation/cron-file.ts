/**
 * electron/automation/cron-file.ts
 *
 * `CronFileStore` — the single source of truth for cron jobs: `~/.duya/cronjob.toml`.
 * Holds job definitions AND runtime state (last_run_at / last_error / retry_count)
 * written back on every run. `next_run_at` is never persisted — it is derived on
 * read from (schedule, lastRunAt, now) via `schedule.ts`.
 *
 * On-disk shape is snake_case (plain, hand-editable TOML); the public API is the
 * camelCase `AutomationCron` type. Persistence mirrors `ConfigStore`:
 * `@iarna/toml` stringify + `write-file-atomic` (mode 0o600).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from '@iarna/toml';
import writeFileAtomic from 'write-file-atomic';
import { resolveConfigRoot } from '../config/compass';
import type {
  AutomationCron,
  ConcurrencyPolicy,
  CreateAutomationCronInput,
  CronSchedule,
  UpdateAutomationCronInput,
} from './types.js';
import { assertValidSchedule, computeNextRunAt } from './schedule.js';
import { resolveAutomationWorkspace } from './workspace.js';

const DEFAULT_MAX_RETRIES = 3;

/** On-disk TOML shape (snake_case); the public API is camelCase `AutomationCron`. */
export interface CronJobFile {
  id?: string;
  name: string;
  prompt: string;
  enabled: boolean;
  schedule: CronSchedule;
  working_directory?: string;
  model?: string;
  concurrency?: ConcurrencyPolicy;
  max_retries?: number;
  last_run_at?: number;
  last_error?: string | null;
  retry_count?: number;
  created_at?: number;
  updated_at?: number;
}

export interface CronJobFileDoc {
  version: number;
  jobs: CronJobFile[];
}

export function defaultCronFilePath(): string {
  return path.join(resolveConfigRoot(), 'cronjob.toml');
}

/** Parse + validate a cronjob.toml document. Throws on malformed input. */
export function parseCronJobFile(text: string): CronJobFileDoc {
  const doc = parse(text) as Partial<CronJobFileDoc>;
  if (doc.version !== 1) {
    throw new Error(`unsupported cronjob.toml version: ${JSON.stringify(doc.version)}`);
  }
  if (!Array.isArray(doc.jobs)) {
    throw new Error('cronjob.toml is missing the jobs array');
  }
  const jobs: CronJobFile[] = [];
  for (const raw of doc.jobs) {
    if (!raw || typeof raw !== 'object') throw new Error('invalid job entry in cronjob.toml');
    const job = raw as CronJobFile;
    if (typeof job.name !== 'string' || !job.name.trim()) throw new Error('job.name is required');
    if (typeof job.prompt !== 'string' || !job.prompt.trim()) throw new Error('job.prompt is required');
    assertValidSchedule(job.schedule);
    jobs.push(job);
  }
  return { version: 1, jobs };
}

export class CronFileStore {
  private readonly filePath: string;
  private doc: CronJobFileDoc = { version: 1, jobs: [] };

  constructor(filePath?: string) {
    this.filePath = filePath ?? defaultCronFilePath();
    this.load();
  }

  get path(): string {
    return this.filePath;
  }

  /** Re-read the file (crash-safe: external edits and a crash mid-write self-heal). */
  load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.doc = { version: 1, jobs: [] };
      return;
    }
    const raw = fs.readFileSync(this.filePath, 'utf-8');
    this.doc = parseCronJobFile(raw);
    // Hand-written jobs may omit `id`; assign one and persist so later
    // lookups/updates have a stable key.
    let missingId = false;
    for (const job of this.doc.jobs) {
      if (!job.id) {
        job.id = randomUUID();
        missingId = true;
      }
    }
    if (missingId) this.save();
  }

  /** Atomic write of the in-memory document. */
  save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic.sync(
      this.filePath,
      stringify(this.doc as unknown as Parameters<typeof stringify>[0]),
      { mode: 0o600 },
    );
  }

  // ==== public API ====

  getCron(id: string): AutomationCron | null {
    const job = this.doc.jobs.find((j) => j.id === id);
    return job ? this.jobToCron(job) : null;
  }

  listCrons(): AutomationCron[] {
    return this.doc.jobs
      .map((j) => this.jobToCron(j))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  createCron(input: CreateAutomationCronInput): AutomationCron {
    assertValidSchedule(input.schedule);
    if (!input.name?.trim()) {
      throw new Error(`name is required; got: ${JSON.stringify(input.name)}`);
    }
    if (!input.prompt?.trim()) {
      throw new Error(
        `prompt is required (the natural-language instruction the scheduled run will execute); got: ${JSON.stringify(input.prompt)}`,
      );
    }
    const now = Date.now();
    const job: CronJobFile = {
      id: randomUUID(),
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      enabled: input.enabled !== false,
      schedule: input.schedule,
      working_directory: resolveAutomationWorkspace(input.workingDirectory),
      model: input.model?.trim() || undefined,
      concurrency: input.concurrencyPolicy ?? 'skip',
      max_retries: input.maxRetries ?? DEFAULT_MAX_RETRIES,
      last_run_at: 0,
      last_error: null,
      retry_count: 0,
      created_at: now,
      updated_at: now,
    };
    this.doc.jobs.push(job);
    this.save();
    return this.jobToCron(job);
  }

  updateCron(id: string, patch: UpdateAutomationCronInput): AutomationCron {
    const job = this.doc.jobs.find((j) => j.id === id);
    if (!job) throw new Error(`cron not found: ${id}`);
    const mergedSchedule = patch.schedule ?? job.schedule;
    assertValidSchedule(mergedSchedule);
    if (patch.name !== undefined && !patch.name.trim()) throw new Error('name cannot be empty');
    if (patch.prompt !== undefined && !patch.prompt.trim()) {
      throw new Error('prompt cannot be empty');
    }
    if (patch.name !== undefined) job.name = patch.name.trim();
    if (patch.prompt !== undefined) job.prompt = patch.prompt.trim();
    if (patch.schedule !== undefined) job.schedule = mergedSchedule;
    if (patch.workingDirectory !== undefined) job.working_directory = resolveAutomationWorkspace(patch.workingDirectory);
    if (patch.model !== undefined) job.model = patch.model.trim() || undefined;
    if (patch.concurrencyPolicy !== undefined) job.concurrency = patch.concurrencyPolicy;
    if (patch.maxRetries !== undefined) job.max_retries = patch.maxRetries;
    if (patch.enabled !== undefined) job.enabled = patch.enabled;
    job.updated_at = Date.now();
    this.save();
    return this.jobToCron(job);
  }

  deleteCron(id: string): { success: boolean } {
    const before = this.doc.jobs.length;
    this.doc.jobs = this.doc.jobs.filter((j) => j.id !== id);
    const success = this.doc.jobs.length !== before;
    if (success) this.save();
    return { success };
  }

  /** Persist a run outcome (last_run_at / last_error / retry_count) and write the file. */
  markRunResult(id: string, result: { lastRunAt: number; error: string | null; retryCount: number }): void {
    const job = this.doc.jobs.find((j) => j.id === id);
    if (!job) return;
    job.last_run_at = result.lastRunAt;
    job.last_error = result.error;
    job.retry_count = result.retryCount;
    job.updated_at = Date.now();
    this.save();
  }

  // ==== internal ====

  private jobToCron(job: CronJobFile): AutomationCron {
    const now = Date.now();
    const lastRunAt = job.last_run_at ?? 0;
    return {
      id: job.id ?? '',
      name: job.name,
      prompt: job.prompt,
      schedule: job.schedule,
      workingDirectory: job.working_directory ?? '',
      model: job.model ?? '',
      enabled: job.enabled !== false,
      concurrencyPolicy: job.concurrency ?? 'skip',
      maxRetries: job.max_retries ?? DEFAULT_MAX_RETRIES,
      lastRunAt: lastRunAt > 0 ? lastRunAt : null,
      lastError: job.last_error ?? null,
      retryCount: job.retry_count ?? 0,
      nextRunAt: computeNextRunAt(job.schedule, lastRunAt, now),
      createdAt: job.created_at ?? now,
      updatedAt: job.updated_at ?? now,
    };
  }
}
