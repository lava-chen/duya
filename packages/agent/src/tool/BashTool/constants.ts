/**
 * Shared BashTool execution limits.
 *
 * Keep prompt, schema, foreground execution, and worker execution aligned so
 * the model sees the same contract the runtime enforces.
 *
 * Lifetime policy (implemented in managed-bash.ts / BashTool.ts):
 *   1. every command is spawned as a managed background task up front;
 *   2. a foreground call waits at most {@link BASH_SOFT_YIELD_MS} before
 *      handing the still-running task id back to the model (no restart);
 *   3. while the call is still foreground, `timeout` (default
 *      {@link BASH_DEFAULT_TIMEOUT_MS}, ceiling
 *      {@link BASH_MAX_FOREGROUND_TIMEOUT_MS}) is the kill watchdog;
 *   4. once promoted, the command leaves the foreground ceiling and is bounded
 *      by {@link BASH_MAX_TIMEOUT_MS} instead — the model stopped waiting, so
 *      killing a two-minute build mid-flight would be strictly worse than
 *      letting it finish and reporting the result. Anything longer than that
 *      must be started with `run_in_background: true`, which is unbounded.
 *
 * Single source of truth: the three timeout values are resolved from
 * `utils/timeouts.ts`, which reads `BASH_DEFAULT_TIMEOUT_MS` /
 * `BASH_MAX_FOREGROUND_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` from the
 * environment. An operator can therefore actually change them; the previous
 * hard-coded literals here silently ignored the env overrides that module
 * already implemented.
 */

import {
  getDefaultBashTimeoutMs,
  getMaxBashTimeoutMs,
  getMaxForegroundBashTimeoutMs,
} from '../../utils/timeouts.js';

/**
 * Default timeout when the model omits `timeout`. Restores the historical
 * 120s bound so interactive/blocking foreground commands (e.g. `lark-cli auth
 * login`) cannot hang forever. Background tasks are intentionally NOT bounded
 * by this constant.
 *
 * Override with the `BASH_DEFAULT_TIMEOUT_MS` env var.
 */
export const BASH_DEFAULT_TIMEOUT_MS = getDefaultBashTimeoutMs();

/**
 * Hard cap on the `timeout` field for FOREGROUND commands. The runtime will
 * also auto-promote foreground commands to a managed background task after
 * {@link BASH_SOFT_YIELD_MS} without restarting the process, so increasing
 * timeout beyond 5 minutes is almost always the wrong choice — opt into
 * `run_in_background: true` for longer commands instead.
 *
 * Override with the `BASH_MAX_FOREGROUND_TIMEOUT_MS` env var.
 */
export const BASH_MAX_FOREGROUND_TIMEOUT_MS = getMaxForegroundBashTimeoutMs();

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
 *
 * Override with the `BASH_MAX_TIMEOUT_MS` env var.
 */
export const BASH_MAX_TIMEOUT_MS = getMaxBashTimeoutMs();