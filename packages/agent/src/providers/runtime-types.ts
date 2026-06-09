/**
 * packages/agent/src/providers/runtime-types.ts
 *
 * Types consumed by the agent runtime (`packages/agent/src/llm/*`).
 *
 * These types are intentionally a strict subset of the renderer-side
 * `ProviderRuntimeConfig`. Downstream code (Anthropic / OpenAI / Ollama
 * clients, retry wrappers) MUST depend only on this file.
 *
 * Do NOT add UI / Electron / IPC-specific fields here.
 */

/** Mirrors renderer `ApiFormat`. Kept local so the agent package does
 *  not have a hard cross-package import on `@/lib/providers`. */
export type RuntimeApiFormat =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic'
  | 'gemini'
  | 'ollama'
  | 'bedrock'
  | 'vertex';

/** Wire-protocol auth style. */
export type RuntimeAuthStyle = 'api_key' | 'auth_token' | 'bearer' | 'none';

export interface RuntimeModelCapability {
  providerId: string;
  modelId: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsToolUse?: boolean;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  supportsPromptCache?: boolean;
}

export interface ProviderRuntimeConfig {
  providerId: string;
  providerName: string;
  apiFormat: RuntimeApiFormat;
  baseUrl: string;
  apiKey?: string;
  accessToken?: string;
  authStyle: RuntimeAuthStyle;
  headers: Record<string, string>;
  model: string;
  modelCapabilities?: RuntimeModelCapability;
  requestOptions: Record<string, unknown>;
}

/** Stable error categorization. Mirrors renderer. */
export type ProviderErrorKind =
  | 'auth'
  | 'network'
  | 'rate_limit'
  | 'invalid_model'
  | 'invalid_config'
  | 'unknown';

export interface ProviderHealthStatus {
  providerId: string;
  ok: boolean;
  latencyMs?: number;
  checkedAt: number;
  errorKind?: ProviderErrorKind;
  message?: string;
}
