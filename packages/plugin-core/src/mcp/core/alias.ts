// packages/plugin-core/src/mcp/core/alias.ts
// Plan 580 D7 — stable connection slug + tool-alias allocation.
//
// Two identities must survive connection-set churn:
//   1) `connection_slug` — a short, deterministic, PERSISTED tag derived
//      from the connectionId at creation time (fnv1a 4-hex, collision →
//      6-hex). Never recomputed after creation, so cache keys, historical
//      sessions, and schema promotions stay valid when a second account
//      for the same provider is added later.
//   2) the model-visible tool alias — `remote_<namespace>_<tool>` where
//      `<namespace>` is the bare provider id for the provider's FIRST
//      connection (held for life) and `provider:<slug>` for every later
//      one. Full UUIDs never reach the model.

import { shortStableHash } from '../provider-tool-name.js';

/** Full 32-bit FNV-1a hash as 8 lowercase hex chars. */
export function fnv1a32Hex(input: string): string {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const SLUG_SHORT_LEN = 4;
const SLUG_LONG_LEN = 6;

/**
 * Derive the persisted `connection_slug` for a new connection.
 * Deterministic: same connectionId + same taken-set → same slug.
 * Collision handling: 4-hex → 6-hex → salted retries with growing
 * width (astronomically unlikely to be reached).
 */
export function deriveConnectionSlug(connectionId: string, takenSlugs: ReadonlySet<string>): string {
  const full = fnv1a32Hex(connectionId);
  const short = full.slice(0, SLUG_SHORT_LEN);
  if (!takenSlugs.has(short)) return short;
  const long = full.slice(0, SLUG_LONG_LEN);
  if (!takenSlugs.has(long)) return long;
  for (let salt = 1; salt < 64; salt++) {
    const candidate = fnv1a32Hex(`${connectionId}:${salt}`).slice(0, SLUG_LONG_LEN);
    if (!takenSlugs.has(candidate)) return candidate;
  }
  // Last resort: full 8-hex hash (collision practically impossible).
  let n = 64;
  while (true) {
    const candidate = fnv1a32Hex(`${connectionId}:${n}`);
    if (!takenSlugs.has(candidate)) return candidate;
    n++;
  }
}

/**
 * Namespace for a connection: the first (slug === '') connection of a
 * provider holds the bare provider namespace for life; later ones get
 * `provider:<slug>`. The model never sees a full UUID.
 */
export function connectionNamespace(provider: string, slug: string): string {
  return slug === '' ? provider : `${provider}:${slug}`;
}

/** Model-visible alias length policy (Anthropic / OpenAI both cap at 64). */
export const CONNECTION_TOOL_ALIAS_MAX_LENGTH = 64;

/**
 * Sanitize the alias base exactly like the pre-plan-580 chain B
 * `toolAlias` (`remote-mcp.ts:68-70`): replace every char outside
 * `[A-Za-z0-9_-]` with `_`. No run-collapsing — byte-stability for
 * existing single-account deployments depends on this.
 */
function sanitizeAliasBase(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Stable hash-suffixed truncated form fitting `maxLength` (computeProviderName semantics). */
function truncateWithHash(base: string, maxLength: number): string {
  const hash = shortStableHash(base);
  const keep = maxLength - 7; // '_' + 6-char hash
  if (keep <= 0) return hash.slice(0, maxLength);
  return `${base.slice(0, keep)}_${hash}`;
}

/**
 * Allocate a unique model-visible alias for a connection tool.
 *
 *   base = `remote_<namespace>_<toolName>` (sanitized)
 *   - over-length → truncate + '_' + 6-hex stable hash,
 *   - taken → `__2`, `__3`, ... suffix (hash fallback on overflow).
 *
 * Pure: does not mutate `usedNames`; the caller adds the returned name
 * to the set after accepting it.
 */
export function allocateConnectionToolAlias(
  namespace: string,
  toolName: string,
  usedNames: ReadonlySet<string>,
  maxLength: number = CONNECTION_TOOL_ALIAS_MAX_LENGTH,
): string {
  const base = sanitizeAliasBase(`remote_${namespace}_${toolName}`);

  if (!usedNames.has(base)) {
    if (base.length <= maxLength) return base;
    const hashed = truncateWithHash(base, maxLength);
    if (!usedNames.has(hashed)) return hashed;
    return suffixUntilFree(hashed, usedNames, maxLength);
  }
  return suffixUntilFree(base, usedNames, maxLength);
}

function suffixUntilFree(base: string, usedNames: ReadonlySet<string>, maxLength: number): string {
  let n = 2;
  const MAX_TRIES = 1024;
  while (n <= MAX_TRIES) {
    const candidate = `${base}__${n}`;
    if (!usedNames.has(candidate)) {
      if (candidate.length <= maxLength) return candidate;
      const hashed = truncateWithHash(candidate, maxLength);
      if (!usedNames.has(hashed)) return hashed;
    }
    n++;
  }
  return truncateWithHash(`${base}__${MAX_TRIES + 1}`, maxLength);
}
