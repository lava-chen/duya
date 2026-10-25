/**
 * packages/host/src/diagnostics/types.ts
 *
 * The report shape every surface that runs a doctor check agrees on.
 *
 * ## Why this lives in the Host and not in the CLI
 *
 * The Desktop and the CLI must be able to say the SAME thing about the SAME
 * install: "config.toml is missing", "the session store cannot be queried".
 * When each side owned its own copy of these types, the two reports drifted —
 * a field added on one side was silently absent on the other, and the
 * comparison a support engineer makes between two bug reports stopped
 * meaning anything. One definition, two surfaces.
 *
 * ## The category list is the single source of truth
 *
 * `CheckResult.category` used to be a hand-written union that included
 * `'database'`, while the text renderer grouped by a SEPARATE, shorter
 * hand-written list that did not. A check whose category was in the union but
 * not in the render list did not render badly — it did not render AT ALL. It
 * vanished from the report with no trace, which is the worst possible failure
 * for a diagnostic.
 *
 * The union is now DERIVED from the list:
 *
 *   DOCTOR_CATEGORIES  →  DoctorCategory = typeof DOCTOR_CATEGORIES[number]
 *
 * so a category that is not listed does not exist, and a category that is
 * listed is always rendered. The two can no longer disagree, because there is
 * only one of them.
 */

/**
 * Every category a check can belong to, in report order.
 *
 * The order IS the report order: config first (it is the cheapest and most
 * fundamental), then the local runtime, then the three categories that need a
 * Host to answer.
 */
export const DOCTOR_CATEGORIES = [
  'config',
  'runtime',
  'desktop',
  'database',
  'plugin',
  'session',
] as const;

/** The category of a check. Derived from {@link DOCTOR_CATEGORIES}. */
export type DoctorCategory = typeof DOCTOR_CATEGORIES[number];

/**
 * How one check ended.
 *
 * `skipped` is NOT a softer `error`: it means the check could not run because
 * the thing it needs was not there (a Host that cannot answer, a platform
 * whose permission model does not apply). A `skipped` check is an absence of
 * information, and a report that counts it as a failure teaches the reader to
 * ignore the failures.
 */
export type DoctorStatus = 'ok' | 'warning' | 'error' | 'skipped';

/** The roll-up of every check's status. */
export type DoctorOverallStatus = 'ok' | 'warning' | 'error';

/** Which configuration the report was produced under. */
export type DoctorProfile = 'production' | 'development' | 'unknown';

/**
 * One structured reason a check is not `ok`.
 *
 * A `hint` is a sentence for a human; an issue is the same information split
 * into parts a support tool can act on. `cause` says what is wrong, `measured`
 * is what was observed, `expected` is what the check wanted, and `remedy` is
 * the next action. All four are free text and all four go through redaction in
 * `redact.ts` — the same invariant `hint` and `details` already carry.
 *
 * Mirrors the reference implementation's `DoctorIssue`, minus `severity` and
 * `fields` (duya has one status per check and no per-field selection) and with
 * `remedy` required, because duya has no separate `remediation` field to hold a
 * remedy that carries no cause.
 */
export interface DoctorIssue {
  /** Why this is a problem. */
  readonly cause: string;
  /** What the check actually observed, when it is worth stating. */
  readonly measured?: string;
  /** What the check required instead. */
  readonly expected?: string;
  /** What the user should do next. */
  readonly remedy: string;
}

/** One diagnostic check and its outcome. */
export interface CheckResult {
  id: string;
  category: DoctorCategory;
  status: DoctorStatus;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
  /**
   * Structured reasons behind a non-ok status. Optional: not every check has
   * been migrated, and adding it to every check would be mechanical work with a
   * real chance of a wrong `measured` value, so it is opt-in per check.
   */
  issues?: readonly DoctorIssue[];
  /**
   * Milliseconds spent producing this check, measured by `pushCheck`. Present
   * on every check a report records, which is what lets a reader tell a slow
   * check from a broken one.
   */
  durationMs?: number;
}

/** A whole doctor report. */
export interface DoctorResult {
  version: string;
  timestamp: number;
  overallStatus: DoctorOverallStatus;
  profile: DoctorProfile;
  checks: CheckResult[];
  summary: {
    errors: number;
    warnings: number;
    skipped: number;
    ok: number;
  };
}
