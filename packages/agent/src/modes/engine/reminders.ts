/**
 * Plan-mode reminder templates (plan 413b).
 *
 * duya's plan-task mode has no plan-file mechanism — it is a read-only analysis
 * mode that produces a plan — so the templates are reworded from grok's
 * `plan_mode.rs` to match the existing `PLAN_TASK_PROMPT` read-only contract.
 * The 413d coordinator picks full/sparse via
 * `PlanModeTracker.shouldUseFullReminder` and wraps the chosen inner text with
 * {@link renderReminder} before injecting it into the turn.
 */

/** Wrap an inner reminder body in a `<system-reminder>` boundary. Matches the
 * agentsmd/loader.ts convention (plan 408) so the prompt-injection guard has a
 * strippable boundary on the outgoing payload. */
export function renderReminder(inner: string): string {
  return `<system-reminder>\n${inner}\n</system-reminder>`;
}

/** Full reminder — injected on activation and on even `reminderCount` turns. */
export function fullReminder(): string {
  return `# Plan Mode Active

You are in Plan Mode — read-only analysis. Do NOT modify, create, or delete any files;
do NOT execute side-effectful commands.
Use only read-only tools: \`read\`, \`glob\`, \`grep\`, \`task\`, \`session_search\`, \`ask_user_question\`, \`web_search\`, \`web_fetch\`.
End your turn with a structured implementation plan the user can approve.`;
}

/** Sparse reminder — odd `reminderCount` turns (token-saving nudge). */
export function sparseReminder(): string {
  return `Plan mode is still active. Read-only — do not modify files or run side-effectful commands.`;
}

/** Reentry reminder — second+ entry into plan mode in the same session. */
export function reentryReminder(): string {
  return `## Returning to Plan Mode

You are entering Plan Mode again. Same read-only rules apply: no file modifications,
no side-effectful commands. Produce an implementation plan.`;
}

/** Exit reminder — one-shot after exiting plan mode. */
export function exitReminder(): string {
  return `You have exited Plan Mode. You can now make edits, run tools, and take actions.`;
}
