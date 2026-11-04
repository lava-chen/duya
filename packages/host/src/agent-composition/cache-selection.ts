/**
 * Plan 624 — provider cache family selection.
 *
 * Today the Anthropic path is inferred inside `prompt-caching.ts` from the
 * base URL (`/anthropic` segment) while the OpenAI path has no cache key at
 * all. This resolver makes the family explicit at composition time so the
 * request builder stops guessing, and gives the OpenAI side a stable
 * per-session key.
 */
import type { CacheSelection, CacheSelectionInput, CompositionDecision, ProviderCacheFamily } from './contract.js';

/** OpenAI rejects prompt cache keys longer than this. */
export const MAX_PROMPT_CACHE_KEY_LENGTH = 64;

/** Breakpoint budget on the Anthropic-family path (`maxBreakpoints` today). */
export const ANTHROPIC_CACHE_BREAKPOINTS = 4;

function familyFor(input: CacheSelectionInput): ProviderCacheFamily {
  if (input.protocol === 'anthropic') return 'anthropic-messages';
  if (input.protocol === 'openai') {
    return input.api === 'responses' ? 'openai-responses' : 'openai-chat';
  }
  return 'none';
}

/**
 * Derive the cache key from the session id.
 *
 * Session ids are UUID-shaped and already unique, so the id itself is the key;
 * it is truncated only to satisfy the provider limit. A missing session id
 * yields no key rather than a shared constant — sharing a key across sessions
 * would make unrelated prefixes contend for the same cache entry.
 */
function promptCacheKeyFor(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  return sessionId.slice(0, MAX_PROMPT_CACHE_KEY_LENGTH);
}

export function resolveCacheSelection(input: CacheSelectionInput): CacheSelection {
  const family = familyFor(input);
  const decisions: CompositionDecision[] = [
    {
      field: 'cache.family',
      value: family,
      source: 'config',
      note: input.protocol === 'openai'
        ? `openai protocol, api=${input.api ?? 'unset'}`
        : `protocol=${input.protocol}`,
    },
  ];

  if (family === 'none') {
    return { family, cacheControlBreakpoints: 0, decisions };
  }

  if (family === 'anthropic-messages') {
    return {
      family,
      cacheControlBreakpoints: ANTHROPIC_CACHE_BREAKPOINTS,
      decisions: [
        ...decisions,
        {
          field: 'cache.breakpoints',
          value: String(ANTHROPIC_CACHE_BREAKPOINTS),
          source: 'host-default',
          note: 'budget only: the eligible/tool-definition decision stays in getPromptCachingCapability',
        },
      ],
    };
  }

  const promptCacheKey = promptCacheKeyFor(input.sessionId);
  if (promptCacheKey) {
    decisions.push({
      field: 'cache.promptCacheKey',
      value: promptCacheKey,
      source: 'config',
      note: `derived from the session id, clamped to ${MAX_PROMPT_CACHE_KEY_LENGTH} chars`,
    });
  } else {
    decisions.push({
      field: 'cache.promptCacheKey',
      value: '',
      source: 'host-default',
      note: 'no session id: no key is sent, rather than a shared constant',
    });
  }

  return {
    family,
    ...(promptCacheKey ? { promptCacheKey } : {}),
    cacheControlBreakpoints: 0,
    decisions,
  };
}
