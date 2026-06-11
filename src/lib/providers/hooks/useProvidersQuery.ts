/**
 * src/lib/providers/hooks/useProvidersQuery.ts
 *
 * L1 React Query hook for reading the masked provider list.
 *
 * Plan 203 Phase 1.1 / Phase 1.4: this hook is the ONLY place in the
 * renderer component tree that should call a provider-list IPC. Raw
 * `useState<Provider[]>` + `fetchProviders()` patterns are deprecated
 * in favor of this hook.
 *
 * The query result is the new `RendererLlmProviderDTO` (Phase 0.1) —
 * a stable projection of `LlmProvider` that never includes raw
 * secrets.
 *
 * Source: the legacy `listProvidersIPC` (reads from disk via the
 * config manager's `getAllProviders()`). We intentionally do NOT use
 * `listLlmProvidersIPC` here because the Electron `ProviderStore`
 * cache is initialized once at first call and is NOT auto-refreshed
 * on legacy writes. The legacy path always reads from disk and is
 * therefore always fresh, which is what the current `ProvidersSection`
 * relies on for its mixed legacy / LlmProvider write paths. Plan 205
 * will collapse the two read paths once the cache subscribes to
 * `config:update`.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { listProvidersIPC, getDefaultLlmProviderIPC } from '@/lib/ipc-client';
import { toRendererLlmProviderDTO, type RendererLlmProviderDTO } from '../ipc-types';
import { providersQueryKey, type AppId } from './queryKeys';

export function useProvidersQuery(
  appId?: AppId,
): UseQueryResult<RendererLlmProviderDTO[], Error> {
  return useQuery({
    queryKey: providersQueryKey(appId),
    queryFn: async (): Promise<RendererLlmProviderDTO[]> => {
      const [raw, defaultProvider] = await Promise.all([
        listProvidersIPC(),
        getDefaultLlmProviderIPC().catch(() => null),
      ]);
      const defaultProviderId = defaultProvider?.id ?? null;
      return raw.map((p) =>
        toRendererLlmProviderDTO(p as never, { defaultProviderId }),
      );
    },
    // Providers are config; not real-time. 30s staleTime is plenty.
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    // Don't refetch on window focus — providers don't change that often.
    refetchOnWindowFocus: false,
  });
}
