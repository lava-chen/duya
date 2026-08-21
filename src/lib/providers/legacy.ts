/**
 * src/lib/providers/legacy.ts
 *
 * Legacy ApiProvider compatibility and migration layer.
 *
 * - `migrateLegacyApiProvider(apiProvider)` -> LlmProvider
 * - `toLegacyApiProvider(llmProvider)`        -> ApiProvider
 * - `maskApiProvider(apiProvider)`            -> MaskedApiProvider (renderer DTO)
 * - `inferApiFormatFromLegacyProviderType(providerType)` -> ApiFormat
 * - `inferCategoryFromLegacyProviderType(providerType)`  -> ProviderCategory
 *
 * This module is the ONLY place that knows about the legacy providerType enum.
 * New code MUST go through LlmProvider and use apiFormat / category instead.
 *
 * The migration is lossless by design: any field that does not map cleanly
 * is preserved in `options` or `extraEnv` so the round-trip back to legacy
 * yields the original payload (modulo field renaming).
 */

import type {
  ApiProvider,
  LlmProvider,
  MaskedApiProvider,
  ProviderCategory,
  ProviderPreset,
} from './types';
import type { ModelCompat, ApiFormat } from '@duya/ai';
import { inferApiFormatFromLegacyProviderType } from '@duya/ai';

export { inferApiFormatFromLegacyProviderType };

/** Map a legacy `providerType` string to a sensible default `ProviderCategory`. */
export function inferCategoryFromLegacyProviderType(
  providerType: ApiProvider['providerType'],
  baseUrl?: string,
): ProviderCategory {
  const url = (baseUrl || '').toLowerCase();
  // Local heuristic: localhost:11434 (Ollama) / 127.0.0.1:11434 / localhost:1234 (LM Studio) -> local
  if (
    providerType === 'ollama'
    || url.includes('localhost:11434')
    || url.includes('127.0.0.1:11434')
    || url.includes('localhost:1234')
    || url.includes('127.0.0.1:1234')
  ) {
    return 'local';
  }
  if (providerType === 'openrouter') return 'aggregator';
  if (
    providerType === 'anthropic'
    || providerType === 'openai'
    || providerType === 'google'
    || providerType === 'bedrock'
    || providerType === 'vertex'
  ) {
    return 'official';
  }
  // openai-compatible / gemini-image / unknown -> custom
  return 'custom';
}

/**
 * Whether a provider is a local / keyless OpenAI-compatible runtime that
 * does NOT need an API key to function (Ollama / LM Studio).
 *
 * IMPORTANT: the catalog's LM Studio preset saves `legacyProtocol =
 * 'openai-compatible'` (not `'lm-studio'`) as the actual `providerType`,
 * so the ONLY reliable discriminator at runtime is the baseUrl port. We
 * intentionally do NOT special-case `providerType === 'lm-studio'`: that
 * value is a preset key, never a persisted providerType. Trying to
 * match it in `inferCategoryFromLegacyProviderType` previously broke the
 * TS compiler because `ApiProvider['providerType']` is a closed union.
 *
 * Used by chat-side filters (MessageInput / NewChatView / WelcomeView)
 * that previously hard-coded `providerType === 'ollama'` and silently
 * dropped LM Studio models from the input dropdown. Mirrors openclaw's
 * `LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER` convention — duya injects
 * `OPENAI_API_KEY='lm-studio'` from the catalog's `envOverrides`, so the
 * actual request goes out with a non-empty placeholder header; this
 * helper is for UI gating only.
 */
export function isKeylessLocalProvider(
  providerType: string | undefined | null,
  baseUrl?: string,
): boolean {
  if (providerType === 'ollama') return true;
  const url = (baseUrl || '').toLowerCase();
  if (!url) return false;
  return (
    url.includes('localhost:11434')
    || url.includes('127.0.0.1:11434')
    || url.includes('0.0.0.0:11434')
    || url.includes('localhost:1234')
    || url.includes('127.0.0.1:1234')
    || url.includes('0.0.0.0:1234')
  );
}

/**
 * Migrate a legacy `ApiProvider` into the new `LlmProvider` shape.
 * - `providerType` -> `apiFormat` (via inferApiFormatFromLegacyProviderType)
 * - `providerType` -> `category` (via inferCategoryFromLegacyProviderType)
 * - `baseUrl` -> `endpoints.baseUrl`
 * - `apiKey` -> `auth.apiKey`
 * - `headers` -> top-level `headers`
 * - `options` -> top-level `options`
 * - `extraEnv` -> top-level `extraEnv`
 * - `notes` -> `meta.notes`
 * - `sortOrder` -> `meta.sortIndex`
 * - `isActive` is NOT preserved on LlmProvider; active state is owned by
 *   `LlmProviderService.setActiveProvider()`. We surface it in `tags`
 *   so it round-trips back.
 * - `createdAt`/`updatedAt` default to migration time when missing.
 */
export function migrateLegacyApiProvider(
  apiProvider: ApiProvider,
  now: number = Date.now(),
): LlmProvider {
  const apiFormat = inferApiFormatFromLegacyProviderType(apiProvider.providerType);
  const category = inferCategoryFromLegacyProviderType(
    apiProvider.providerType,
    apiProvider.baseUrl,
  );

  const tags: string[] = [];
  if (apiProvider.isActive) tags.push('active');

  const baseUrl = (apiProvider.baseUrl || '').trim();
  const authType: LlmProvider['auth']['type'] =
    apiFormat === 'ollama' ? 'none' : 'api-key';

  // Plan 7.3: promote `options.compatOverrides` to the top-level
  // `compatOverrides` field so `toRuntimeConfig` can read it
  // directly. Keep it inside `options` too so the legacy
  // `options_json` storage layer round-trips it back unchanged.
  const compatOverrides = apiProvider.options?.compatOverrides as
    | ModelCompat
    | undefined;

  return {
    id: apiProvider.id,
    name: apiProvider.name,
    alias: apiProvider.alias,
    category,
    apiFormat,
    auth: {
      type: authType,
      apiKey: apiProvider.apiKey,
      apiKeyField: defaultApiKeyField(apiFormat),
    },
    endpoints: {
      baseUrl,
      isFullUrl: false,
    },
    ui: {},
    meta: {
      createdAt: now,
      updatedAt: now,
      sortIndex: apiProvider.sortOrder ?? 0,
      notes: apiProvider.notes,
      tags: tags.length > 0 ? tags : undefined,
    },
    headers: apiProvider.headers,
    options: apiProvider.options,
    extraEnv: apiProvider.extraEnv,
    compatOverrides,
  };
}

/** Best-effort env-style field name for each apiFormat. */
export function defaultApiKeyField(apiFormat: ApiFormat): string | undefined {
  switch (apiFormat) {
    case 'anthropic':
      return 'ANTHROPIC_AUTH_TOKEN';
    case 'openai-chat':
    case 'openai-responses':
      return 'OPENAI_API_KEY';
    case 'gemini':
      return 'GEMINI_API_KEY';
    case 'ollama':
      return undefined;
    case 'bedrock':
      return 'AWS_BEARER_TOKEN_BEDROCK';
    case 'vertex':
      return 'GOOGLE_APPLICATION_CREDENTIALS';
    default:
      return undefined;
  }
}

/** Round-trip an LlmProvider back to a legacy ApiProvider.
 *  Used by the legacy IPC layer that still speaks ApiProvider. */
export function toLegacyApiProvider(provider: LlmProvider): ApiProvider {
  const legacyProtocol = providerToLegacyProtocol(provider);
  const extraEnv = provider.extraEnv ?? {};
  const isActive = provider.meta.tags?.includes('active') ?? false;
  return {
    id: provider.id,
    name: provider.name,
    alias: provider.alias,
    providerType: legacyProtocol,
    baseUrl: provider.endpoints.baseUrl,
    apiKey: provider.auth.apiKey ?? '',
    isActive,
    extraEnv,
    headers: provider.headers,
    options: provider.options,
    notes: provider.meta.notes,
    sortOrder: provider.meta.sortIndex,
  };
}

/** Derive a legacy `providerType` from the new fields. Best-effort. */
function providerToLegacyProtocol(provider: LlmProvider): ApiProvider['providerType'] {
  switch (provider.apiFormat) {
    case 'anthropic':
      return 'anthropic';
    case 'ollama':
      return 'ollama';
    case 'openai-chat':
    case 'openai-responses':
      // Disambiguate by category and baseUrl.
      if (provider.category === 'aggregator') return 'openrouter';
      if (provider.category === 'official') {
        const url = provider.endpoints.baseUrl.toLowerCase();
        if (url.includes('api.openai.com')) return 'openai';
        if (url.includes('googleapis') || url.includes('google')) return 'google';
        return 'openai';
      }
      return 'openai-compatible';
    case 'gemini':
      return 'google';
    case 'bedrock':
      return 'bedrock';
    case 'vertex':
      return 'vertex';
    default:
      return 'openai-compatible';
  }
}

/** Mask the secret for the renderer. The shape mirrors the existing
 *  agent-communicator.ts maskProvider() so it can be used as a drop-in. */
export function maskApiProvider(provider: ApiProvider): MaskedApiProvider {
  const key = provider.apiKey;
  const hasKey = !!key && key.length > 0;
  const maskedKey = hasKey
    ? key.length > 8
      ? key.slice(0, 4) + '***' + key.slice(-4)
      : '***'
    : '';

  return {
    id: provider.id,
    name: provider.name,
    alias: provider.alias,
    providerType: provider.providerType,
    baseUrl: provider.baseUrl ?? '',
    apiKey: maskedKey,
    isActive: provider.isActive,
    hasApiKey: hasKey,
    sortOrder: provider.sortOrder ?? 0,
    extraEnv: JSON.stringify(provider.extraEnv ?? {}),
    protocol: provider.providerType,
    headers: JSON.stringify(provider.headers ?? {}),
    options: JSON.stringify(provider.options ?? {}),
    notes: provider.notes ?? '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** Convenience: build an LlmProvider draft from a preset + user input. */
export function buildLlmProviderFromPreset(
  preset: ProviderPreset,
  values: {
    id: string;
    name: string;
    apiKey?: string;
    baseUrl?: string;
    options?: Record<string, unknown>;
  },
  now: number = Date.now(),
): LlmProvider {
  const baseUrl = (values.baseUrl ?? preset.defaultEndpoint ?? '').trim();
  const auth: LlmProvider['auth'] = preset.authFields.some((f) => f.secret)
    ? { type: 'api-key', apiKey: values.apiKey, apiKeyField: defaultApiKeyField(preset.apiFormat) }
    : { type: 'none' };

  return {
    id: values.id,
    name: values.name,
    category: preset.category,
    apiFormat: preset.apiFormat,
    auth,
    endpoints: {
      baseUrl,
      endpointCandidates: preset.endpointCandidates,
      isFullUrl: false,
    },
    ui: { ...preset.ui },
    meta: {
      createdAt: now,
      updatedAt: now,
      sortIndex: 0,
    },
    options: values.options,
  };
}
