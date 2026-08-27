import type { ApiFormat, Model } from '../types.js';
import type { Provider, ProviderApi, ProviderAuthConfig } from './types.js';
import type { ProviderStreams } from './lazy.js';
import type { Wrapper } from './wrappers/compose.js';
import { pipe } from './wrappers/compose.js';

export interface CreateProviderOptions<TApi extends ApiFormat = ApiFormat> {
  id: string;
  name?: string;
  baseUrl?: string;
  auth: ProviderAuthConfig;
  models: readonly Model<TApi>[];
  api: ProviderApi<TApi>;
  /**
   * Per-provider wrapper chain (Plan 451 Phase 0). Applied to the
   * resolved ProviderStreams for `model.api` before stream() runs.
   * Wrappers run in argument order; the last wrapper is outermost.
   * Defaults to [] — backwards compatible with pre-Plan-451 providers.
   */
  wrappers?: Wrapper[];
}

/**
 * Build a provider from its model catalog and api implementation(s).
 * A single ProviderStreams is used for every model; otherwise dispatch
 * happens by `model.api` against the per-format map.
 *
 * If `wrappers` is provided, each resolved ProviderStreams is wrapped via
 * `pipe(base, ...wrappers)` BEFORE stream() runs. Empty `wrappers` is an
 * identity short-circuit (returns the base streams unchanged).
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

  const wrappers = input.wrappers ?? [];

  return {
    id: input.id,
    name: input.name ?? input.id,
    baseUrl: input.baseUrl,
    auth: input.auth,
    wrappers,
    getModels: () => input.models,
    stream: (model, options) => {
      const base = single ?? byApi?.[model.api as string];
      if (!base) {
        throw new Error(`Provider ${input.id} has no API implementation for "${model.api}"`);
      }
      const streams = wrappers.length === 0 ? base : pipe(base, ...wrappers);
      return streams.stream(model, options);
    },
  };
}