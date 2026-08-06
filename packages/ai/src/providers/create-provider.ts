import type { ApiFormat, Model } from '../types.js';
import type { Provider, ProviderApi, ProviderAuthConfig } from './types.js';
import type { ProviderStreams } from './lazy.js';

export interface CreateProviderOptions<TApi extends ApiFormat = ApiFormat> {
  id: string;
  name?: string;
  baseUrl?: string;
  auth: ProviderAuthConfig;
  models: readonly Model<TApi>[];
  api: ProviderApi<TApi>;
}

/**
 * Build a provider from its model catalog and api implementation(s).
 * A single ProviderStreams is used for every model; otherwise dispatch
 * happens by `model.api` against the per-format map.
 */
export function createProvider<TApi extends ApiFormat = ApiFormat>(
  input: CreateProviderOptions<TApi>,
): Provider<TApi> {
  const single =
    typeof (input.api as ProviderStreams).stream === 'function'
      ? (input.api as ProviderStreams)
      : undefined;
  const byApi = single
    ? undefined
    : (input.api as Partial<Record<string, ProviderStreams>>);

  return {
    id: input.id,
    name: input.name ?? input.id,
    baseUrl: input.baseUrl,
    auth: input.auth,
    getModels: () => input.models,
    stream: (model, options) => {
      const streams = single ?? byApi?.[model.api as string];
      if (!streams) {
        throw new Error(`Provider ${input.id} has no API implementation for "${model.api}"`);
      }
      return streams.stream(model, options);
    },
  };
}