/**
 * src/components/providers/hooks/useActiveProviderId.ts
 *
 * Plan 203 Phase 3.4: read the currently active provider id from
 * the React Query cache (no extra IPC call). The active provider
 * is whichever entry has `isActive: true` in its
 * `RendererLlmProviderDTO` (which is derived from
 * `LlmProvider.meta.tags`).
 *
 * The hook subscribes to the same `providersQueryKey` cache that
 * `useProvidersQuery` populates so it re-renders when the cache
 * updates. There is NO second IPC call.
 *
 * Returns `null` when no provider is active OR when the cache is
 * empty. When multiple providers are marked active (a corrupted /
 * concurrent-write state), the hook returns the FIRST match and
 * logs a warning to the structured logger (consumers should not
 * depend on this — it is a defensive fallback).
 *
 * The hook does NOT mutate the active provider; that lives in
 * `useSetActiveProviderMutation`.
 */

import { useQuery } from '@tanstack/react-query';
import { providersQueryKey, type AppId } from '@/lib/providers/hooks/queryKeys';
import type { RendererLlmProviderDTO } from '@/lib/providers/ipc-types';

/**
 * Returns the id of the currently active provider, or `null` when
 * none is marked active. Subscribes to the React Query cache
 * populated by `useProvidersQuery`.
 */
export function useActiveProviderId(appId?: AppId): string | null {
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
  const active = data.filter((p) => p.isActive);
  if (active.length === 0) return null;
  if (active.length > 1) {
    // Defensive: a corrupt concurrent-write state. The renderer
    // doesn't currently log via the structured logger (no
    // Electron context), so a `console.warn` is the right
    // compromise for this hook. Plan 205 will route this through
    // a renderer-side structured logger.
    // eslint-disable-next-line no-console
    console.warn(
      `[useActiveProviderId] expected exactly one active provider, got ${active.length}. ` +
        'Returning the first match; please investigate the provider config.',
    );
  }
  return active[0].id;
}
