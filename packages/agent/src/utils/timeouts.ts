const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
const MAX_TIMEOUT_MS = 600_000; // 10 minutes
const MAX_FOREGROUND_TIMEOUT_MS = 300_000; // 5 minutes

type EnvLike = Record<string, string | undefined>;

export function getDefaultBashTimeoutMs(env: EnvLike = process.env): number {
  const raw = env.BASH_DEFAULT_TIMEOUT_MS;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TIMEOUT_MS;
}

export function getMaxBashTimeoutMs(env: EnvLike = process.env): number {
  const raw = env.BASH_MAX_TIMEOUT_MS;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return Math.max(parsed, getDefaultBashTimeoutMs(env));
    }
  }
  return Math.max(MAX_TIMEOUT_MS, getDefaultBashTimeoutMs(env));
}

/**
 * Hard cap on the `timeout` field for FOREGROUND commands. Kept in step with
 * `getMaxBashTimeoutMs` so a raised default can never end up above the
 * foreground ceiling — which would make every foreground call fail
 * validation instead of just running longer.
 */
export function getMaxForegroundBashTimeoutMs(env: EnvLike = process.env): number {
  const raw = env.BASH_MAX_FOREGROUND_TIMEOUT_MS;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return Math.max(parsed, getDefaultBashTimeoutMs(env));
    }
  }
  return Math.max(MAX_FOREGROUND_TIMEOUT_MS, getDefaultBashTimeoutMs(env));
}

export { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MAX_FOREGROUND_TIMEOUT_MS };
