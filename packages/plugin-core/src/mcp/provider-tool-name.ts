// packages/plugin-core/src/mcp/provider-tool-name.ts
// Provider-policy-driven sanitization and uniqueness allocation for
// model-visible tool names. Two separate responsibilities, per Rev 5
// note 4: `sanitizeProviderToolName` only normalizes one internal key
// into a provider-conformant base; `allocateUniqueProviderToolName`
// ensures uniqueness against a set of already-used names.

import {
  MCP_INTERNAL_PREFIX,
  MCP_INTERNAL_SEP,
} from './scope';

/**
 * Per-provider tool-name constraints. The engine asks the active provider
 * for its policy; the policy tells it which chars are allowed and what
 * the maximum length is. New providers plug in here without engine
 * changes.
 */
export interface ProviderToolNamePolicy {
  /** Human-readable identifier (e.g. 'anthropic', 'openai', 'gemini'). */
  readonly id: string;
  /** Maximum length of the tool name field accepted by the provider. */
  readonly maxLength: number;
  /** Regex matching allowed characters (a single character class). */
  readonly allowedCharRegex: RegExp;
}

/** Default policy for Anthropic tool names. Empirical initial values. */
export const AnthropicToolNamePolicy: ProviderToolNamePolicy = {
  id: 'anthropic',
  maxLength: 64,
  // Anthropic tool names commonly allow ASCII letters, digits, '_' and '-'.
  allowedCharRegex: /[A-Za-z0-9_-]/,
};

/** Default policy for OpenAI function names. Empirical initial values. */
export const OpenAIToolNamePolicy: ProviderToolNamePolicy = {
  id: 'openai',
  maxLength: 64,
  // OpenAI function names commonly allow letters, digits, '_' and '-'.
  allowedCharRegex: /[A-Za-z0-9_-]/,
};

/**
 * Build a stable, short (6 hex chars) hash of a string. Used when suffixing
 * a sanitized tool name would otherwise exceed `policy.maxLength` —
 * the truncated base is re-suffixed with this hash so the result is
 * still a stable, recognizable function of the input.
 *
 * Uses FNV-1a 32-bit, output formatted as 6 lowercase hex chars. Pure
 * function; no crypto, no randomness. Same input always yields the same
 * hash; the small output space is acceptable for collision suffixing
 * because allocation also re-checks `usedNames`.
 */
export function shortStableHash(input: string): string {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Equivalent of (hash * 0x01000193) mod 2^32, kept inside 32-bit range.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, 6);
}

/**
 * Strip the in-process `mcp__` prefix and the `__<toolName>` suffix from
 * an internal key, returning just the scoped server name. The internal
 * key shape is enforced: callers are not expected to fabricate inputs.
 *
 *   stripInternalKey('mcp__plugin:com.duya.lit:literature__add_source')
 *     === 'plugin:com.duya.lit:literature'
 *
 * If the input is not a well-formed internal key, it is returned
 * unchanged (best effort).
 */
function stripInternalKey(internalKey: string): string {
  if (!internalKey.startsWith(MCP_INTERNAL_PREFIX)) return internalKey;
  const rest = internalKey.slice(MCP_INTERNAL_PREFIX.length);
  const sep = rest.lastIndexOf(MCP_INTERNAL_SEP);
  if (sep <= 0) return rest;
  return rest.slice(0, sep);
}

/**
 * Replace any character not allowed by `policy.allowedCharRegex` with
 * `_`, and collapse runs of consecutive `_` down to a single `_`. The
 * result is also trimmed of leading/trailing `_`. No truncation is
 * applied here — use `allocateUniqueProviderToolName` for length
 * handling and uniqueness.
 */
export function sanitizeProviderToolName(
  internalKey: string,
  policy: ProviderToolNamePolicy,
): string {
  const scoped = stripInternalKey(internalKey);
  let out = '';
  let lastWasUnderscore = false;
  for (const ch of scoped) {
    if (policy.allowedCharRegex.test(ch)) {
      out += ch;
      lastWasUnderscore = false;
    } else if (!lastWasUnderscore) {
      out += '_';
      lastWasUnderscore = true;
    }
  }
  // Trim leading/trailing underscores to keep names clean.
  return out.replace(/^_+|_+$/g, '');
}

/**
 * Truncate `baseName` to fit within `policy.maxLength` while appending a
 * stable hash suffix. The result is guaranteed to be at most
 * `policy.maxLength` chars and remains a deterministic function of
 * `baseName`. Used as a fallback by `allocateUniqueProviderToolName`
 * when plain suffixing would overflow the length limit.
 */
function truncateWithHash(baseName: string, policy: ProviderToolNamePolicy): string {
  const hash = shortStableHash(baseName);
  // Reserve 7 chars for '_' + 6-char hash.
  const keep = policy.maxLength - 7;
  if (keep <= 0) return hash.slice(0, policy.maxLength);
  return `${baseName.slice(0, keep)}_${hash}`;
}

/**
 * Ensure `baseName` is not in `usedNames`. If it is, append `__2`,
 * `__3`, ... until a free slot is found. If appending would exceed
 * `policy.maxLength`, fall back to a stable hash-suffixed truncated
 * form of the candidate. The function never overwrites an existing
 * entry; the caller is expected to add the returned name to `usedNames`
 * after accepting it.
 *
 * Pure: does not mutate `usedNames`.
 */
export function allocateUniqueProviderToolName(
  baseName: string,
  usedNames: ReadonlySet<string> | ReadonlyMap<string, unknown>,
  policy: ProviderToolNamePolicy,
): string {
  const contains = (s: string): boolean =>
    usedNames instanceof Set ? usedNames.has(s) : usedNames.has(s);

  if (!contains(baseName)) {
    if (baseName.length <= policy.maxLength) return baseName;
    return truncateWithHash(baseName, policy);
  }

  // baseName is taken; try baseName__2, baseName__3, ...
  let n = 2;
  // Bound the loop: if we somehow iterate beyond a sane count, fall
  // through to the hash path rather than spinning.
  const MAX_TRIES = 1024;
  while (n <= MAX_TRIES) {
    const candidate = `${baseName}__${n}`;
    if (!contains(candidate)) {
      if (candidate.length <= policy.maxLength) return candidate;
      return truncateWithHash(candidate, policy);
    }
    n++;
  }
  // Pathological case: fall back to a hash-suffixed form of the original.
  return truncateWithHash(`${baseName}__${MAX_TRIES + 1}`, policy);
}

// ============================================================================
// Phase 2A Batch A: high-level MCP tool-name allocator
// ============================================================================
//
// `computeProviderName` is the single entry point the runtime uses to
// turn an internal MCP key into a model-visible name. It:
//   1) strips only the `mcp__` internal prefix (keeping the
//      scoped server name AND the tool name — `stripInternalKey`
//      used by `sanitizeProviderToolName` is too aggressive: it
//      also drops the tool name, which is the very thing that
//      distinguishes two tools from different servers exposing
//      the same tool name),
//   2) sanitizes disallowed characters via `sanitizeProviderToolName`
//      (with the private `stripInternalKey` short-circuited, since
//      we already stripped the prefix),
//   3) prepends a `mcp_` provider-visible prefix (MCP sources are
//      guaranteed to be prefixed so they cannot collide with builtin
//      tool names like `Bash` or `Read`),
//   4) ensures global uniqueness via `allocateUniqueProviderToolName`,
//      honoring `policy.maxLength` and falling back to a stable
//      hash-suffixed form when plain suffixing would overflow.
//
// The function is pure: it does not mutate `usedNames`. Callers are
// expected to add the returned name to `usedNames` after accepting
// it, so subsequent calls in a batch see the just-allocated name.
//
// `usedNames` is intentionally NOT pre-populated with currently
// active MCP provider names — full-replace (Batch C) removes them
// before computing next-state names, and including them would cause
// drift to `__2` on every repeated reload.

/**
 * The provider-visible prefix that every MCP-derived tool name carries.
 * Distinct from the internal `mcp__` prefix (double underscore,
 * internal-only) so model-facing strings stay readable and so MCP
 * names can never accidentally collide with builtin names like
 * `Bash` that share no leading characters.
 */
export const MCP_PROVIDER_PREFIX = 'mcp_';

/**
 * Compute a model-visible, globally-unique provider name for an MCP
 * tool given its internal key. Pure: does not mutate `usedNames`.
 *
 * @param internalKey MCP internal key, shape
 *   `mcp__<scopedServerName>__<toolName>`. The `mcp__` prefix is
 *   stripped before sanitization; both the scoped server name AND
 *   the tool name are retained so two servers exposing the same
 *   tool name produce distinct provider names.
 * @param usedNames Names already allocated in this apply pass
 *   (typically: builtin tool names + mode-specific non-MCP names).
 *   The returned name is guaranteed not to be in this set.
 * @param policy Provider policy (Anthropic / OpenAI / etc.).
 * @returns A provider-visible name starting with `mcp_`, fitting
 *   `policy.maxLength`, matching `policy.allowedCharRegex` on every
 *   char, and unique within `usedNames`.
 */
export function computeProviderName(
  internalKey: string,
  usedNames: ReadonlySet<string>,
  policy: ProviderToolNamePolicy,
): string {
  // 1) Strip only the internal `mcp__` prefix. If the input does
  //    not have the prefix, we still treat it as a raw internal key
  //    (defensive — this should not happen for MCP-sourced keys).
  const stripped = internalKey.startsWith(MCP_INTERNAL_PREFIX)
    ? internalKey.slice(MCP_INTERNAL_PREFIX.length)
    : internalKey;

  // 2) Sanitize disallowed characters. We invoke the inner loop
  //    directly (not the public `sanitizeProviderToolName`) because
  //    that function calls `stripInternalKey` which would also drop
  //    the tool-name suffix — losing the per-tool granularity we
  //    need here.
  const sanitized = sanitizeRawSegment(stripped, policy);

  // 3) Prepend the provider-visible `mcp_` prefix. This guarantees
  //    the result is distinct from any builtin tool name that does
  //    not start with `mcp_`.
  const base = `${MCP_PROVIDER_PREFIX}${sanitized}`;

  // 4) Ensure global uniqueness within the apply pass. Length
  //    handling and hash fallback are owned by
  //    `allocateUniqueProviderToolName`.
  return allocateUniqueProviderToolName(base, usedNames, policy);
}

/**
 * Sanitize a raw string segment (already with `mcp__` prefix
 * stripped) into a provider-conformant base. Mirrors the character
 * handling of `sanitizeProviderToolName` but:
 *   1) skips the second `stripInternalKey` call so the tool-name
 *      suffix survives,
 *   2) collapses ANY run of two or more consecutive underscores
 *      down to a single underscore (the public helper only
 *      collapses runs introduced by character substitution, not
 *      underscores that were already in the input).
 *
 * The latter is important: an internal key like
 * `mcp__plugin:com.duya.literature:literature__add_source` contains
 * both `:` (replaced to `_`) and a literal `__` separator. Without
 * aggressive collapsing the sanitized form would carry
 * `...literature__add_source` (two underscores between the
 * scoped server name and the tool name) instead of the cleaner
 * `...literature_add_source`.
 *
 * Phase 2A Batch A: private helper, exported for unit tests but
 * not part of the public surface.
 */
export function sanitizeRawSegment(
  segment: string,
  policy: ProviderToolNamePolicy,
): string {
  let out = '';
  let lastWasUnderscore = false;
  for (const ch of segment) {
    if (policy.allowedCharRegex.test(ch)) {
      out += ch;
      lastWasUnderscore = false;
    } else if (!lastWasUnderscore) {
      out += '_';
      lastWasUnderscore = true;
    }
    // else: the previous char was already a substituted underscore;
    // skip this disallowed char.
  }
  // Aggressively collapse ANY remaining run of `__` (including
  // literal-underscore runs that were in the input) down to a
  // single underscore.
  return out.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}
