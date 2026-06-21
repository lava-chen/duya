const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
const MAX_TIMEOUT_MS = 600_000; // 10 minutes

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

export { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS };
