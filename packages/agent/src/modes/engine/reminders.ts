/**
 * Plan-mode per-turn reminders (plan 413b).
 *
 * Four templates modeled on grok's `inject_plan_mode_reminders`, duya-ized:
 * plan-task is a read-only analysis mode with no `plan.md` file, so the
 * templates restate the read-only contract instead of pointing at a plan
 * document. The `full`/`sparse` alternation is chosen by the coordinator
 * (plan 413d) via `PlanModeTracker.shouldUseFullReminder()`.
 *
 * Templates are unwrapped inner text — call {@link renderReminder} to wrap
 * them in `<system-reminder>` before appending to the timeline (the same
 * convention `agentsmd/loader.ts` uses for AGENTS.md injection, plan 408).
 */

/** Wrap inner text in a `<system-reminder>` block (plan 408 convention). */
export function renderReminder(inner: string): string {
  return `<system-reminder>\n${inner}\n</system-reminder>`;
}

/** Full template — injected on activation or on even reminder counts. */
export function fullReminder(): string {
  return `# Plan Mode Active

You are in Plan Mode — read-only analysis. Do NOT modify, create, or delete any files;
do NOT execute side-effectful commands.
Use only read-only tools: read, glob, grep, task, session_search, ask_user_question, web_search, web_fetch.
End your turn with a structured implementation plan the user can approve.`;
}

/** Sparse template — injected mid-run on odd reminder counts to save tokens. */
export function sparseReminder(): string {
  return `Plan mode is still active. Read-only — do not modify files or run side-effectful commands.`;
}

/** Re-entry template — injected when this session enters plan mode again. */
export function reentryReminder(): string {
  return `## Returning to Plan Mode

You are entering Plan Mode again. Same read-only rules apply: no file modifications,
no side-effectful commands. Produce an implementation plan.`;
}

/** Exit template — injected once after leaving plan mode. */
export function exitReminder(): string {
  return `You have exited Plan Mode. You can now make edits, run tools, and take actions.`;
}
