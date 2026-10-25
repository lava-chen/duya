/**
 * packages/agent-protocol/src/doctor.ts
 *
 * The wire contract for the doctor report and for the `/init` write.
 *
 * ## Why these shapes are a contract
 *
 * Three surfaces produce or carry a doctor report: the Host (which owns the
 * checks), the desktop renderer (which renders the report) and the CLI (which
 * renders the same report as text). The renderer cannot import `@duya/host` —
 * the shared renderer package does not depend on it, and the browser-closure
 * gate seeds `packages/ui/src` — so the shape the renderer receives has to be
 * described somewhere the renderer can reach.
 *
 * This module is that place. It carries no behaviour and no IO: it is the
 * agreement between the surfaces, not an implementation of them.
 *
 * ## Why the category list lives here
 *
 * A check's category used to be a hand-written union in one module and a
 * SEPARATE, shorter hand-written list in the renderer. A category that was in
 * the union but not in the render list did not render badly — it did not render
 * at all, and vanished from the report with no trace. The list is the single
 * source of truth and the union is derived from it, so the two cannot disagree.
 */

/**
 * Every category a check can belong to, in report order.
 *
 * The order IS the report order: config first (the cheapest and most
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
 * the thing it needs was not there. A `skipped` check is an absence of
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
 * `cause` says what is wrong, `measured` is what was observed, `expected` is
 * what the check wanted, and `remedy` is the next action. All four go through
 * redaction on the Host side — the same invariant `hint` and `details` carry.
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
  readonly id: string;
  readonly category: DoctorCategory;
  readonly status: DoctorStatus;
  readonly message: string;
  /** A sentence for a human: what to do about a non-ok status. */
  readonly hint?: string;
  readonly details?: Record<string, unknown>;
  /** Structured reasons behind a non-ok status. */
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

/** A whole doctor report. */
export interface DoctorResult {
  readonly version: string;
  readonly timestamp: number;
  readonly overallStatus: DoctorOverallStatus;
  readonly profile: DoctorProfile;
  readonly checks: readonly CheckResult[];
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

/**
 * The Host capability that writes the repository-root `AGENTS.md`.
 *
 * The client sends a SESSION ID and never a path: the Host owns where the
 * workspace lives, and a path in a client request is a path an attacker
 * chooses. The Host resolves the session to its working directory, finds the
 * repository root, and writes there.
 */
export interface HostAgentsMdApiV1 {
  writeAgentsMd(input: { readonly sessionId: string }): Promise<InitAgentsMdResult>;
}
