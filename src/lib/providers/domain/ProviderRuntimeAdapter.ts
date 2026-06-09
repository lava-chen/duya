/**
 * src/lib/providers/domain/ProviderRuntimeAdapter.ts
 *
 * Build `ProviderRuntimeConfig` from `LlmProvider` + a modelId.
 *
 * This is the single entry point that the agent runtime (and other callers)
 * should use to get the actual config. After this call, downstream code
 * MUST NOT look at `LlmProvider` directly — it should consume the returned
 * `ProviderRuntimeConfig`.
 *
 * Covering:
 *  - OpenAI-compatible (openai-chat / openai-responses)
 *  - Anthropic
 *  - Ollama
 *  - Gemini
 *  - Bedrock / Vertex (best-effort headers; full wire protocol is out of scope
 *    for Phase 1 and is not tested at runtime)
 */

import type {
  ApiFormat,
  ApiProvider,
  AuthConfig,
  EndpointConfig,
  LlmProvider,
  ModelCapability,
  ProviderRuntimeConfig,
  ValidationResult,
} from '../types';
import { inferApiFormatFromLegacyProviderType } from '../legacy';
import { redactSecrets } from './ProviderValidation';

interface BuildOptions {
  /** Model id to use for this call. */
  modelId: string;
  /** Pre-resolved capabilities for the model. */
  capabilities?: ModelCapability;
  /** Extra per-request headers. */
  extraHeaders?: Record<string, string>;
  /** Extra per-request options. */
  extraOptions?: Record<string, unknown>;
}

const PROTOCOL_TO_LLM: Record<ApiFormat, 'anthropic' | 'openai' | 'ollama'> = {
  'openai-chat': 'openai',
  'openai-responses': 'openai',
  anthropic: 'anthropic',
  gemini: 'openai',
  ollama: 'ollama',
  bedrock: 'anthropic',
  vertex: 'anthropic',
};

/** Map a new ApiFormat to the legacy `LLMProvider` discriminator used by
 *  the existing client factory. New code should migrate to use apiFormat
 *  directly; this mapping is a bridge. */
export function toLegacyLlmProviderDiscriminator(
  apiFormat: ApiFormat,
): 'anthropic' | 'openai' | 'ollama' {
  return PROTOCOL_TO_LLM[apiFormat] ?? 'openai';
}

/** Best-effort: derive the wire-protocol auth style. */
function inferAuthStyle(auth: AuthConfig): 'api_key' | 'auth_token' | 'bearer' | 'none' {
  if (auth.type === 'none') return 'none';
  if (auth.type === 'bearer' || auth.type === 'oauth') return 'bearer';
  if (auth.type === 'api-key') {
    if (auth.apiKeyField === 'ANTHROPIC_AUTH_TOKEN') return 'auth_token';
    return 'api_key';
  }
  return 'api_key';
}

/** Strip trailing slashes from a baseUrl. Pure. */
export function normalizeBaseUrl(url: string | undefined): string {
  if (!url) return '';
  return url.replace(/\/+$/, '');
}

/** Build the per-protocol auth headers. Does NOT log the secret. */
export function buildHeaders(
  apiFormat: ApiFormat,
  auth: AuthConfig,
  baseHeaders: Record<string, string> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = { ...(baseHeaders ?? {}) };
  const style = inferAuthStyle(auth);
  const key = auth.apiKey ?? '';
  const token = auth.accessToken ?? key;

  switch (apiFormat) {
    case 'anthropic':
    case 'bedrock':
    case 'vertex':
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
      if (style === 'auth_token' || style === 'bearer') {
        headers['Authorization'] = `Bearer ${token}`;
      } else {
        headers['x-api-key'] = key;
      }
      headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01';
      break;
    case 'openai-chat':
    case 'openai-responses':
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
      if (style !== 'none') {
        headers['Authorization'] = `Bearer ${token}`;
      }
      break;
    case 'gemini':
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
      if (style !== 'none') {
        // Gemini accepts `?key=` query OR `x-goog-api-key` header.
        // We use the header to avoid leaking the key in URLs.
        headers['x-goog-api-key'] = key;
      }
      break;
    case 'ollama':
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
      break;
    default:
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
  }
  return headers;
}

/** Build the full runtime config. */
export function toRuntimeConfig(
  provider: LlmProvider,
  options: BuildOptions,
): ProviderRuntimeConfig {
  const baseUrl = normalizeBaseUrl(provider.endpoints.baseUrl);
  const headers = buildHeaders(provider.apiFormat, provider.auth, provider.headers);
  if (options.extraHeaders) {
    Object.assign(headers, options.extraHeaders);
  }
  const requestOptions: Record<string, unknown> = {
    ...(provider.options ?? {}),
    ...(options.extraOptions ?? {}),
  };
  // Surface env overrides for downstream SDKs that look at process.env.
  if (provider.extraEnv) {
    for (const [k, v] of Object.entries(provider.extraEnv)) {
      if (typeof v === 'string') {
        requestOptions[k] = v;
      }
    }
  }
  return {
    providerId: provider.id,
    providerName: provider.name,
    apiFormat: provider.apiFormat,
    baseUrl,
    apiKey: provider.auth.apiKey,
    accessToken: provider.auth.accessToken,
    headers,
    model: options.modelId,
    modelCapabilities: options.capabilities,
    requestOptions,
  };
}

/** Validate a runtime config in isolation. Useful before passing to
 *  downstream LLM clients. */
export function validateRuntimeConfig(
  cfg: ProviderRuntimeConfig,
): ValidationResult {
  if (!cfg.providerId) {
    return { ok: false, code: 'runtime.missingProviderId', message: 'providerId is required' };
  }
  if (!cfg.model) {
    return { ok: false, code: 'runtime.missingModel', message: 'model is required' };
  }
  if (!cfg.baseUrl) {
    return {
      ok: false,
      code: 'runtime.missingBaseUrl',
      message: 'baseUrl is required',
    };
  }
  return { ok: true };
}

/** Bridge: take a legacy ApiProvider (still used by the IPC layer) and
 *  build a runtime config directly. This is the *only* place where a legacy
 *  shape flows into a runtime config; new callers should go through the
 *  LlmProvider path. */
export function toRuntimeConfigFromLegacy(
  apiProvider: ApiProvider,
  modelId: string,
  options?: { capabilities?: ModelCapability; baseUrlOverride?: string },
): ProviderRuntimeConfig {
  const baseUrl = normalizeBaseUrl(
    options?.baseUrlOverride ?? apiProvider.baseUrl ?? '',
  );
  const apiFormat = inferApiFormatFromLegacyProviderType(apiProvider.providerType);
  const auth: AuthConfig =
    apiFormat === 'ollama'
      ? { type: 'none' }
      : { type: 'api-key', apiKey: apiProvider.apiKey };

  const headers = buildHeaders(apiFormat, auth, apiProvider.headers);

  return {
    providerId: apiProvider.id,
    providerName: apiProvider.name,
    apiFormat,
    baseUrl,
    apiKey: apiProvider.apiKey,
    accessToken: undefined,
    headers,
    model: modelId,
    modelCapabilities: options?.capabilities,
    requestOptions: {
      ...(apiProvider.options ?? {}),
      ...(apiProvider.extraEnv ?? {}),
    },
  };
}

/** Re-export the redaction helper for callers that want to scrub strings. */
export { redactSecrets };
