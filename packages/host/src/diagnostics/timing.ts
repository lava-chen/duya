/**
 * packages/host/src/diagnostics/timing.ts
 *
 * Wall-clock attribution for doctor checks.
 *
 * ## Why this is not a `Date.now()` pair at each call site
 *
 * A check's duration is the work performed *between* the previous recorded
 * check and this one: the file reads before `config_file_exists`, the HTTP
 * probe before `desktop_reachable`. Timing each of the ~50 push sites
 * individually would mean surrounding every literal with a start/stop pair and
 * keeping those pairs in sync by hand — the classic way a duration silently
 * measures the wrong span.
 *
 * `pushCheck` instead keeps one baseline per accumulator array. The first
 * push after `resetTiming` measures everything since the run started; every
 * later push measures the span since the previous push. Because checks are
 * recorded in the order their work completes, the span attributed to a check is
 * the span that produced it.
 *
 * ## Why the baseline is keyed by the array
 *
 * Every module that pushes into a `CheckResult[]` it was handed needs the
 * same accounting. Keying the baseline off the array identity lets every
 * signature stay `checks: CheckResult[]`, so this needs no plumbing through
 * the call graph — and, unlike a module-level variable, it cannot leak state
 * between two reports built in one process (tests do exactly that).
 *
 * ## Why this file MUST live beside `types.ts`
 *
 * The baseline is a module-level `WeakMap`. If `pushCheck` and `resetTiming`
 * were ever loaded from two different module instances — the same source file
 * reached through two different specifiers — the two halves would write to two
 * different maps. `resetTiming` would record a baseline that `pushCheck` never
 * reads, and every check would report the 1ms floor. The durations would look
 * plausible and be wrong.
 *
 * That is why this moved into the shared diagnostics directory together with
 * the types: every surface imports BOTH from the same package subpath, so
 * there is exactly one copy of this module in any process.
 *
 * ## Why the floor is 1ms and not 0
 *
 * `Date.now()` has millisecond resolution, so a check that genuinely takes
 * microseconds measures as 0. A `durationMs: 0` row reads as "not measured" to
 * support tooling, which is worse than rounding up. Sub-millisecond checks are
 * reported as 1ms.
 */

import type { CheckResult } from './types.js';

/** Smallest duration reported, so a fast check never looks unmeasured. */
const MIN_REPORTED_DURATION_MS = 1;

const baselines = new WeakMap<CheckResult[], number>();

/**
 * Start attributing durations to `checks`.
 *
 * Call once per report, before any work happens. Without it the first push
 * measures nothing and reports the 1ms floor.
 */
export function resetTiming(checks: CheckResult[]): void {
  baselines.set(checks, Date.now());
}

/**
 * Append `check` to `checks`, stamped with the time since the previous push.
 *
 * An explicit `durationMs` on the incoming check wins, so a caller that
 * genuinely knows its own duration is not overwritten by the accounting.
 */
export function pushCheck(checks: CheckResult[], check: CheckResult): void {
  const now = Date.now();
  const previous = baselines.get(checks);
  baselines.set(checks, now);

  if (check.durationMs !== undefined) {
    checks.push(check);
    return;
  }

  const elapsed = previous === undefined ? 0 : now - previous;
  checks.push({
    ...check,
    durationMs: Math.max(MIN_REPORTED_DURATION_MS, elapsed),
  });
}
