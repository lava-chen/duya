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
 * Decide whether a command is allowed to be auto-backgrounded.
 *
 * Only the base command is inspected. Sleep inside a pipeline or
 * subshell is OK because the surrounding command is what the user
 * actually wants to wait for.
 */
export function isAutobackgroundingAllowed(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return true;

  const first = trimmed.split(/\s+/)[0]?.toLowerCase();
  if (!first) return true;

  return !DISALLOWED_AUTO_BACKGROUND_COMMANDS.includes(first);
}

/**
 * When true, automatic backgrounding on timeout is disabled. The model
 * must explicitly set `run_in_background: true` to background a command.
 */
export function isBackgroundTasksDisabled(env: EnvLike = process.env): boolean {
  return env.DUYA_DISABLE_BACKGROUND_TASKS === '1' || env.DUYA_DISABLE_BACKGROUND_TASKS === 'true';
}
