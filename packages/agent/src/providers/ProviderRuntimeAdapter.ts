/**
 * packages/agent/src/providers/ProviderRuntimeAdapter.ts
 *
 * Adapter: build a `ProviderRuntimeConfig` for the agent runtime.
 *
 * This module is the single boundary that consumes a *legacy* `ApiProvider`
 * (still produced by `electron/config/manager.ts` and forwarded through the
 * MessagePort) and produces the new `ProviderRuntimeConfig` consumed by
 * `packages/agent/src/llm/*`.
 *
 * It also accepts a domain `LlmProvider`-shaped object so the renderer /
 * electron-main paths can later switch to it without touching the runtime.
 *
 * IMPORTANT: secrets are never written to logs. All error messages are
 * run through `redactSecrets()`.
 */

import type {
  ProviderRuntimeConfig,
  RuntimeApiFormat,
  RuntimeAuthStyle,
  RuntimeModelCapability,
} from './runtime-types.js';

// =============================================================================
// Local mirror of the legacy ApiProvider
// =============================================================================
//
// We do not import the type from `@/lib/providers` to avoid a cross-package
// hard link from the agent package to the renderer. The shape is verified
// against `electron/config/manager.ts` (kept in sync manually).

export type LegacyProviderType =
  | 'anthropic'
  | 'openai'
  | 'ollama'
  | 'openai-compatible'
  | 'openrouter'
  | 'bedrock'
  | 'vertex'
  | 'gemini-image'
  | 'google';

export interface LegacyApiProvider {
  id: string;
  name: string;
  providerType: LegacyProviderType;
  baseUrl: string;
  apiKey: string;
  isActive: boolean;
  extraEnv?: Record<string, string>;
  headers?: Record<string, string>;
  options?: Record<string, unknown>;
  notes?: string;
  sortOrder?: number;
}

// =============================================================================
// Domain mirror of LlmProvider (subset sufficient for runtime config)
// =============================================================================

export interface LlmProviderDomain {
  id: string;
  name: string;
  apiFormat: RuntimeApiFormat;
  auth: {
    type: 'api-key' | 'bearer' | 'oauth' | 'none';
    apiKey?: string;
    accessToken?: string;
    apiKeyField?: string;
  };
  endpoints: { baseUrl: string };
  headers?: Record<string, string>;
  options?: Record<string, unknown>;
  extraEnv?: Record<string, string>;
}

// =============================================================================
// Pure helpers (testable without electron)
// =============================================================================

const PROTOCOL_TO_LLM: Record<RuntimeApiFormat, 'anthropic' | 'openai' | 'ollama'> = {
  'openai-chat': 'openai',
  'openai-responses': 'openai',
  anthropic: 'anthropic',
  gemini: 'openai',
  ollama: 'ollama',
  bedrock: 'anthropic',
  vertex: 'anthropic',
};

export function toLegacyLlmProviderDiscriminator(
  apiFormat: RuntimeApiFormat,
): 'anthropic' | 'openai' | 'ollama' {
  return PROTOCOL_TO_LLM[apiFormat] ?? 'openai';
}

export function inferApiFormatFromLegacyProviderType(
  providerType: LegacyProviderType,
): RuntimeApiFormat {
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
      return 'openai-chat';
  }
}

export function inferAuthStyle(
  apiFormat: RuntimeApiFormat,
  legacyProviderType: LegacyProviderType | undefined,
  apiKeyField: string | undefined,
): RuntimeAuthStyle {
  if (apiFormat === 'ollama') return 'none';
  if (legacyProviderType === 'openrouter') return 'bearer';
  if (apiFormat === 'anthropic' && apiKeyField === 'ANTHROPIC_AUTH_TOKEN') {
    return 'auth_token';
  }
  if (apiFormat === 'anthropic' || apiFormat === 'bedrock' || apiFormat === 'vertex') {
    return 'api_key';
  }
  return 'bearer';
}

export function normalizeBaseUrl(url: string | undefined): string {
  if (!url) return '';
  return url.replace(/\/+$/, '');
}

export function buildHeaders(
  apiFormat: RuntimeApiFormat,
  apiKey: string,
  baseHeaders: Record<string, string> | undefined,
  authStyle: RuntimeAuthStyle,
): Record<string, string> {
  const headers: Record<string, string> = { ...(baseHeaders ?? {}) };
  headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';

  if (apiFormat === 'ollama' || authStyle === 'none') return headers;

  if (apiFormat === 'anthropic' || apiFormat === 'bedrock' || apiFormat === 'vertex') {
    if (authStyle === 'auth_token' || authStyle === 'bearer') {
      headers['Authorization'] = `Bearer ${apiKey}`;
    } else {
      headers['x-api-key'] = apiKey;
    }
    headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01';
  } else if (apiFormat === 'gemini') {
    headers['x-goog-api-key'] = apiKey;
  } else {
    // openai-chat / openai-responses
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

// =============================================================================
// Redaction (mirror of renderer's implementation; kept local to avoid deps)
// =============================================================================

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(Bearer\s+)[A-Za-z0-9._\-+/=]{8,}/g, '$1[REDACTED]'],
  [/(x-api-key["']?\s*[:=]\s*["']?)[A-Za-z0-9._\-+/=]{8,}/gi, '$1[REDACTED]'],
  [/(authorization["']?\s*[:=]\s*["']?)[A-Za-z0-9._\-+/=]{8,}/gi, '$1[REDACTED]'],
  [/((?:api[_-]?key|access[_-]?token)["']?\s*[:=]\s*["']?)[A-Za-z0-9._\-+/=]{8,}/gi, '$1[REDACTED]'],
];

export function redactSecrets(input: string | undefined | null): string {
  if (!input) return '';
  let out = input;
  for (const [re, repl] of SECRET_PATTERNS) {
    out = out.replace(re, repl);
  }
  return out;
}

// =============================================================================
// Build runtime config
// =============================================================================

export interface BuildOptions {
  modelId: string;
  capabilities?: RuntimeModelCapability;
  extraHeaders?: Record<string, string>;
  extraOptions?: Record<string, unknown>;
}

/** Build a runtime config from a legacy ApiProvider (the current IPC shape). */
export function toRuntimeConfig(
  apiProvider: LegacyApiProvider,
  options: BuildOptions,
): ProviderRuntimeConfig {
  const apiFormat = inferApiFormatFromLegacyProviderType(apiProvider.providerType);
  const authStyle = inferAuthStyle(apiFormat, apiProvider.providerType, undefined);
  return toRuntimeConfigFromDomain(
    {
      id: apiProvider.id,
      name: apiProvider.name,
      apiFormat,
      auth:
        apiFormat === 'ollama'
          ? { type: 'none' }
          : { type: 'api-key', apiKey: apiProvider.apiKey },
      endpoints: { baseUrl: apiProvider.baseUrl },
      headers: apiProvider.headers,
      options: apiProvider.options,
      extraEnv: apiProvider.extraEnv,
    },
    { ...options, authStyleHint: authStyle },
  );
}

/** Build a runtime config from a domain LlmProvider (the new shape). */
export function toRuntimeConfigFromDomain(
  provider: LlmProviderDomain,
  options: BuildOptions & { authStyleHint?: RuntimeAuthStyle },
): ProviderRuntimeConfig {
  const baseUrl = normalizeBaseUrl(provider.endpoints.baseUrl);
  const authStyle =
    options.authStyleHint ??
    (provider.auth.type === 'none'
      ? 'none'
      : provider.auth.type === 'bearer' || provider.auth.type === 'oauth'
        ? 'bearer'
        : 'api_key');
  const apiKey = provider.auth.apiKey ?? '';
  const headers = buildHeaders(
    provider.apiFormat,
    apiKey,
    provider.headers,
    authStyle,
  );
  if (options.extraHeaders) {
    Object.assign(headers, options.extraHeaders);
  }
  const requestOptions: Record<string, unknown> = {
    ...(provider.options ?? {}),
    ...(options.extraOptions ?? {}),
  };
  if (provider.extraEnv) {
    for (const [k, v] of Object.entries(provider.extraEnv)) {
      if (typeof v === 'string') requestOptions[k] = v;
    }
  }
  return {
    providerId: provider.id,
    providerName: provider.name,
    apiFormat: provider.apiFormat,
    baseUrl,
    apiKey: provider.auth.apiKey,
    accessToken: provider.auth.accessToken,
    authStyle,
    headers,
    model: options.modelId,
    modelCapabilities: options.capabilities,
    requestOptions,
  };
}
