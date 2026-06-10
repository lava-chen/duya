/**
 * src/lib/providers/hooks/queryKeys.ts
 *
 * Centralized React Query key factory for the LlmProvider domain.
 *
 * Plan 203 Phase 1.1: every provider-related query / mutation MUST
 * go through this key factory. Components that invalidate caches
 * elsewhere should import these constants rather than re-typing the
 * key tuples — that way the key shape is owned by one file and a
 * future split (per-appId, per-active, per-sort) does not require
 * touching every consumer.
 */

/** AppId bound to a single LlmProvider. Today duya has 1 appId
 *  (`'duya'`). Reserved here for the Plan 205 cross-app
 *  refactor. */
export type AppId = 'duya';

/** Top-level key prefix. All provider-related queries use this. */
export const PROVIDERS_KEY = ['providers'] as const;

/** The full list of providers for an appId. */
export const providersQueryKey = (appId?: AppId) =>
  [...PROVIDERS_KEY, appId ?? 'all'] as const;

/** The currently active provider for an appId. */
export const activeProviderQueryKey = (appId?: AppId) =>
  [...providersQueryKey(appId), 'active'] as const;

/** The model capability list for a single provider. */
export const modelCapabilitiesQueryKey = (providerId: string) =>
  [...PROVIDERS_KEY, 'capabilities', providerId] as const;

/** The model list (preset + synced) for a single provider. */
export const providerModelsQueryKey = (providerId: string) =>
  [...PROVIDERS_KEY, 'models', providerId] as const;

/** Provider health status for a single provider. */
export const providerHealthQueryKey = (providerId: string) =>
  [...PROVIDERS_KEY, 'health', providerId] as const;
