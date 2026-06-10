/**
 * src/lib/providers/hooks/useSetActiveProviderMutation.ts
 *
 * L1 React Query mutation for activating a provider.
 *
 * Plan 203 Phase 1.1.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { setActiveLlmProviderIPC } from '@/lib/ipc-client';
import {
  providersQueryKey,
  modelCapabilitiesQueryKey,
  providerHealthQueryKey,
  providerModelsQueryKey,
} from './queryKeys';

export function useSetActiveProviderMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (providerId: string) => setActiveLlmProviderIPC(providerId),
    onSuccess: () => {
      // The active provider tag moved; the full list and any per-provider
      // caches that depend on the active state should refetch.
      qc.invalidateQueries({ queryKey: providersQueryKey() });
    },
  });
}

/** Mutation that also invalidates a specific provider's capability /
 *  health / model caches. Use this from per-card actions. */
export function useActivateProviderMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (providerId: string) => setActiveLlmProviderIPC(providerId),
    onSuccess: (_data, providerId) => {
      qc.invalidateQueries({ queryKey: providersQueryKey() });
      qc.invalidateQueries({ queryKey: modelCapabilitiesQueryKey(providerId) });
      qc.invalidateQueries({ queryKey: providerModelsQueryKey(providerId) });
      qc.invalidateQueries({ queryKey: providerHealthQueryKey(providerId) });
    },
  });
}
