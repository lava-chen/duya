/**
 * run-status.ts — plan 560 §7.3: the 15-value run lifecycle → 6 UI states.
 *
 * The store's `WorkflowRunStatus` is the engine's vocabulary: five values mean
 * "working on it", six mean "parked for a reason", four are terminal. A run card
 * only needs to tell six things apart, and getting the mapping wrong shows up as
 * a pulsing "running" lamp on a dead run. So it lives in one pure function with
 * its own test instead of `status === 'active'` comparisons scattered through
 * components.
 *
 * An unrecognised value maps to `unknown`, never to a guess — a status this
 * build has never heard of must not render as "running".
 *
 * Colours follow §7.3: running uses warning (NOT accent — accent is the app's
 * action colour, and a status must not look like a button), success is success,
 * and every terminal-but-not-success outcome is error.
 */

export const RUN_UI_STATUSES = [
  'running',
  'paused',
  'complete',
  'failed',
  'cancelled',
  'interrupted',
  'unknown',
] as const;

export type WorkflowRunUiStatus = (typeof RUN_UI_STATUSES)[number];

/** Engine status → UI state. Every `WorkflowRunStatus` member is covered. */
const UI_STATUS_BY_STATUS: Record<string, WorkflowRunUiStatus> = {
  // Working: the five in-flight lifecycle states.
  inactive: 'running',
  planning: 'running',
  awaiting_confirm: 'running',
  active: 'running',
  verifying: 'running',
  // Parked: waiting on a human, a retry budget, or infrastructure. Not failed —
  // these are the states a user can still act on.
  user_paused: 'paused',
  backoff_paused: 'paused',
  no_progress_paused: 'paused',
  infra_paused: 'paused',
  blocked: 'paused',
  budget_limited: 'paused',
  // Terminal.
  complete: 'complete',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
};

export function runUiStatus(status: string | null | undefined): WorkflowRunUiStatus {
  if (!status) return 'unknown';
  return UI_STATUS_BY_STATUS[status] ?? 'unknown';
}

/** True only while the run is actually in flight (drives the spinner + polling). */
export function isRunUiActive(status: string | null | undefined): boolean {
  return runUiStatus(status) === 'running';
}

/** Terminal UI states — nothing more will arrive on the stream. */
export function isRunUiTerminal(status: string | null | undefined): boolean {
  const ui = runUiStatus(status);
  return ui === 'complete' || ui === 'failed' || ui === 'cancelled' || ui === 'interrupted';
}

export interface RunStatusTone {
  /** Foreground + status lamp colour. */
  color: string;
  /** Translucent fill for the status pill. */
  soft: string;
  /** Drives the breathing lamp; true for `running` only. */
  pulse: boolean;
}

const TONES: Record<WorkflowRunUiStatus, RunStatusTone> = {
  running: { color: 'var(--warning)', soft: 'var(--warning-soft)', pulse: true },
  paused: { color: 'var(--warning)', soft: 'var(--warning-soft)', pulse: false },
  complete: { color: 'var(--success)', soft: 'var(--success-soft)', pulse: false },
  failed: { color: 'var(--error)', soft: 'var(--error-soft)', pulse: false },
  cancelled: { color: 'var(--error)', soft: 'var(--error-soft)', pulse: false },
  interrupted: { color: 'var(--error)', soft: 'var(--error-soft)', pulse: false },
  unknown: { color: 'var(--muted)', soft: 'transparent', pulse: false },
};

export function runStatusTone(ui: WorkflowRunUiStatus): RunStatusTone {
  return TONES[ui];
}

/**
 * i18n key per UI state. The module stays copy-free so the same mapping serves
 * zh and en; the labels live in `src/i18n/{zh,en}.ts` under `workflow.runUi.*`.
 */
export const RUN_UI_STATUS_I18N_KEY: Record<WorkflowRunUiStatus, string> = {
  running: 'workflow.runUi.running',
  paused: 'workflow.runUi.paused',
  complete: 'workflow.runUi.complete',
  failed: 'workflow.runUi.failed',
  cancelled: 'workflow.runUi.cancelled',
  interrupted: 'workflow.runUi.interrupted',
  unknown: 'workflow.runUi.unknown',
};
