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
 *
 * Dedupe contract: `createCron` is idempotent on `(name, schedule fingerprint,
 * normalized workingDirectory)` — re-submitting the same job returns the existing
 * row instead of appending a duplicate. `dedupeCrons` collapses legacy duplicates
 * that pre-date this guarantee, keeping the oldest row by `created_at`.
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
import {
  assertValidSchedule,
  computeNextRunAt,
  formatEveryDuration,
  parseEveryDuration,
} from './schedule.js';
import { resolveAutomationWorkspace } from './workspace.js';

const DEFAULT_MAX_RETRIES = 3;

/**
 * Stable string key for a `CronSchedule`. Normalizes wire-side variants
 * (everyMs vs every, cronExpr vs expr, ms vs "5m") so logically identical
 * schedules collide even when written through different code paths. Used by
 * `createCron` and `dedupeCrons` as the schedule half of the dedupe key.
 */
export function scheduleFingerprint(schedule: CronSchedule): string {
  assertValidSchedule(schedule);
  if (schedule.kind === 'once') {
    const ms = Date.parse(schedule.at);
    return `once:${Number.isFinite(ms) ? new Date(ms).toISOString() : schedule.at}`;
  }
  if (schedule.kind === 'every') {
    try {
      return `every:${formatEveryDuration(parseEveryDuration(schedule.every))}`;
    } catch {
      return `every:${schedule.every}`;
    }
  }
  // cron
  return `cron:${(schedule.expr ?? '').trim()}|${(schedule.tz ?? '').trim()}`;
}

/**
 * `cron` schedules need a pre-creation anchor for `computeNextRunAt`,
 * because croner's `nextRun` is strictly-after its argument and
 * `every`/`once` already produce sensible first-run results when anchored
 * on `now`. See the comment in `jobToCron` for the full rationale.
 */
function scheduleNeedsCreatedAtAnchor(schedule: CronSchedule): boolean {
  return schedule.kind === 'cron';
}

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
    const name = input.name.trim();
    const prompt = input.prompt.trim();
    const workingDirectory = resolveAutomationWorkspace(input.workingDirectory);
    const fingerprint = scheduleFingerprint(input.schedule);

    // Idempotency: a create request that matches an existing job on
    // (name, schedule, workingDirectory) returns the existing row. This
    // makes repeated "create in chat" / agent-tool calls collapse into a
    // single job instead of stacking duplicates in cronjob.toml.
    const existing = this.doc.jobs.find(
      (j) =>
        j.name === name &&
        resolveAutomationWorkspace(j.working_directory) === workingDirectory &&
        scheduleFingerprint(j.schedule) === fingerprint,
    );
    if (existing) {
      // Bump `updated_at` so a repeated "create" still surfaces as the
      // freshest row in `listCrons` — mirrors the UX of an actual insert
      // and keeps call sites that read `listCrons()[0]` consistent.
      existing.updated_at = Date.now();
      this.save();
      return this.jobToCron(existing);
    }

    const now = Date.now();
    const job: CronJobFile = {
      id: randomUUID(),
      name,
      prompt,
      enabled: input.enabled !== false,
      schedule: input.schedule,
      working_directory: workingDirectory,
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

  /**
   * Collapse legacy duplicates: group jobs by (name, schedule fingerprint,
   * normalized workingDirectory), keep the oldest job in each group, drop
   * the rest. Returns the ids that were removed so callers can audit-log
   * the cleanup. Runtime state (last_run_at / last_error / retry_count)
   * stays on the kept row; drops only discard the redundant row entries.
   */
  dedupeCrons(): { removedIds: string[]; kept: number } {
    const groups = new Map<string, CronJobFile[]>();
    for (const job of this.doc.jobs) {
      const key =
        job.name +
        '\u0001' +
        scheduleFingerprint(job.schedule) +
        '\u0001' +
        resolveAutomationWorkspace(job.working_directory);
      const list = groups.get(key);
      if (list) list.push(job);
      else groups.set(key, [job]);
    }
    const removedIds: string[] = [];
    let kept = 0;
    const next: CronJobFile[] = [];
    for (const list of groups.values()) {
      list.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
      const [keeper, ...dupes] = list;
      next.push(keeper);
      kept += 1;
      for (const d of dupes) {
        if (d.id) removedIds.push(d.id);
      }
    }
    if (removedIds.length === 0) {
      return { removedIds, kept };
    }
    this.doc.jobs = next;
    this.save();
    return { removedIds, kept };
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
    // Anchor `cron` schedules on `created_at` for jobs that have never run.
    // croner.nextRun is strictly-after its argument, so anchoring on `now`
    // would always return a future time and the tick filter
    // `nextRunAt <= now` could never match — making daily/hourly cron
    // jobs silently never fire (the first fire would always be the next
    // scheduled minute after creation, which 60s ticks usually skip past).
    // Using `created_at` puts the anchor BEFORE the first scheduled
    // occurrence, so the very next tick on or after that occurrence fires
    // the job. `every` schedules use `now` as the first-run anchor — they
    // already work because `every` nextRunAt = anchor + everyMs is in the
    // near future, not strictly-after the anchor.
    const nextRunAnchor =
      lastRunAt > 0 ? lastRunAt : scheduleNeedsCreatedAtAnchor(job.schedule) ? (job.created_at ?? now) : now;
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
      nextRunAt: computeNextRunAt(job.schedule, nextRunAnchor, now),
      createdAt: job.created_at ?? now,
      updatedAt: job.updated_at ?? now,
    };
  }
}
