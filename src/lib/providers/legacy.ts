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
  ApiFormat,
  LlmProvider,
  MaskedApiProvider,
  ProviderCategory,
  ProviderPreset,
} from './types';

/** Map a legacy `providerType` string to the new `apiFormat`. */
export function inferApiFormatFromLegacyProviderType(
  providerType: ApiProvider['providerType'],
): ApiFormat {
  switch (providerType) {
    case 'anthropic':
    case 'bedrock':
    case 'vertex':
      return 'anthropic';
    case 'openai':
    case 'openai-compatible':
    case 'openrouter':
    case 'google':
    case 'gemini-image':
      return 'openai-chat';
    case 'ollama':
      return 'ollama';
    default:
      // Defensive fallback. New entities must always declare apiFormat.
      return 'openai-chat';
  }
}

/** Map a legacy `providerType` string to a sensible default `ProviderCategory`. */
export function inferCategoryFromLegacyProviderType(
  providerType: ApiProvider['providerType'],
  baseUrl?: string,
): ProviderCategory {
  const url = (baseUrl || '').toLowerCase();
  // Local heuristic: localhost:11434 / 127.0.0.1:11434 -> local
  if (
    providerType === 'ollama'
    || url.includes('localhost:11434')
    || url.includes('127.0.0.1:11434')
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

  return {
    id: apiProvider.id,
    name: apiProvider.name,
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
