/**
 * src/lib/errors/extractErrorMessage.ts
 *
 * Single entry point for translating raw error / IPC response / fetch
 * rejection into a UI-safe `{code, message, hint}` triple.
 *
 * Design contract:
 * - NEVER includes secrets (apiKey, accessToken, Authorization headers).
 * - NEVER includes stack traces in production.
 * - All renderer components that display an error MUST funnel through
 *   this function before rendering. The shape is stable; UI can switch
 *   on `code` for icon / color / toast variant decisions.
 *
 * Plan 203 Phase 1.2 deliverable.
 *
 * This is the RENDERER-side error formatter. It is intentionally
 * separate from `electron/services/network/provider-usage.ts` error
 * helpers (which run in the Electron main process). They share the
 * `redactSecrets` strategy but the patterns they handle differ.
 * Plan 209 may promote a shared `@duya/errors` package.
 */

export interface NormalizedError {
  /** Stable, programmatic error code. Switch on this in the UI. */
  code: string;
  /** Human-readable message. SAFE TO RENDER. */
  message: string;
  /** Optional remediation hint. SAFE TO RENDER. */
  hint?: string;
}

/**
 * Substring patterns that indicate the input might contain a secret.
 * If the message contains one of these patterns followed by what
 * looks like a key, the entire value is replaced with `***`.
 *
 * This is intentionally conservative: we err on the side of
 * redaction to ensure no raw key ever reaches the UI.
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{12,}/g,        // OpenAI / Anthropic style
  /sk-ant-[A-Za-z0-9_-]{12,}/g,    // Anthropic explicit
  /sk-or-[A-Za-z0-9_-]{12,}/g,     // OpenRouter
  /sk-proj-[A-Za-z0-9_-]{12,}/g,   // Project-scoped OpenAI
  /ghp_[A-Za-z0-9]{16,}/g,         // GitHub PAT
  /gho_[A-Za-z0-9]{16,}/g,         // GitHub OAuth
  /github_pat_[A-Za-z0-9_]{16,}/g, // New GitHub PAT format
  /xai-[A-Za-z0-9]{16,}/g,         // xAI
  /AIza[A-Za-z0-9_-]{16,}/g,       // Google API key
  /AKIA[A-Z0-9]{12,}/g,            // AWS access key
  /ASIA[A-Z0-9]{12,}/g,            // AWS session key
  /ya29\.[A-Za-z0-9_-]{16,}/g,     // Google OAuth
  /Bearer\s+[A-Za-z0-9._-]{12,}/gi, // Bearer tokens
  /api[_-]?key["':= ]+[A-Za-z0-9._-]{8,}/gi, // generic "apiKey: xxx"
];

/** Redact probable secrets from a string. Idempotent. */
export function redactSecrets(input: string | undefined | null): string {
  if (!input) return '';
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => {
      // Try to keep a "label" prefix that is recognizable but
      // strictly bounded so a hostile payload can't smuggle UI
      // text into the redacted output. Allowed prefix shapes:
      //   - "sk-", "sk-ant-", "sk-or-", "sk-proj-" (vendor prefix)
      //   - "ghp_", "gho_", "github_pat_" (vendor prefix)
      //   - "xai-" (vendor prefix)
      //   - "AIza" (vendor prefix)
      //   - "AKIA", "ASIA" (vendor prefix)
      //   - "ya29." (vendor prefix)
      //   - "Bearer " (with space)
      //   - "apiKey ", "api_key ", "api-key ", "apikey " (label, no colon)
      //   - "\"apiKey\":\"", "\"api_key\":\"", "apikey:\"", "apiKey\":\"" (JSON form)
      const labelMatch = match.match(
        /^(sk-ant-|sk-or-|sk-proj-|sk-|ghp_|gho_|github_pat_|xai-|AIza|AKIA|ASIA|ya29\.|Bearer\s+|api[_-]?key["':= ]+|"api[_-]?key"[:= ]+)/i,
      );
      const prefix = labelMatch ? labelMatch[1] : '';
      return `${prefix}***`;
    });
  }
  return out;
}

/**
 * Extract a UI-safe error triple from any thrown value, IPC
 * response, or fetch rejection. Never throws; on any unexpected
 * input shape, returns the fallback.
 */
export function extractErrorMessage(
  e: unknown,
  fallback: NormalizedError = { code: 'unknown', message: 'Unknown error' },
): NormalizedError {
  if (!e) return fallback;
  if (typeof e === 'string') {
    return { code: 'raw', message: redactSecrets(e) };
  }
  if (typeof e !== 'object') {
    return fallback;
  }

  const obj = e as Record<string, unknown>;

  // Pattern 1: IPC `{ code, message, hint }` envelope (the renderer-side
  //   IPC handler convention).
  if (
    typeof obj.code === 'string'
    && typeof obj.message === 'string'
  ) {
    return {
      code: obj.code,
      message: redactSecrets(String(obj.message)),
      hint: typeof obj.hint === 'string' ? redactSecrets(obj.hint) : undefined,
    };
  }

  // Pattern 2: `Error` instance.
  if (obj instanceof Error) {
    return {
      code: 'thrown',
      message: redactSecrets(obj.message),
      hint: undefined,
    };
  }

  // Pattern 3: legacy `{ error: { code, message, suggestion? } }`
  //   (the old test-provider result shape).
  if (obj.error && typeof obj.error === 'object') {
    const inner = obj.error as Record<string, unknown>;
    if (
      typeof inner.code === 'string'
      && typeof inner.message === 'string'
    ) {
      return {
        code: inner.code,
        message: redactSecrets(String(inner.message)),
        hint: typeof inner.suggestion === 'string'
          ? redactSecrets(inner.suggestion)
          : undefined,
      };
    }
  }

  // Pattern 4: network rejection (`TypeError: Failed to fetch`).
  if (typeof obj.message === 'string') {
    return {
      code: 'network',
      message: redactSecrets(obj.message),
      hint: undefined,
    };
  }

  return fallback;
}
