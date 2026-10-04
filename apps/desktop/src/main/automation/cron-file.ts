/**
 * apps/desktop/src/main/automation/cron-file.ts
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
 * Dedupe contract: `createCron` is idempotent on the routine identity key
 * (`cronIdentityKey`: name, schedule fingerprint, normalized workingDirectory,
 * event listeners, bot binding) — re-submitting the same job returns the
 * existing row instead of appending a duplicate. `dedupeCrons` groups by that
 * SAME key, collapsing legacy duplicates that pre-date this guarantee and
 * keeping the oldest row by `created_at`; routines that differ in listeners or
 * bot binding are distinct and are never collapsed.
 *
 * Concurrency: only the policies in `CONCURRENCY_POLICIES` are implemented
 * (`skip` / `parallel` / `replace`). Anything else — including the `queue`
 * value the CLI DTO type still advertises — is rejected on write and coerced
 * to `skip` on read, so an unimplemented mode can never mean "unbounded".
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from '@iarna/toml';
import writeFileAtomic from 'write-file-atomic';
import { resolveConfigRoot } from '../config/compass';
import { getLogger, LogComponent } from '../logging/logger';
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
import { isSafeBotId } from '../config/agent-id';
import { parseEventTriggerList, parseEventTriggerSpec } from './trigger-match.js';
import type { ListenerStateFile, RoutineEventTrigger } from './types.js';

const DEFAULT_MAX_RETRIES = 3;

/** Valid per-cron session permission profiles (plan 574). Unknown values are dropped, not thrown. */
const CRON_PERMISSION_MODES = new Set(['default', 'auto', 'full_access']);
/** Valid per-cron reasoning efforts (plan 574). Unknown values are dropped, not thrown. */
const CRON_EFFORTS = new Set(['off', 'low', 'medium', 'high', 'max']);

function normalizeCronPermissionMode(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && CRON_PERMISSION_MODES.has(value) ? value : undefined;
}

function normalizeCronEffort(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && CRON_EFFORTS.has(value) ? value : undefined;
}

/**
 * Normalize + validate a bot-binding slug (Plan 476 P2.3a). Returns null
 * for absent/empty input; throws on a syntactically invalid slug so a bad
 * binding never reaches cronjob.toml.
 */
function normalizeAgentBinding(agent: string | null | undefined): string | null {
  if (agent === undefined || agent === null) return null;
  const trimmed = agent.trim();
  if (!trimmed) return null;
  if (!isSafeBotId(trimmed)) {
    throw new Error(
      `agent is not a valid agent slug: ${JSON.stringify(agent)} (expected ^[a-z0-9][a-z0-9-]{0,62}$)`,
    );
  }
  return trimmed;
}

/**
 * Optional provider pin for a routine (`model_provider_id`). Unset / blank
 * means "unpinned" and returns null; the run then resolves the default
 * provider. The value is a provider-store id, not a free-form model string,
 * and is only trimmed here — a stale id simply fails to resolve at run time,
 * where `resolveLlmProvider` falls back to the default.
 */
function normalizeModelProviderId(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Stable string key for a `CronSchedule`. Normalizes wire-side variants
 * (everyMs vs every, cronExpr vs expr, ms vs "5m") so logically identical
 * schedules collide even when written through different code paths. Used by
 * `createCron` and `dedupeCrons` as the schedule half of the dedupe key.
 * Null (event-only routine) fingerprints as `none`.
 */
export function scheduleFingerprint(schedule: CronSchedule | null): string {
  if (schedule == null) return 'none';
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
function scheduleNeedsCreatedAtAnchor(schedule: CronSchedule | null | undefined): boolean {
  return schedule?.kind === 'cron';
}

/**
 * Identity of a routine: the ONE key that decides whether two cron rows are
 * the same job. Both `createCron` (idempotency on create) and `dedupeCrons`
 * (collapse legacy duplicates) derive from it, so the two can never disagree
 * — the previous split let `dedupeCrons` collapse two rows that `createCron`
 * deliberately keeps apart.
 *
 * The key covers every field that changes what the routine *is*, not how it
 * runs: name, normalized workspace, schedule fingerprint, event listeners
 * and bot binding. Two routines that differ only in listeners or in the agent
 * they fire into are DIFFERENT routines and must survive `cron dedupe`.
 * Runtime/knob fields (concurrency, retries, enabled, effort, last_run_at)
 * are deliberately excluded: a later re-tune of one row must not make it a
 * different job.
 */
export function cronIdentityKey(job: {
  name?: string;
  schedule?: CronSchedule | null;
  working_directory?: string;
  event_triggers?: RoutineEventTrigger[] | null;
  agent?: string | null;
}): string {
  return [
    job.name ?? '',
    scheduleFingerprint(job.schedule ?? null),
    resolveAutomationWorkspace(job.working_directory ?? ''),
    JSON.stringify(job.event_triggers ?? []),
    (job.agent ?? '').trim(),
  ].join('\u0001');
}

/** Build the same key from a create/update input (already normalized fields). */
function cronIdentityKeyFromInput(input: {
  name: string;
  schedule: CronSchedule | null;
  workingDirectory: string;
  eventTriggers: RoutineEventTrigger[] | null | undefined;
  agent: string | null;
}): string {
  return cronIdentityKey({
    name: input.name,
    schedule: input.schedule,
    working_directory: input.workingDirectory,
    event_triggers: input.eventTriggers ?? null,
    agent: input.agent,
  });
}

/**
 * Concurrency policies the scheduler actually implements. `'queue'`
 * (serialise behind the previous run) is NOT implemented, so a stored or
 * requested value is rejected on the write path and coerced to the safe
 * `'skip'` on the read path — never to `'parallel'`, which would turn an
 * unimplemented mode into unbounded concurrency.
 */
const CONCURRENCY_POLICIES = new Set<ConcurrencyPolicy>(['skip', 'parallel', 'replace']);

function assertConcurrencyPolicy(value: unknown): ConcurrencyPolicy {
  if (typeof value === 'string' && CONCURRENCY_POLICIES.has(value as ConcurrencyPolicy)) {
    return value as ConcurrencyPolicy;
  }
  throw new Error(
    `unsupported concurrency policy: ${JSON.stringify(value)} (expected one of ${[...CONCURRENCY_POLICIES].join(', ')})`,
  );
}

/** Read-side counterpart: unknown/absent values become 'skip' with a WARN. */
function readConcurrencyPolicy(value: unknown, cronId: string): ConcurrencyPolicy {
  if (value === undefined || value === null) return 'skip';
  if (typeof value === 'string' && CONCURRENCY_POLICIES.has(value as ConcurrencyPolicy)) {
    return value as ConcurrencyPolicy;
  }
  getLogger().warn(
    'cronjob.toml: unsupported concurrency policy; falling back to skip',
    { cronId, value },
    LogComponent.Automation,
  );
  return 'skip';
}

/** On-disk TOML shape (snake_case); the public API is camelCase `AutomationCron`. */
export interface CronJobFile {
  id?: string;
  name: string;
  prompt: string;
  enabled: boolean;
  /** Time trigger; absent for event-only routines (P2.3d). */
  schedule?: CronSchedule;
  working_directory?: string;
  model?: string;
  /**
   * Provider store id `model` belongs to. Absent = unpinned, resolved against
   * the default provider at run time. Deliberately NOT part of
   * `cronIdentityKey` / `cron dedupe`: re-pinning a routine to another vendor
   * re-tunes the same routine, it does not make a new one.
   */
  model_provider_id?: string;
  /** Per-cron session permission profile (plan 574); absent = 'auto' at run time. */
  permission_mode?: string;
  /** Per-cron reasoning effort (plan 574); absent = 'off' at run time. */
  effort?: string;
  /** Bot binding slug (Plan 476 P2.3a). Absent = standalone cron. */
  agent?: string;
  /** Event listeners (P2.3d), persisted as normalized spec objects. */
  event_triggers?: RoutineEventTrigger[];
  /** Per-listener poll cursors, keyed by listener index. */
  listener_state?: ListenerStateFile[];
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
    // Schedule is optional when the job carries event listeners instead
    // (P2.3d event-only routines); a job must have at least one trigger.
    if (job.schedule != null) {
      assertValidSchedule(job.schedule);
    } else if (!Array.isArray(job.event_triggers) || job.event_triggers.length === 0) {
      throw new Error('job needs a schedule or at least one event_triggers entry');
    }
    if (job.event_triggers != null) {
      // Re-validate every stored listener; malformed entries fail the file
      // load loudly rather than silently never firing.
      for (const trigger of job.event_triggers) {
        if (parseEventTriggerSpec(trigger) == null) {
          throw new Error(`job.event_triggers entry is not a valid listener spec: ${JSON.stringify(trigger).slice(0, 200)}`);
        }
      }
    }
    // Plan 476 P2.3a: a bot-bound job must name a valid agent slug (485).
    if (job.agent !== undefined) {
      if (typeof job.agent !== 'string' || !isSafeBotId(job.agent.trim())) {
        throw new Error(`job.agent is not a valid agent slug: ${JSON.stringify(job.agent)}`);
      }
      job.agent = job.agent.trim();
    }
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
    if (input.schedule != null) assertValidSchedule(input.schedule);
    if (!input.name?.trim()) {
      throw new Error(`name is required; got: ${JSON.stringify(input.name)}`);
    }
    if (!input.prompt?.trim()) {
      throw new Error(
        `prompt is required (the natural-language instruction the scheduled run will execute); got: ${JSON.stringify(input.prompt)}`,
      );
    }
    // At least one trigger: a time schedule, event listeners, or both.
    const eventTriggers = parseEventTriggerList(input.eventTriggers);
    if (input.schedule == null && (!eventTriggers || eventTriggers.length === 0)) {
      throw new Error('a routine needs a schedule or at least one event trigger');
    }
    const name = input.name.trim();
    const prompt = input.prompt.trim();
    const workingDirectory = resolveAutomationWorkspace(input.workingDirectory);
    // Plan 476 P2.3a: optional bot binding — validate eagerly so a bad slug
    // never reaches the file.
    const agent = normalizeAgentBinding(input.agent);
    // Optional provider pin (model_provider_id). Blank = unpinned.
    const modelProviderId = normalizeModelProviderId(input.modelProviderId);
    // A concurrency policy the scheduler does not implement is a config
    // error, not something to silently round to 'parallel'.
    const concurrencyPolicy =
      input.concurrencyPolicy === undefined ? 'skip' : assertConcurrencyPolicy(input.concurrencyPolicy);

    // Idempotency: a create request that matches an existing job's identity
    // key (see `cronIdentityKey` — name, workspace, schedule, listeners, bot
    // binding) returns the existing row. This makes repeated "create in chat"
    // / agent-tool calls collapse into a single job instead of stacking
    // duplicates, and it is the same key `dedupeCrons` groups by.
    const identityKey = cronIdentityKeyFromInput({
      name,
      schedule: input.schedule ?? null,
      workingDirectory,
      eventTriggers,
      agent,
    });
    const existing = this.doc.jobs.find((j) => cronIdentityKey(j) === identityKey);
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
      ...(input.schedule != null ? { schedule: input.schedule } : {}),
      working_directory: workingDirectory,
      model: input.model?.trim() || undefined,
      ...(modelProviderId ? { model_provider_id: modelProviderId } : {}),
      permission_mode: normalizeCronPermissionMode(input.permissionMode),
      effort: normalizeCronEffort(input.effort),
      ...(agent ? { agent } : {}),
      ...(eventTriggers && eventTriggers.length ? { event_triggers: eventTriggers } : {}),
      concurrency: concurrencyPolicy,
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
   * Collapse legacy duplicates: group jobs by the shared routine identity key
   * (`cronIdentityKey` — name, normalized workspace, schedule fingerprint,
   * event listeners, bot binding), keep the oldest job in each group, drop
   * the rest. Returns the ids that were removed so callers can audit-log
   * the cleanup. Runtime state (last_run_at / last_error / retry_count)
   * stays on the kept row; drops only discard the redundant row entries.
   *
   * Sharing `createCron`'s key is the point: two rows that createCron treats
   * as the same job are the duplicates, and two routines that differ in their
   * listeners or bot binding are NOT duplicates and survive.
   */
  dedupeCrons(): { removedIds: string[]; kept: number } {
    const groups = new Map<string, CronJobFile[]>();
    for (const job of this.doc.jobs) {
      const key = cronIdentityKey(job);
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
    const mergedSchedule = patch.schedule ?? job.schedule ?? null;
    if (mergedSchedule != null) assertValidSchedule(mergedSchedule);
    if (patch.name !== undefined && !patch.name.trim()) throw new Error('name cannot be empty');
    if (patch.prompt !== undefined && !patch.prompt.trim()) {
      throw new Error('prompt cannot be empty');
    }
    const eventTriggers = parseEventTriggerList(patch.eventTriggers);
    if (patch.name !== undefined) job.name = patch.name.trim();
    if (patch.prompt !== undefined) job.prompt = patch.prompt.trim();
    if (patch.schedule !== undefined) job.schedule = mergedSchedule ?? undefined;
    if (patch.eventTriggers !== undefined) {
      if (eventTriggers && eventTriggers.length) job.event_triggers = eventTriggers;
      else delete job.event_triggers;
    }
    // A job must keep at least one trigger after the update.
    if (job.schedule == null && (!Array.isArray(job.event_triggers) || job.event_triggers.length === 0)) {
      throw new Error('a routine needs a schedule or at least one event trigger');
    }
    if (patch.workingDirectory !== undefined) job.working_directory = resolveAutomationWorkspace(patch.workingDirectory);
    if (patch.model !== undefined) job.model = patch.model.trim() || undefined;
    if (patch.modelProviderId !== undefined) {
      // Empty string / null unpins the routine (back to the default provider).
      const pinned = normalizeModelProviderId(patch.modelProviderId);
      if (pinned) job.model_provider_id = pinned;
      else delete job.model_provider_id;
    }
    if (patch.permissionMode !== undefined) {
      // Invalid values clear the field (falling back to the run-time default) rather than persisting garbage.
      job.permission_mode = normalizeCronPermissionMode(patch.permissionMode);
    }
    if (patch.effort !== undefined) {
      // Empty string resets the effort to the legacy default ('off' at run time).
      job.effort = normalizeCronEffort(patch.effort);
    }
    if (patch.concurrencyPolicy !== undefined) job.concurrency = assertConcurrencyPolicy(patch.concurrencyPolicy);
    if (patch.maxRetries !== undefined) job.max_retries = patch.maxRetries;
    if (patch.enabled !== undefined) job.enabled = patch.enabled;
    if (patch.agent !== undefined) {
      if (patch.agent === null) {
        delete job.agent; // clear the bot binding → standalone cron
      } else {
        job.agent = normalizeAgentBinding(patch.agent) ?? undefined;
      }
    }
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

  /** Read a listener's poll cursor by listener index (P2.3d). */
  getListenerCursor(id: string, index: number): string | null {
    const job = this.doc.jobs.find((j) => j.id === id);
    const entry = job?.listener_state?.find((s) => s.index === index);
    return entry?.cursor ?? null;
  }

  /** Persist a listener's poll cursor + last poll time and write the file. */
  setListenerCursor(id: string, index: number, cursor: string | null): void {
    const job = this.doc.jobs.find((j) => j.id === id);
    if (!job) return;
    const state = job.listener_state ?? (job.listener_state = []);
    const entry = state.find((s) => s.index === index);
    if (entry) {
      entry.cursor = cursor ?? undefined;
      entry.last_poll_at = Date.now();
    } else {
      state.push({ index, ...(cursor != null ? { cursor } : {}), last_poll_at: Date.now() });
    }
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
    // near future, not strictly-after the anchor. Event-only routines
    // (no schedule) derive no nextRunAt — the listener hub owns them.
    const nextRunAnchor =
      lastRunAt > 0 ? lastRunAt : scheduleNeedsCreatedAtAnchor(job.schedule) ? (job.created_at ?? now) : now;
    // Re-validate stored listeners on read; malformed entries degrade to
    // dropped listeners instead of failing the whole store.
    const eventTriggers = (job.event_triggers ?? [])
      .map((trigger) => parseEventTriggerSpec(trigger))
      .filter((trigger): trigger is RoutineEventTrigger => trigger != null);
    return {
      id: job.id ?? '',
      name: job.name,
      prompt: job.prompt,
      schedule: job.schedule ?? null,
      workingDirectory: job.working_directory ?? '',
      model: job.model ?? '',
      modelProviderId: normalizeModelProviderId(job.model_provider_id) ?? null,
      permissionMode: (job.permission_mode ?? null) as AutomationCron['permissionMode'],
      effort: job.effort ?? null,
      enabled: job.enabled !== false,
      // Read-side fail-closed: a stored value outside the implemented set
      // (e.g. a hand-written `concurrency = "queue"`) must not reach the
      // scheduler, where an unrecognised policy falls through to unbounded
      // parallel execution. 'skip' is the conservative choice — the fire is
      // dropped while one is in flight rather than doubled up. WARN, not
      // throw: one stray field must not make the whole file unloadable.
      concurrencyPolicy: readConcurrencyPolicy(job.concurrency, job.id ?? ''),
      maxRetries: job.max_retries ?? DEFAULT_MAX_RETRIES,
      lastRunAt: lastRunAt > 0 ? lastRunAt : null,
      lastError: job.last_error ?? null,
      retryCount: job.retry_count ?? 0,
      agent: job.agent ?? null,
      ...(eventTriggers.length ? { eventTriggers } : {}),
      nextRunAt:
        job.schedule != null ? computeNextRunAt(job.schedule, nextRunAnchor, now) : null,
      createdAt: job.created_at ?? now,
      updatedAt: job.updated_at ?? now,
    };
  }
}
