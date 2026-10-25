// Shared doctor / init vocabulary for the Desktop.
//
// This file is the single source of truth consumed by
// apps/desktop/src/main/ipc/doctor-report.ts (the main process, which
// assembles the report), apps/desktop/src/preload/index.ts (the contextBridge
// surface) and the renderer executors under packages/ui/src/lib/commands/.
//
// It is deliberately import-free so that last hop stays a type-only edge:
// nothing here can pull main-process code into the renderer bundle.
//
// ## Why these shapes are declared here and not in `@duya/host`
//
// The Host's diagnostics layer (`packages/host/src/diagnostics/`) owns the
// CHECKS. This file owns the WIRE. The renderer cannot import `@duya/host`
// (the shared renderer package does not depend on it, and the browser-closure
// gate seeds `packages/ui/src`), so the payload the renderer receives has to
// be described somewhere the renderer can reach. The two must agree field for
// field; keeping the wire here makes that agreement a compile-time fact
// rather than a comment.
//
// `DoctorReport` mirrors the Host's `DoctorResult` one-for-one. When the Host
// layer lands, the main process produces the Host type and this file stays the
// renderer's frozen view of it — the shapes are identical, so nothing moves.

/** The area a check belongs to. */
export type DoctorCategory = 'config' | 'runtime' | 'desktop' | 'database' | 'plugin' | 'session';

/**
 * The verdict for one check.
 *
 * `skipped` means "this check does not apply in the current environment" —
 * NOT "this check failed". A surface that cannot answer a question reports
 * `skipped`; a surface that answered and found a problem reports `error` or
 * `warning`. The two are rendered differently for exactly this reason.
 */
export type DoctorStatus = 'ok' | 'warning' | 'error' | 'skipped';

/** The roll-up of every check in a report. */
export type DoctorOverallStatus = 'ok' | 'warning' | 'error';

/** Which kind of installation the report describes. */
export type DoctorProfile = 'production' | 'development' | 'unknown';

/** One structured reason a check is not `ok`. */
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

/** One check in a report. */
export interface DoctorCheck {
  readonly id: string;
  readonly category: DoctorCategory;
  readonly status: DoctorStatus;
  readonly message: string;
  /** A sentence for a human: what to do about a non-ok status. */
  readonly hint?: string;
  readonly details?: Record<string, unknown>;
  readonly issues?: readonly DoctorIssue[];
  /** Milliseconds spent producing this check. */
  readonly durationMs?: number;
}

/** How many checks landed in each status. */
export interface DoctorSummary {
  readonly errors: number;
  readonly warnings: number;
  readonly skipped: number;
  readonly ok: number;
}

/** The whole report. */
export interface DoctorReport {
  readonly version: string;
  readonly timestamp: number;
  readonly overallStatus: DoctorOverallStatus;
  readonly profile: DoctorProfile;
  readonly checks: readonly DoctorCheck[];
  readonly summary: DoctorSummary;
}

/**
 * The outcome of writing the repository-root `AGENTS.md`.
 *
 * `unchanged` and `upgraded` are separate because they are different
 * outcomes: the first means duya left the user's file alone, the second means
 * duya rewrote a file it had written before. `replacedUnmarked` marks the
 * third case — a file with no duya marker, which duya treated as version 0
 * and therefore overwrote.
 */
export interface InitAgentsMdResult {
  readonly ok: boolean;
  /** Absolute path of the AGENTS.md this result is about. */
  readonly path?: string;
  readonly created: boolean;
  readonly upgraded: boolean;
  readonly unchanged: boolean;
  /** The template version now recorded in the file. */
  readonly version: number;
  /** True when a file without a duya marker was overwritten. */
  readonly replacedUnmarked?: boolean;
  /** Why the write did not happen. */
  readonly error?: string;
}
