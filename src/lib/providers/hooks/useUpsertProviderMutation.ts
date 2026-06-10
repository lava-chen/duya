/**
 * src/lib/providers/hooks/useUpsertProviderMutation.ts
 *
 * L1 React Query mutation for creating / updating a provider.
 *
 * Plan 203 Phase 1.1.
 *
 * The mutation takes a raw `LlmProvider` and a few IPC-level fields
 * (e.g. the apiKey the user typed — even if the form projection
 * masked it, the upsert still needs the raw value). The DTO returned
 * by the IPC handler is then projected to the renderer DTO and
 * pushed into the providers cache.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { upsertLlmProviderIPC } from '@/lib/ipc-client';
import { toRendererLlmProviderDTO, type RendererLlmProviderDTO } from '../ipc-types';
import {
  modelCapabilitiesQueryKey,
  providerHealthQueryKey,
  providerModelsQueryKey,
  providersQueryKey,
} from './queryKeys';
import type { LlmProvider } from '../types';

export interface UpsertProviderInput {
  /** The LlmProvider entity to persist. */
  llm: LlmProvider;
  /** The user-typed apiKey (raw, unmasked). May be omitted when the
   *  user is editing and did not retype the key — the existing key is
   *  preserved. */
  apiKey?: string;
}

export function useUpsertProviderMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      llm,
      apiKey,
    }: UpsertProviderInput): Promise<RendererLlmProviderDTO | null> => {
      const payload: Record<string, unknown> = {
        id: llm.id,
        name: llm.name,
        category: llm.category,
        apiFormat: llm.apiFormat,
        auth: apiKey !== undefined ? { ...llm.auth, apiKey } : llm.auth,
        endpoints: llm.endpoints,
        ui: llm.ui,
        meta: llm.meta,
        headers: llm.headers,
        options: llm.options,
        extraEnv: llm.extraEnv,
      };
      const res = await upsertLlmProviderIPC(payload);
      if (!res.ok || !res.provider) return null;
      return toRendererLlmProviderDTO(res.provider as never, Date.now());
    },
    onSuccess: (_dto, input) => {
      qc.invalidateQueries({ queryKey: providersQueryKey() });
      qc.invalidateQueries({ queryKey: modelCapabilitiesQueryKey(input.llm.id) });
      qc.invalidateQueries({ queryKey: providerModelsQueryKey(input.llm.id) });
      qc.invalidateQueries({ queryKey: providerHealthQueryKey(input.llm.id) });
    },
  });
}
