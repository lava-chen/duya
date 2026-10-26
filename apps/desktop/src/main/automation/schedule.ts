/**
 * apps/desktop/src/main/automation/schedule.ts
 *
 * Pure schedule helpers for the cron subsystem. The schedule is a nested,
 * human-readable object stored in `~/.duya/cronjob.toml`:
 *
 *   { kind = "once",  at = "2026-12-31T23:59:00Z" }
 *   { kind = "every", every = "5m" | "1h" | "1d" }
 *   { kind = "cron",  expr = "0 9 * * *", tz = "Asia/Shanghai" }
 *
 * `next_run_at` is never persisted: it is derived on each tick from
 * `(schedule, lastRunAt, now)`, so restarts are crash-safe by construction.
 */

import { Cron } from 'croner';
import type { CronSchedule, MisfirePolicy } from './types.js';

const EVERY_RE = /^(\d+)(s|m|h|d|w)$/;
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;

/** Unset policies keep today's single-fire catch-up. */
export const DEFAULT_MISFIRE_POLICY: MisfirePolicy = 'latest';
/** A `bounded` catch-up never replays more than this many instants. */
export const MAX_BOUNDED_CATCH_UP = 5;
/**
 * `skip` only fires an overdue instant inside this window; anything older is
 * treated as genuinely missed. Two tick intervals of slack keep a normal
 * 60 s poll from being classified as a miss.
 */
export const DEFAULT_MISFIRE_GRACE_MS = 5 * 60_000;

/** Parse a human-friendly duration like "5m", "1h", "1d" into milliseconds. */
export function parseEveryDuration(input: string): number {
  const m = EVERY_RE.exec(input.trim());
  if (!m) {
    throw new Error(`invalid duration "${input}" (expected like "5m", "1h", "1d")`);
  }
  const n = Number(m[1]);
  const unit = m[2] as keyof typeof UNIT_MS;
  return n * UNIT_MS[unit];
}

/** Inverse of `parseEveryDuration`: format ms back to a compact string. */
export function formatEveryDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

/**
 * Validate a schedule shape. Throws with an actionable message so the
 * error can surface to the user (IPC / CLI create/update).
 */
export function assertValidSchedule(schedule: CronSchedule): void {
  if (!schedule || typeof schedule !== 'object') throw new Error('schedule is required');
  if (schedule.endAt && Number.isNaN(Date.parse(schedule.endAt))) {
    throw new Error(`schedule.endAt must be an ISO date-time; got: ${JSON.stringify(schedule.endAt)}`);
  }
  if (schedule.kind === 'once') {
    if (!schedule.at || Number.isNaN(Date.parse(schedule.at))) {
      throw new Error(
        `schedule.at is required for kind="once" (e.g. "2026-12-31T23:59:00Z"); got: ${JSON.stringify(schedule.at)}.\n` +
          `  Example: { "name": "...", "prompt": "...", "schedule": { "kind": "once", "at": "2026-12-31T23:59:00Z" } }`,
      );
    }
    return;
  }
  if (schedule.kind === 'every') {
    if (typeof schedule.every !== 'string' || !schedule.every.trim()) {
      throw new Error(
        `schedule.every is required for kind="every" (e.g. "5m", "1h", "1d"); got: ${JSON.stringify(schedule.every)}.\n` +
          `  Example: { "name": "...", "prompt": "...", "schedule": { "kind": "every", "every": "1d" } }`,
      );
    }
    try {
      parseEveryDuration(schedule.every);
    } catch (error) {
      throw new Error(`invalid every duration: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  if (schedule.kind === 'cron') {
    if (!schedule.expr?.trim()) {
      throw new Error(
        `schedule.expr is required for kind="cron" (5-field expression, e.g. "0 9 * * *"); got: ${JSON.stringify(schedule.expr)}.\n` +
          `  Example: { "name": "...", "prompt": "...", "schedule": { "kind": "cron", "expr": "0 9 * * *" } }`,
      );
    }
    try {
      new Cron(schedule.expr, { timezone: schedule.tz || undefined, catch: false });
    } catch (error) {
      throw new Error(`invalid cron expression "${schedule.expr}": ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  throw new Error(
    `unsupported schedule.kind: ${(schedule as { kind?: string }).kind ?? 'unknown'} (expected one of: "once", "every", "cron")`,
  );
}

/**
 * Compute the next absolute fire time for a schedule.
 *
 * - `once`: fires at `at` if still in the future; a past one-shot never fires again.
 * - `every`: cadence anchored on `lastRunAt` (or `now` for a job that never ran),
 *   so restarting the app does not shift the phase. A candidate already in the
 *   past is returned as-is; the tick treats it as due once (catch-up, no burst).
 * - `cron`: next occurrence via `croner`, anchored on `lastRunAt` so the same
 *   scheduled fire cannot repeat within one tick interval. A candidate already
 *   in the past is returned as-is; the tick treats it as due once (catch-up).
 *   NOTE: `croner.Cron.nextRun(t)` is strictly-after `t`, so the anchor must
 *   come from caller (`lastRunAt` for previously-fired jobs, `createdAt` for
 *   brand-new jobs) — never from `nowMs`. Anchoring on `nowMs` made the
 *   scheduler permanently miss every `cron` schedule (see plan forthcoming in
 *   docs/exec-plans/active).
 *
 * Returns `null` when the schedule is exhausted (past one-shot / endAt reached).
 */
export function computeNextRunAt(schedule: CronSchedule, lastRunAtMs: number, nowMs: number): number | null {
  const endAtMs = schedule.endAt ? Date.parse(schedule.endAt) : null;
  const withinEnd = (candidate: number): number | null => {
    if (endAtMs !== null && Number.isFinite(endAtMs) && candidate > endAtMs) return null;
    return candidate;
  };

  if (schedule.kind === 'once') {
    const at = Date.parse(schedule.at);
    if (!Number.isFinite(at) || at <= nowMs) return null;
    return withinEnd(at);
  }

  if (schedule.kind === 'every') {
    const everyMs = parseEveryDuration(schedule.every);
    const base = lastRunAtMs > 0 ? lastRunAtMs : nowMs;
    return withinEnd(base + everyMs);
  }

  // kind === 'cron'
  const expr = schedule.expr?.trim() || '';
  if (!expr) return null;
  const cron = new Cron(expr, { timezone: schedule.tz || undefined, catch: false });
  // Anchor on lastRunAtMs (NOT nowMs): croner.nextRun is strictly-after its
  // argument, so anchoring on nowMs always returns a future time and the
  // tick filter `nextRunAt <= now` can never match. The returned time can
  // legitimately be in the past when lastRunAt is far enough back — that
  // is the catch-up signal, and the tick filter handles it.
  const next = cron.nextRun(new Date(lastRunAtMs));
  if (!next) return null;
  const nextMs = next.getTime();
  if (!Number.isFinite(nextMs)) return null;
  return withinEnd(nextMs);
}

// ── S6: deterministic fire identity and bounded catch-up ───────────────────
//
// Framework plan S6 turns a routine fire into a durable identity instead of a
// fresh UUID. The same (routine, schedule, scheduled instant) must produce the
// same key in every process and after every restart, so the Host inbox can
// collapse a replayed fire. The schedule fingerprint participates so editing
// the cadence produces new identities without re-firing old instants.

/** FNV-1a, 32-bit. Pure and stable; no dependency on `node:crypto`. */
function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Stable identity of one scheduled routine fire. `scheduledForMs` is the
 * scheduled instant (not the wall-clock time the tick happened to notice it),
 * so a catch-up or a restart names the same obligation.
 */
export function routineFireKey(input: {
  routineId: string;
  scheduleFingerprint: string;
  scheduledForMs: number;
}): string {
  if (!input.routineId.trim()) throw new Error('routineId is required for a fire key');
  if (!Number.isSafeInteger(input.scheduledForMs) || input.scheduledForMs <= 0) {
    throw new Error(`scheduledForMs must be a positive safe integer; got: ${input.scheduledForMs}`);
  }
  return `r1:${input.routineId}:${input.scheduledForMs}:${stableHash(input.scheduleFingerprint)}`;
}

function endAtMsOf(schedule: CronSchedule): number | null {
  const parsed = schedule.endAt ? Date.parse(schedule.endAt) : null;
  return parsed !== null && Number.isFinite(parsed) ? parsed : null;
}

/** Raw next occurrence of a cron schedule strictly after `afterMs`. */
type NextOccurrence = (afterMs: number) => number | null;

/**
 * One parsed `croner` pattern reused across the ~30 probes of a binary
 * search (constructing a `Cron` per probe re-parses the expression).
 */
function makeCronNextOccurrence(schedule: Extract<CronSchedule, { kind: 'cron' }>): NextOccurrence {
  const expr = schedule.expr?.trim() || '';
  if (!expr) return () => null;
  const cron = new Cron(expr, { timezone: schedule.tz || undefined, catch: false });
  return (afterMs) => {
    const next = cron.nextRun(new Date(afterMs));
    if (!next) return null;
    const ms = next.getTime();
    return Number.isFinite(ms) ? ms : null;
  };
}

/**
 * The newest scheduled instant in `(afterMs, beforeMs]`, or null.
 *
 * `every` is phase-anchored on `afterMs`, so its newest occurrence is O(1).
 * `cron` has no previous-run query in croner 9, so we binary-search the
 * boundary where `nextRun(t)` crosses `beforeMs` (monotonic in `t`) — about
 * 30 croner evaluations for a three-day gap instead of thousands.
 */
function lastOccurrenceAtOrBefore(
  schedule: CronSchedule,
  afterMs: number,
  beforeMs: number,
  nextAfter?: NextOccurrence,
): number | null {
  if (beforeMs <= afterMs) return null;
  if (schedule.kind === 'once') return null;

  if (schedule.kind === 'every') {
    if (afterMs <= 0) return null;
    const interval = parseEveryDuration(schedule.every);
    const steps = Math.floor((beforeMs - afterMs) / interval);
    if (steps < 1) return null;
    const candidate = afterMs + steps * interval;
    const endAt = endAtMsOf(schedule);
    return endAt !== null && candidate > endAt ? null : candidate;
  }

  const nextOccurrence = nextAfter ?? makeCronNextOccurrence(schedule);
  const first = nextOccurrence(afterMs);
  if (first === null || first > beforeMs) return null;
  let low = afterMs;
  let high = beforeMs;
  while (high - low > 1) {
    const mid = low + Math.floor((high - low) / 2);
    const next = nextOccurrence(mid);
    if (next !== null && next <= beforeMs) low = mid;
    else high = mid;
  }
  const last = nextOccurrence(low);
  const instant = last !== null && last <= beforeMs ? last : first;
  const endAt = endAtMsOf(schedule);
  return endAt !== null && instant > endAt ? null : instant;
}

/**
 * Which scheduled instants a tick should fire, oldest first (framework plan
 * S6). `afterMs` is the last claimed fire (0/null for a one-shot that never
 * ran; the job's creation anchor for a recurring schedule that never fired);
 * `nowMs` is the tick clock.
 *
 * - `skip`: fire only when the first overdue instant is inside the grace
 *   window; a longer gap is dropped instead of replayed.
 * - `latest`: fire the newest missed instant once (today's 09:00 after a
 *   three-day outage, not Monday's).
 * - `bounded`: fire at most `maxCatchUp` of the newest missed instants.
 *
 * `once` schedules ignore the policy: a one-shot that was missed while the
 * machine was offline still fires — late, exactly once. Dropping it would
 * silently cancel the reminder, and there is no cadence to burst.
 */
export function planDueRoutineFires(input: {
  schedule: CronSchedule;
  afterMs: number;
  nowMs: number;
  policy?: MisfirePolicy;
  maxCatchUp?: number;
  graceMs?: number;
}): number[] {
  const policy = input.policy ?? DEFAULT_MISFIRE_POLICY;
  const nowMs = input.nowMs;
  if (!Number.isFinite(nowMs)) return [];

  if (input.schedule.kind === 'once') {
    const at = Date.parse(input.schedule.at);
    if (!Number.isFinite(at) || at > nowMs || at <= input.afterMs) return [];
    return [at];
  }

  if (policy === 'skip') {
    const first = computeNextRunAt(input.schedule, input.afterMs, nowMs);
    if (first === null || first > nowMs) return [];
    return nowMs - first <= (input.graceMs ?? DEFAULT_MISFIRE_GRACE_MS) ? [first] : [];
  }

  const nextAfter = input.schedule.kind === 'cron' ? makeCronNextOccurrence(input.schedule) : undefined;
  const newest = lastOccurrenceAtOrBefore(input.schedule, input.afterMs, nowMs, nextAfter);
  if (newest === null) return [];
  if (policy === 'latest') return [newest];

  const limit = Math.min(
    MAX_BOUNDED_CATCH_UP,
    Math.max(1, Math.trunc(input.maxCatchUp ?? 1)),
  );
  const fires = [newest];
  let cursor = newest;
  while (fires.length < limit) {
    const previous = lastOccurrenceAtOrBefore(input.schedule, input.afterMs, cursor - 1, nextAfter);
    if (previous === null) break;
    fires.push(previous);
    cursor = previous;
  }
  return fires.reverse();
}
