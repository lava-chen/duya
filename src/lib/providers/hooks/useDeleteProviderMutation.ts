/**
 * src/lib/providers/hooks/useDeleteProviderMutation.ts
 *
 * L1 React Query mutation for deleting a provider.
 *
 * Plan 203 Phase 1.1.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { deleteLlmProviderIPC } from '@/lib/ipc-client';
import {
  modelCapabilitiesQueryKey,
  providerHealthQueryKey,
  providerModelsQueryKey,
  providersQueryKey,
} from './queryKeys';

export function useDeleteProviderMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (providerId: string) => deleteLlmProviderIPC(providerId),
    onSuccess: (_data, providerId) => {
      qc.invalidateQueries({ queryKey: providersQueryKey() });
      qc.invalidateQueries({ queryKey: modelCapabilitiesQueryKey(providerId) });
      qc.invalidateQueries({ queryKey: providerModelsQueryKey(providerId) });
      qc.invalidateQueries({ queryKey: providerHealthQueryKey(providerId) });
    },
  });
}
