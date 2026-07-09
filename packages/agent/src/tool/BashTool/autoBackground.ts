type EnvLike = Record<string, string | undefined>;

/**
 * Commands that must not be auto-backgrounded on timeout.
 * Rationale: `sleep` is almost always used as a foreground pacing
 * primitive, not a long-running job. For long waits, the model should
 * use `run_in_background: true` explicitly.
 *
 * Note: this list only applies to AUTOMATIC backgrounding. The model
 * can still pass `run_in_background: true` for any command.
 */
export const DISALLOWED_AUTO_BACKGROUND_COMMANDS: readonly string[] = ['sleep'];

/**
 * Pattern that disqualifies a command from automatic backgrounding.
 * Matches `sleep` anywhere in the command — including inside pipelines,
 * subshells, and `&&` chains — not just the first word. A buried
 * `sleep 60` still means the caller wants to wait, so the previous
 * first-word-only check would let `echo hi && sleep 120` slip through.
 */
const DISALLOWED_AUTO_BACKGROUND_PATTERN = /\bsleep\b/;

/**
 * Decide whether a command is allowed to be auto-backgrounded.
 */
export function isAutobackgroundingAllowed(command: string): boolean {
  if (command.trim().length === 0) return true;
  return !DISALLOWED_AUTO_BACKGROUND_PATTERN.test(command);
}

/**
 * When true, automatic backgrounding on timeout is disabled. The model
 * must explicitly set `run_in_background: true` to background a command.
 */
export function isBackgroundTasksDisabled(env: EnvLike = process.env): boolean {
  return env.DUYA_DISABLE_BACKGROUND_TASKS === '1' || env.DUYA_DISABLE_BACKGROUND_TASKS === 'true';
}
