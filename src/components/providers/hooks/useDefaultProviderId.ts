/**
 * src/components/providers/hooks/useDefaultProviderId.ts
 *
 * Read the current default provider id from the React Query cache
 * (no extra IPC call). The default is whichever entry has
 * `isDefault: true` in its `RendererLlmProviderDTO` (which is
 * derived from `AppConfig.defaultProviderId`).
 *
 * The hook subscribes to the same `providersQueryKey` cache that
 * `useProvidersQuery` populates so it re-renders when the cache
 * updates. There is NO second IPC call.
 *
 * Returns `null` when no provider is the default OR when the cache
 * is empty. When multiple providers are marked default (a corrupt /
 * concurrent-write state), the hook returns the FIRST match and
 * logs a warning to the structured logger (consumers should not
 * depend on this — it is a defensive fallback).
 *
 * The hook does NOT mutate the default provider; that lives in
 * `useSetDefaultProviderMutation`.
 */

import { useQuery } from '@tanstack/react-query';
import { providersQueryKey, type AppId } from '@/lib/providers/hooks/queryKeys';
import type { RendererLlmProviderDTO } from '@/lib/providers/ipc-types';

/**
 * Returns the id of the current default provider, or `null` when
 * none is set. Subscribes to the React Query cache populated by
 * `useProvidersQuery`.
 */
export function useDefaultProviderId(appId?: AppId): string | null {
  // We use `useQuery` here (rather than `useQueryClient` + a
  // `useMemo`) so the hook re-renders when the providers cache
  // updates. Without this, the first render returns `null` and
  // subsequent re-renders never re-evaluate.
  const query = useQuery<RendererLlmProviderDTO[]>({
    queryKey: providersQueryKey(appId),
    // The query is already populated by `useProvidersQuery`. We
    // do NOT actually call this fn (enabled: false) but React
    // Query requires a queryFn. We use a noop for that case and
    // let `useProvidersQuery` do the actual work.
    queryFn: () => Promise.resolve([]),
    enabled: false,
    staleTime: Infinity,
  });
  const data = query.data;
  if (!data || data.length === 0) return null;
  const def = data.filter((p) => p.isDefault);
  if (def.length === 0) return null;
  if (def.length > 1) {
    // Defensive: a corrupt concurrent-write state. The renderer
    // doesn't currently log via the structured logger (no
    // Electron context), so a `console.warn` is the right
    // compromise for this hook. Plan 205 will route this through
    // a renderer-side structured logger.
    // eslint-disable-next-line no-console
    console.warn(
      `[useDefaultProviderId] expected at most one default provider, got ${def.length}. ` +
        'Returning the first match; please investigate the provider config.',
    );
  }
  return def[0]!.id;
}

/**
 * @deprecated Use useDefaultProviderId. The single-active concept is gone;
 * the default is a soft preference, not a lock.
 */
export function useActiveProviderId(appId?: AppId): string | null {
  return useDefaultProviderId(appId);
}
