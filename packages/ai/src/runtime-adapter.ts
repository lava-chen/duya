/**
 * package/ai runtime-adapter.ts
 *
 * Canonical LLM provider -> runtime config adapter.
 *
 * This is the single authoritative boundary that turns a configured provider
 * (the renderer's `LlmProvider`/legacy `ApiProvider`, or any structurally
 * equivalent object) into a `ProviderRuntimeConfig` consumed by the AI client
 * factory (`createAIClient`). Downstream code MUST NOT look at the provider
 * shape directly; it should only consume the returned `ProviderRuntimeConfig`.
 *
 * It lives here, next to `createAIClient` / `AIClientOptions` / `findModelCompat`,
 * so the "config -> client input" conversion is co-located with the client it
 * drives. Both `packages/agent` and the electron main process import from here.
 *
 * IMPORTANT: secrets are never written to logs. Any error message is run
 * through `redactSecrets()`.
 */

import type { ApiFormat, ModelCompat } from './types.js';
import { findModelCompat } from './models.js';

// =============================================================================
// Canonical types
// =============================================================================

/** Wire-protocol auth style. */
export type RuntimeAuthStyle = 'api_key' | 'auth_token' | 'bearer' | 'none';

/** Legacy providerType enum (kept for the legacy config path). */
export type RuntimeLegacyProviderType =
  | 'anthropic'
  | 'openai'
  | 'ollama'
  | 'openai-compatible'
  | 'openrouter'
  | 'bedrock'
  | 'vertex'
  | 'gemini-image'
  | 'google';

/** Structural subset of the renderer's `LlmProvider.auth`. */
export interface RuntimeAuthSource {
  type: 'api-key' | 'bearer' | 'oauth' | 'none';
  apiKeyField?: string;
  apiKey?: string;
  accessToken?: string;
}

/** Structural subset of the renderer's `LlmProvider.endpoints`. */
export interface RuntimeEndpointSource {
  baseUrl: string;
  isFullUrl?: boolean;
}

/** Structural input for the LlmProvider path. Renderer's `LlmProvider`
 *  is assignable to this (extra fields are allowed). */
export interface RuntimeProviderSource {
  id: string;
  name: string;
  apiFormat: ApiFormat;
  auth: RuntimeAuthSource;
  endpoints: RuntimeEndpointSource;
  headers?: Record<string, string>;
  options?: Record<string, unknown>;
  extraEnv?: Record<string, string>;
  compatOverrides?: ModelCompat;
}

/** Structural input for the legacy ApiProvider path. Renderer's `ApiProvider`
 *  is assignable to this. */
export interface RuntimeLegacyProviderSource {
  id: string;
  name: string;
  providerType: RuntimeLegacyProviderType;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  options?: Record<string, unknown>;
  extraEnv?: Record<string, string>;
}

/** Per-model capability row (structural subset of the renderer's
 *  `ModelCapability`). Threads user-toggled capability overrides into the
 *  runtime config. */
export interface RuntimeModelCapability {
  providerId?: string;
  modelId?: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsToolUse?: boolean;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  supportsPromptCache?: boolean;
}

/** What the agent runtime actually consumes. */
export interface ProviderRuntimeConfig {
  providerId: string;
  providerName: string;
  apiFormat: ApiFormat;
  baseUrl: string;
  apiKey?: string;
  accessToken?: string;
  headers: Record<string, string>;
  model: string;
  modelCapabilities?: RuntimeModelCapability;
  /** Provider-specific compat flags from @duya/ai preset models.
   *  Drives thinking format selection, forceAdaptiveThinking, etc.
   *  Resolved by findModelCompat(apiFormat, model) in toRuntimeConfig. */
  modelCompat?: ModelCompat;
  requestOptions: Record<string, unknown>;
}

/** Result of a runtime-config validation. */
export interface RuntimeValidationResult {
  ok: boolean;
  code?: string;
  message?: string;
}

// =============================================================================
// Pure helpers
// =============================================================================

/** Strip trailing slashes from a baseUrl. Pure. */
export function normalizeBaseUrl(url: string | undefined): string {
  if (!url) return '';
  return url.replace(/\/+$/, '');
}

/** Map a legacy `providerType` string to the new `ApiFormat`. */
export function inferApiFormatFromLegacyProviderType(
  providerType: RuntimeLegacyProviderType,
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

/** Map a new ApiFormat to the legacy `LLMProvider` discriminator used by
 *  the existing client factory. New code should migrate to use apiFormat
 *  directly; this mapping is a bridge. */
export function toLegacyLlmProviderDiscriminator(
  apiFormat: ApiFormat,
): 'anthropic' | 'openai' | 'ollama' {
  const PROTOCOL_TO_LLM: Record<ApiFormat, 'anthropic' | 'openai' | 'ollama'> = {
    'openai-chat': 'openai',
    'openai-responses': 'openai',
    anthropic: 'anthropic',
    gemini: 'openai',
    ollama: 'ollama',
    bedrock: 'anthropic',
    vertex: 'anthropic',
  };
  return PROTOCOL_TO_LLM[apiFormat] ?? 'openai';
}

/** Authoritative LLM-client selector. New agent code MUST resolve the LLM
 *  client discriminator from an `ApiFormat`, never from URL string sniffing.
 *  Unknown formats throw — fail loud, do not silently default to 'openai'. */
export function resolveLlmClientDiscriminator(
  apiFormat: ApiFormat,
): 'anthropic' | 'openai' | 'ollama' {
  switch (apiFormat) {
    case 'openai-chat':
    case 'openai-responses':
    case 'gemini':
      return 'openai';
    case 'anthropic':
    case 'bedrock':
    case 'vertex':
      return 'anthropic';
    case 'ollama':
      return 'ollama';
    default: {
      const exhaustive: never = apiFormat;
      throw new Error(
        `resolveLlmClientDiscriminator: unhandled apiFormat ${String(exhaustive)}`,
      );
    }
  }
}

/** Best-effort: derive the wire-protocol auth style from an auth source. */
function inferAuthStyle(auth: RuntimeAuthSource): RuntimeAuthStyle {
  if (auth.type === 'none') return 'none';
  if (auth.type === 'bearer' || auth.type === 'oauth') return 'bearer';
  if (auth.type === 'api-key') {
    if (auth.apiKeyField === 'ANTHROPIC_AUTH_TOKEN') return 'auth_token';
    return 'api_key';
  }
  return 'api_key';
}

/** Build the per-protocol auth headers. Does NOT log the secret. */
export function buildHeaders(
  apiFormat: ApiFormat,
  auth: RuntimeAuthSource,
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

// =============================================================================
// Config builders
// =============================================================================

export interface BuildOptions {
  /** Model id to use for this call. */
  modelId: string;
  /** Pre-resolved capabilities for the model. */
  capabilities?: RuntimeModelCapability;
  /** Extra per-request headers. */
  extraHeaders?: Record<string, string>;
  /** Extra per-request options. */
  extraOptions?: Record<string, unknown>;
}

/** Build the full runtime config from an LlmProvider-shaped source. */
export function toRuntimeConfig(
  provider: RuntimeProviderSource,
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
  // Resolve ModelCompat from @duya/ai preset models. User-defined
  // `compatOverrides` take precedence over built-in preset values.
  const compatOverrides = provider.compatOverrides
    ?? (provider.options?.compatOverrides as ModelCompat | undefined);
  const modelCompat = findModelCompat(
    provider.apiFormat,
    options.modelId,
    compatOverrides,
  );

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
    modelCompat,
    requestOptions,
  };
}

/** Bridge: take a legacy ApiProvider (still used by the IPC layer) and
 *  build a runtime config directly. This is the *only* place where a legacy
 *  shape flows into a runtime config; new callers should go through the
 *  LlmProvider path. */
export function toRuntimeConfigFromLegacy(
  apiProvider: RuntimeLegacyProviderSource,
  modelId: string,
  options?: { capabilities?: RuntimeModelCapability; baseUrlOverride?: string },
): ProviderRuntimeConfig {
  const baseUrl = normalizeBaseUrl(
    options?.baseUrlOverride ?? apiProvider.baseUrl ?? '',
  );
  const apiFormat = inferApiFormatFromLegacyProviderType(apiProvider.providerType);
  const auth: RuntimeAuthSource =
    apiFormat === 'ollama'
      ? { type: 'none' }
      : { type: 'api-key', apiKey: apiProvider.apiKey };

  const headers = buildHeaders(apiFormat, auth, apiProvider.headers);

  // Legacy ApiProvider does not have a top-level `compatOverrides`
  // field; it is persisted inside `options.compatOverrides` by the
  // save hook. Extract it here so the legacy bridge also honors
  // user-defined compat overrides.
  const compatOverrides = apiProvider.options?.compatOverrides as
    | ModelCompat
    | undefined;
  const modelCompat = findModelCompat(apiFormat, modelId, compatOverrides);

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
    modelCompat,
    requestOptions: {
      ...(apiProvider.options ?? {}),
      ...(apiProvider.extraEnv ?? {}),
    },
  };
}

/** Validate a runtime config in isolation. Useful before passing to
 *  downstream LLM clients. */
export function validateRuntimeConfig(
  cfg: ProviderRuntimeConfig,
): RuntimeValidationResult {
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

// =============================================================================
// Redaction
// =============================================================================

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(Bearer\s+)[A-Za-z0-9._\-+/=]{8,}/g, '$1[REDACTED]'],
  [/(x-api-key["']?\s*[:=]\s*["']?)[A-Za-z0-9._\-+/=]{8,}/gi, '$1[REDACTED]'],
  [/(authorization["']?\s*[:=]\s*["']?)[A-Za-z0-9._\-+/=]{8,}/gi, '$1[REDACTED]'],
  [/((?:api[_-]?key|access[_-]?token)["']?\s*[:=]\s*["']?)[A-Za-z0-9._\-+/=]{8,}/gi, '$1[REDACTED]'],
];

/** Redact any string-shaped value that might contain a secret. */
export function redactSecrets(input: string | undefined | null): string {
  if (!input) return '';
  let out = input;
  for (const [re, repl] of SECRET_PATTERNS) {
    out = out.replace(re, repl);
  }
  return out;
}