/**
 * e2e/perf/lib/first-screen-budget.mjs — the rules the first-screen payload
 * budget enforces.
 *
 * WHY A BUDGET AND NOT A TIMER
 *
 * Wall-clock numbers cannot gate a shared CI runner: the same code is fast
 * on one runner and slow on the next. Bytes are machine-independent — the
 * same source produces the same bundle — so a byte budget is a real gate,
 * and it catches the regressions that matter for the first screen: a barrel
 * file that drags a provider SDK back into the entry chunk, an import that
 * used to be lazy becoming static, a dependency that grew.
 *
 * WHY ONLY ONE CALIBRATED RULE
 *
 * The budget is one-sided (growth fails, an improvement passes) and it is
 * calibrated against a measured build-to-build spread, not guessed. The
 * chunk count and the per-chunk breakdown are REPORTED, not gated: there is
 * no calibrated threshold for them, and a threshold nobody calibrated is a
 * flaky gate waiting to happen.
 */

/** The build-to-build spread of the measured payload, in percent. */
export const DEFAULT_TOLERANCE_PCT = 5;

/**
 * Compare a measured first-screen payload against a budget.
 *
 * Returns the checks it made and the violations it found. A violation is a
 * string; an empty list means the budget holds.
 */
export function evaluateBudget(payload, budget) {
  const tolerancePct = Number.isFinite(budget?.tolerancePct) ? budget.tolerancePct : DEFAULT_TOLERANCE_PCT;
  const baselineBytes = budget?.firstScreen?.bytes ?? null;
  const checks = [];
  const violations = [];

  // A gate over a measurement that measured nothing proves nothing.
  if (!payload || !payload.firstScreen || payload.firstScreen.chunkCount <= 0 || payload.firstScreen.bytes <= 0) {
    violations.push('the first-screen payload was not measured: no chunk was reachable from the entry');
    return { checks, violations, tolerancePct };
  }

  if (baselineBytes == null) {
    violations.push('the budget has no firstScreen.bytes to compare against');
    return { checks, violations, tolerancePct };
  }

  const limit = Math.round(baselineBytes * (1 + tolerancePct / 100));
  const measured = payload.firstScreen.bytes;
  const deltaPct = ((measured - baselineBytes) / baselineBytes) * 100;
  checks.push({
    metric: 'firstScreen.bytes',
    measured,
    baseline: baselineBytes,
    limit,
    deltaPct: Math.round(deltaPct * 100) / 100,
  });
  if (measured > limit) {
    violations.push(
      `the first screen grew to ${measured} bytes (${Math.round(measured / 1024)} KB, `
      + `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%), over the budget of ${limit} bytes `
      + `(${Math.round(limit / 1024)} KB = baseline ${Math.round(baselineBytes / 1024)} KB + ${tolerancePct}%)`,
    );
  }

  // Reported, never gated: there is no calibrated threshold for these.
  checks.push({
    metric: 'firstScreen.chunkCount',
    measured: payload.firstScreen.chunkCount,
    baseline: budget?.firstScreen?.chunkCount ?? null,
    limit: null,
  });
  checks.push({
    metric: 'entryChunkBytes',
    measured: payload.entryChunkBytes ?? null,
    baseline: budget?.entryChunkBytes ?? null,
    limit: null,
  });

  return { checks, violations, tolerancePct };
}
