/**
 * src/lib/providers/hooks/useProviderTestMutation.ts
 *
 * L1 React Query mutation for testing a provider's connectivity.
 * On success, the result is written to the providerHealthQueryKey
 * cache so the L4 orchestrator can render the badge.
 *
 * Plan 203 Phase 1.1.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { testProviderIPC, type ProviderHealthDTO } from '@/lib/ipc-client';
import { providerHealthQueryKey, providersQueryKey } from './queryKeys';

export function useProviderTestMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { providerId: string; presetKey?: string }) =>
      testProviderIPC(payload) as Promise<ProviderHealthDTO>,
    onSuccess: (result, payload) => {
      qc.setQueryData(providerHealthQueryKey(payload.providerId), result);
      // Also invalidate the broad providers list so any UI that
      // aggregates health status re-renders.
      qc.invalidateQueries({ queryKey: providersQueryKey() });
    },
  });
}

/** Read the cached health status for a provider without subscribing
 *  to changes. Use this for read-only display (e.g. the L4
 *  orchestrator computing per-card props). */
export function getCachedProviderHealth(
  qc: ReturnType<typeof useQueryClient>,
  providerId: string | null,
): ProviderHealthDTO | undefined {
  if (!providerId) return undefined;
  return qc.getQueryData<ProviderHealthDTO>(providerHealthQueryKey(providerId));
}
