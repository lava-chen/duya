import type { ApiFormat, Model } from '../types.js';
import type { Provider, ProviderApi, ProviderAuthConfig } from './types.js';
import type { ProviderStreams } from './lazy.js';
import type { Wrapper } from './wrappers/compose.js';
import { pipe } from './wrappers/compose.js';
import { autoWrappersForCompat } from './wrappers/compat-injection.js';

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
   *
   * Auto-injection (Plan 451 Phase 2): when this is omitted (or empty),
   * `create-provider` ALSO inspects `model.compat` at stream-call time
   * and appends wrappers from the fixed compat → wrapper map. Explicit
   * provider wrappers run INNERMOST (closest to the base protocol);
   * auto-injected wrappers run OUTERMOST.
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
 *
 * Auto-injection (Phase 2): in addition to the provider's explicit
 * wrappers, `model.compat` is consulted at stream-call time and the
 * resulting wrappers are appended. Composition order: explicit (inner)
 * + auto-injected (outer).
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
      // Auto-injection happens per stream call (compat is per-model, not
      // per-provider). Explicit wrappers run INNERMOST; auto-injected wrappers
      // run OUTERMOST so the explicit ones see the original base and the
      // auto-injected ones see both.
      const auto = autoWrappersForCompat(model);
      const allWrappers = [...wrappers, ...auto];
      const streams = allWrappers.length === 0 ? base : pipe(base, ...allWrappers);
      return streams.stream(model, options);
    },
  };
}