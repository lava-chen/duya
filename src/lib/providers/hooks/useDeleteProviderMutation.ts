/**
 * src/lib/providers/hooks/useDeleteProviderMutation.ts
 *
 * L1 React Query mutation for deleting a provider.
 *
 * Plan 203 Phase 1.1.
 *
 * Plan 209: if the deleted provider is the active one, also
 * clear the active-id cache so the user isn't left with a
 * dangling active reference. Without this, deleting the
 * only-active provider leaves the app pointing at a
 * non-existent provider, which is the bug the user reported
 * as "I can't delete any provider" (the delete button was
 * hidden on the active card AND deleting it left a stale
 * active state).
 *
 * Multi-provider model: if the deleted provider is the
 * SOFT DEFAULT, clear `defaultProviderId` too. Otherwise
 * the agent pool / conductor / vision / gateway still fall
 * back to a provider the user just removed.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { deleteLlmProviderIPC, setDefaultLlmProviderIPC } from '@/lib/ipc-client';
import {
  activeProviderQueryKey,
  modelCapabilitiesQueryKey,
  providerHealthQueryKey,
  providerModelsQueryKey,
  PROVIDERS_KEY,
  providersQueryKey,
} from './queryKeys';

export function useDeleteProviderMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (providerId: string): Promise<boolean> => {
      // Snapshot the current default id BEFORE the delete, so we
      // can decide whether to clear it after the server confirms.
      const cachedDefaultId = readDefaultProviderIdFromCache(qc);
      const ok = await deleteLlmProviderIPC(providerId);
      if (ok && cachedDefaultId === providerId) {
        // The deleted provider was the soft default; clear it.
        // The IPC handler treats this as an idempotent set-to-null
        // and updates the on-disk `defaultProviderId` accordingly.
        await setDefaultLlmProviderIPC(null);
      }
      return ok;
    },
    onSuccess: (_data, providerId) => {
      // Plan 209: invalidate the broad `providers` prefix so
      // both `useProvidersQuery()` and `useProvidersQuery('duya')`
      // cache entries are dropped — the previous
      // `providersQueryKey()` (which targeted only `'all'`)
      // missed the `'duya'` entry and the list kept the
      // deleted row visible.
      qc.invalidateQueries({ queryKey: PROVIDERS_KEY });
      qc.invalidateQueries({ queryKey: activeProviderQueryKey() });
      qc.invalidateQueries({ queryKey: providersQueryKey() });
      qc.invalidateQueries({ queryKey: modelCapabilitiesQueryKey(providerId) });
      qc.invalidateQueries({ queryKey: providerModelsQueryKey(providerId) });
      qc.invalidateQueries({ queryKey: providerHealthQueryKey(providerId) });
    },
  });
}

/**
 * Read the current soft-default provider id from the React Query
 * cache (no IPC). Both the `useProvidersQuery` and the legacy
 * `useActiveProviderId` paths populate a list whose entries
 * carry an `isDefault` flag; we scan for the first match. If no
 * row is marked default (e.g. cache cold or pre-migration data),
 * returns `null` and the caller does nothing.
 */
function readDefaultProviderIdFromCache(qc: ReturnType<typeof useQueryClient>): string | null {
  for (const key of [providersQueryKey('duya'), providersQueryKey()]) {
    const entry = qc.getQueryData<Array<{ id: string; isDefault?: boolean }>>(key);
    if (!entry) continue;
    const found = entry.find((p) => p.isDefault);
    if (found) return found.id;
  }
  return null;
}

