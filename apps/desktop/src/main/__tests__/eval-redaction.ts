/**
 * eval-redaction.ts — what a captured artifact is allowed to contain.
 *
 * ## Why this exists separately
 *
 * The eval artifacts are written to disk, where they outlive the process and
 * get read by people and diffed by CI. A transcript of a real run contains the
 * prompt, the tool inputs, and — if a case is ever pointed at a configured
 * provider — the credential. So redaction is a policy applied at the boundary
 * where a value enters an artifact, not a thing each call site remembers to do.
 *
 * ## What it is
 *
 * A deliberately conservative superset of `@duya/ai`'s own `redactSecrets`
 * (which handles the `Bearer` / `x-api-key` / `authorization` / `api_key`
 * shapes on free text). This adds the case this harness actually creates:
 *
 *  - `sk-`-prefixed OpenAI/Anthropic-style keys, which appear in the eval's own
 *    `providerConfig.apiKey` and in a `baseURL` query string;
 *  - UUIDs and long hex digests, which are noise in a diff rather than
 *    sensitive, and are what the NORMALISER collapses.
 * Structural keys (`apiKey`, `authorization`, …) are blanked by name before
 * the text pass runs, so a secret that does not match any pattern still cannot
 * reach the artifact through a field the caller did not redact.
 *
 * Note what is NOT redacted: prompts and tool inputs. They are the substance of
 * the artifact, and this harness's cases are synthetic by construction — a real
 * user's transcript is not something an eval suite should be able to write to
 * disk in the first place.
 */

/** Field names whose VALUE is replaced wholesale, whatever it contains. */
const SENSITIVE_KEY = /^(api[_-]?key|apikey|authorization|auth[_-]?token|access[_-]?token|auth|secret|password|credential|credentials|bearer|session[_-]?cookie|cookie)$/i;

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Authorization headers and bearer tokens in free text.
  [/\b(Bearer\s+)[A-Za-z0-9._\-/+=]{8,}/g, '$1[REDACTED]'],
  // Anthropic-style and OpenAI-style keys wherever they appear.
  [/\bsk-[A-Za-z0-9._\-]{8,}/g, 'sk-[REDACTED]'],
  // `x-api-key: …` / `"apiKey": "…"` in serialised text.
  [/(x-api-key["']?\s*[:=]\s*["']?)[A-Za-z0-9._\-/+=]{8,}/gi, '$1[REDACTED]'],
  [/(authorization["']?\s*[:=]\s*["']?)[A-Za-z0-9._\-/+=]{8,}/gi, '$1[REDACTED]'],
  [/((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)["']?\s*[:=]\s*["']?)[A-Za-z0-9._\-/+=]{8,}/gi, '$1[REDACTED]'],
  // Credentials embedded in a URL query string.
  [/([?&](?:key|api_key|token|access_token)=)[^&\s"']+/gi, '$1[REDACTED]'],
];

/** Redact secrets from a free-text value. Never throws, never returns null. */
export function redactSecrets(input: string | null | undefined): string {
  if (input === null || input === undefined) return '';
  let out = input;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Redact an arbitrary JSON-shaped value.
 *
 * A key whose NAME is sensitive is replaced wholesale; every other string is
 * passed through the text patterns. Order matters — the structural pass runs
 * first, so a value that would not match any pattern is still blanked.
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactValue(inner);
    }
    return out;
  }
  return value;
}

/** True when a value would be changed by {@link redactValue}. */
export function containsSecret(value: unknown): boolean {
  return JSON.stringify(redactValue(value)) !== JSON.stringify(value);
}
