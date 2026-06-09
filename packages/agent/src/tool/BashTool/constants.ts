/**
 * Shared BashTool execution limits.
 *
 * Keep prompt, schema, foreground execution, and worker execution aligned so
 * the model sees the same contract the runtime enforces.
 */
export const BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const BASH_MAX_TIMEOUT_MS = 600_000;
