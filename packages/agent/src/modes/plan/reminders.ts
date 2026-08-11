/**
 * Plan-mode per-turn reminders (plan 413b / grok plan-file port).
 *
 * Plan-task is a read-only planning mode that writes its plan to a single
 * session-scoped file (`~/.duya/sessions/<session_id>/plan.md`) — the
 * only file the agent may edit while plan mode is active. The `full`/
 * `sparse` alternation is chosen by the coordinator (plan 413d) via
 * `PlanModeTracker.shouldUseFullReminder()`. The runtime enforcement of the
 * "only plan.md" rule lives in `ModeCoordinator.gateWriteTool`.
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
export function fullReminder(planPath: string): string {
  return `# Plan Mode Active

You are in Plan Mode. Do not modify, create, or delete any files, and do not
execute side-effectful commands — EXCEPT the single plan file below.

## Plan File:
A plan file exists at ${planPath}. You can read it and make edits using the edit
tool. Write your implementation plan to this file. Note that this is the ONLY
file you are allowed to edit while in plan mode.

Your turn should only end with either ask_user_question to clarify requirements
or exit_plan_mode to present your plan to the user.`;
}

/** Sparse template — injected mid-run on odd reminder counts to save tokens. */
export function sparseReminder(): string {
  return `Plan mode is still active. Do not make any edits or writes to the system except for the plan file.`;
}

/** Re-entry template — injected when this session enters plan mode again. */
export function reentryReminder(planPath: string): string {
  return `## Returning to Plan Mode

You are entering Plan Mode again. A plan file exists at ${planPath} from your
previous planning session. Same rule applies: only that file is editable.`;
}

/** Exit template — injected once after leaving plan mode. */
export function exitReminder(): string {
  return `You have exited Plan Mode. You can now make edits, run tools, and take actions.`;
}
