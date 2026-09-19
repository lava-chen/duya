/**
 * Shared BashTool execution limits.
 *
 * Keep prompt, schema, foreground execution, and worker execution aligned so
 * the model sees the same contract the runtime enforces.
 */

/**
 * Default timeout when the model omits `timeout`. Restores the historical
 * 120s bound so interactive/blocking foreground commands (e.g. `lark-cli auth
 * login`) cannot hang forever. Background tasks are intentionally NOT bounded
 * by this constant.
 */
export const BASH_DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Hard cap on the `timeout` field for FOREGROUND commands. The runtime will
 * also auto-promote foreground commands to a managed background task after
 * {@link BASH_SOFT_YIELD_MS} without restarting the process, so increasing
 * timeout beyond 5 minutes is almost always the wrong choice — opt into
 * `run_in_background: true` for longer commands instead.
 */
export const BASH_MAX_FOREGROUND_TIMEOUT_MS = 300_000;

/**
 * Soft yield threshold. Foreground commands that do not complete within this
 * window are auto-promoted to a managed background task and the tool call
 * returns the new task id (no process restart). Mirrors mcode's
 * `DEFAULT_FOREGROUND_BASH_SOFT_YIELD_MS = 15_000` so interactive shells stay
 * snappy while long commands no longer block the conversation.
 */
export const BASH_SOFT_YIELD_MS = 15_000;

/**
 * Absolute maximum `timeout` the model is allowed to pass. Used for
 * BACKGROUND commands (foreground uses {@link BASH_MAX_FOREGROUND_TIMEOUT_MS}).
 * Matches the historical ceiling so existing long-running background flows
 * keep working.
 */
export const BASH_MAX_TIMEOUT_MS = 600_000;