/**
 * electron/automation/schedule.ts
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
import type { CronSchedule } from './types.js';

const EVERY_RE = /^(\d+)(s|m|h|d|w)$/;
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;

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
 * - `cron`: next occurrence via `croner`.
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
  const next = cron.nextRun(new Date(nowMs));
  if (!next) return null;
  const nextMs = next.getTime();
  if (!Number.isFinite(nextMs) || nextMs <= nowMs) return null;
  return withinEnd(nextMs);
}
