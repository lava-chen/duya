/**
 * src/lib/providers/hooks/useSetDefaultProviderMutation.ts
 *
 * L1 React Query mutation for setting the soft default provider.
 *
 * Setting the default does NOT lock the other providers — every
 * configured provider remains usable in chat/vision/etc. The default
 * is just the implicit fallback when no per-thread or per-task
 * provider is set.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { setDefaultLlmProviderIPC } from '@/lib/ipc-client';
import {
  providersQueryKey,
  modelCapabilitiesQueryKey,
  providerHealthQueryKey,
  providerModelsQueryKey,
  type AppId,
} from './queryKeys';

export function useSetDefaultProviderMutation(appId?: AppId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (providerId: string | null) => setDefaultLlmProviderIPC(providerId),
    onSuccess: () => {
      // The default moved; the full list and any per-provider caches
      // that depend on the default state should refetch. The key MUST
      // match the key the list uses (useProvidersQuery(appId)),
      // otherwise invalidateQueries is a no-op for that entry.
      qc.invalidateQueries({ queryKey: providersQueryKey(appId) });
    },
  });
}

/** Mutation that also invalidates a specific provider's capability /
 *  health / model caches. Use this from per-card actions. */
export function useSetDefaultWithCascadeMutation(appId?: AppId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (providerId: string) => setDefaultLlmProviderIPC(providerId),
    onSuccess: (_data, providerId) => {
      qc.invalidateQueries({ queryKey: providersQueryKey(appId ?? 'duya') });
      qc.invalidateQueries({ queryKey: modelCapabilitiesQueryKey(providerId) });
      qc.invalidateQueries({ queryKey: providerModelsQueryKey(providerId) });
      qc.invalidateQueries({ queryKey: providerHealthQueryKey(providerId) });
    },
  });
}
