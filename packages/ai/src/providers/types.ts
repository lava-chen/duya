import type { ApiFormat, Model, SSEEvent } from '../types.js';
import type { EnvResolver } from '../auth/helpers.js';
import type { AuthResult } from '../auth/types.js';
import type { ProviderStreams } from './lazy.js';

/** Declarative auth configuration for a provider. */
export interface ProviderAuthApiKey {
  resolve(ctx: EnvResolver): Promise<AuthResult | undefined>;
}

export interface ProviderOAuth {
  name: string;
  login?(): Promise<{ access: string; refresh: string; expires: number }>;
}

export interface ProviderAuthConfig {
  /** API-key resolver (e.g. from `envApiKeyAuth`). */
  apiKey?: ProviderAuthApiKey;
  oauth?: ProviderOAuth;
}

/**
 * A provider joins its model catalog with the api adapters (ProviderStreams)
 * that can actually stream those models. `stream` dispatches on the model's
 * `api` format.
 */
export interface Provider<TApi extends ApiFormat = ApiFormat> {
  readonly id: string;
  readonly name: string;
  readonly baseUrl?: string;
  readonly auth: ProviderAuthConfig;
  getModels(): readonly Model<TApi>[];
  stream(
    model: Model<TApi>,
    options: { messages: unknown[]; systemPrompt?: string },
  ): AsyncGenerator<SSEEvent, unknown, unknown>;
}

/**
 * Convenience alias so callers can build a provider from a single api
 * implementation or a per-format map without importing ProviderStreams.
 */
export type ProviderApi<TApi extends ApiFormat = ApiFormat> =
  | ProviderStreams
  | Partial<Record<TApi, ProviderStreams>>;