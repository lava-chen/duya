/**
 * src/lib/providers/types.ts
 *
 * Core domain types for the LLM provider architecture.
 *
 * Design principles:
 * - `LlmProvider` is the new domain entity. It separates *provider identity*
 *   (id, name, category) from *API protocol format* (apiFormat) from
 *   *authentication* (auth) from *endpoint configuration* (endpoints).
 * - `ProviderPreset` is the *template* used to bootstrap an LlmProvider draft.
 * - `ModelCapability` is intentionally NOT embedded inside LlmProvider. The
 *   capability of a model is independent of the provider's static config
 *   (a single provider can host many models with very different capabilities).
 * - `ProviderRuntimeConfig` is the shape consumed by agent runtime. It is
 *   derived from an LlmProvider + a modelId; this is the only shape
 *   `packages/agent/src/llm/*` should ever need to look at.
 * - `ApiProvider` is the legacy DTO kept only for backward compatibility.
 *
 * Naming note: this module does NOT export anything named ProviderV2,
 * NewProvider, ModernProvider, or NextProvider. The new entity is `LlmProvider`.
 */

export type ProviderCategory =
  | 'official'
  | 'aggregator'
  | 'custom'
  | 'local'
  | 'managed'
  | 'proxy';

export type ApiFormat =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic'
  | 'gemini'
  | 'ollama'
  | 'bedrock'
  | 'vertex';

export type AuthType = 'api-key' | 'bearer' | 'oauth' | 'none';

export interface AuthConfig {
  type: AuthType;
  /** For 'api-key' / 'bearer': which env-style field name to use (e.g. ANTHROPIC_AUTH_TOKEN). */
  apiKeyField?: string;
  /** Direct secret. The legacy apiKey is migrated here. */
  apiKey?: string;
  /** OAuth bearer / managed-account token. */
  accessToken?: string;
  /** Bound managed-account ID (e.g. github_copilot account). */
  oauthAccountId?: string;
}

export interface EndpointConfig {
  baseUrl: string;
  modelsUrl?: string;
  /** Candidate endpoints for future speed-test / auto-select. */
  endpointCandidates?: string[];
  /** If true, baseUrl is the full URL (no path concatenation). */
  isFullUrl?: boolean;
}

export interface ProviderUiMeta {
  icon?: string;
  iconColor?: string;
  websiteUrl?: string;
  docsUrl?: string;
  pricingUrl?: string;
  statusPageUrl?: string;
  apiKeyUrl?: string;
}

export interface ProviderMeta {
  createdAt: number;
  updatedAt: number;
  sortIndex: number;
  notes?: string;
  tags?: string[];
  inFailoverQueue?: boolean;
  liveConfigManaged?: boolean;
  costMultiplier?: number;
  monthlyLimitUsd?: number;
}

export interface LlmProvider {
  id: string;
  name: string;
  category: ProviderCategory;
  apiFormat: ApiFormat;
  auth: AuthConfig;
  endpoints: EndpointConfig;
  ui: ProviderUiMeta;
  meta: ProviderMeta;
  /** Extra HTTP headers injected into every request. */
  headers?: Record<string, string>;
  /** Free-form extras (formerly `options` in legacy ApiProvider). */
  options?: Record<string, unknown>;
  /** Free-form env overrides (formerly `extraEnv`). */
  extraEnv?: Record<string, string>;
}

/**
 * Preset template used to bootstrap an LlmProvider draft.
 * Does NOT itself carry secrets. The user fills in the auth fields.
 */
export interface ProviderPreset {
  key: string;
  name: string;
  description?: string;
  descriptionZh?: string;
  category: ProviderCategory;
  apiFormat: ApiFormat;
  authFields: Array<{
    key: string;
    label: string;
    secret: boolean;
    required: boolean;
  }>;
  defaultEndpoint: string;
  endpointCandidates?: string[];
  /**
   * How this preset's model list is sourced.
   *  - 'static': use `defaultModels`
   *  - 'openai-compatible-models': GET {baseUrl}/v1/models with bearer auth
   *  - 'custom-url': GET a specific URL (Ollama-style `/api/tags`)
   */
  modelsSource:
    | { type: 'static' }
    | { type: 'openai-compatible-models'; path?: string }
    | { type: 'custom-url'; url: string };
  defaultModels?: string[];
  /** Display labels for defaultModels when source is 'static'. */
  defaultModelLabels?: Record<string, string>;
  templateValues?: Record<string, string>;
  ui: ProviderUiMeta;
  /** The legacy providerType name (e.g. 'openai-compatible', 'ollama').
   *  Used to filter for migration UI; NOT used by runtime. */
  legacyProtocol?: string;
}

/** Per-model capability. NOT embedded in LlmProvider. */
export interface ModelCapability {
  providerId: string;
  modelId: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsToolUse?: boolean;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  supportsPromptCache?: boolean;
  pricing?: {
    inputPerMillion?: number;
    outputPerMillion?: number;
    cacheReadPerMillion?: number;
    cacheWritePerMillion?: number;
    currency?: string;
  };
  source: 'preset' | 'models-api' | 'user' | 'probe';
  updatedAt: number;
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
  modelCapabilities?: ModelCapability;
  requestOptions: Record<string, unknown>;
}

export interface ProviderHealthStatus {
  providerId: string;
  ok: boolean;
  latencyMs?: number;
  checkedAt: number;
  errorKind?:
    | 'auth'
    | 'network'
    | 'rate_limit'
    | 'invalid_model'
    | 'invalid_config'
    | 'unknown';
  message?: string;
}

/** Result of validation. The `code` is a stable string for programmatic use. */
export interface ValidationResult {
  ok: boolean;
  code?: string;
  message?: string;
}

/** -------------------------------------------------------------------------
 *  Legacy ApiProvider (kept for backward compatibility only)
 *  ----------------------------------------------------------------------- */

/** @deprecated Use LlmProvider. This shape is kept for the legacy config.json
 *  payload and the masked renderer DTO. New code should not extend it. */
export interface ApiProvider {
  id: string;
  name: string;
  providerType:
    | 'anthropic'
    | 'openai'
    | 'ollama'
    | 'openai-compatible'
    | 'openrouter'
    | 'bedrock'
    | 'vertex'
    | 'gemini-image'
    | 'google';
  baseUrl: string;
  apiKey: string;
  /** @deprecated Use isDefault on the AppConfig. The single-active
   *  concept is gone; this is kept as a transitional alias. */
  isActive?: boolean;
  extraEnv?: Record<string, string>;
  headers?: Record<string, string>;
  options?: Record<string, unknown>;
  notes?: string;
  sortOrder?: number;
}

/** Shape used by the renderer to mask the secret. */
export interface MaskedApiProvider {
  id: string;
  name: string;
  providerType: ApiProvider['providerType'];
  baseUrl: string;
  apiKey: string;
  /** @deprecated Use isDefault. The single-active concept is gone;
   *  this is kept as a transitional alias for one release. */
  isActive?: boolean;
  /** Soft default — implicit fallback for chat/vision/etc. */
  isDefault?: boolean;
  hasApiKey: boolean;
  sortOrder: number;
  extraEnv: string;
  protocol: string;
  headers: string;
  options: string;
  notes: string;
  createdAt: number;
  updatedAt: number;
}
