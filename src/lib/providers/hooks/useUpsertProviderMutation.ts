/**
 * src/lib/providers/hooks/useUpsertProviderMutation.ts
 *
 * L1 React Query mutation for creating / updating a provider.
 *
 * Plan 203 Phase 1.1.
 *
 * Plan 209: rewrote the auth-merging logic to honor the
 * 3-state `apiKey` contract from `useProviderEditSave`:
 *
 *   apiKey === undefined  →  do not touch llm.auth (electron keeps
 *                            the existing key on disk).
 *   apiKey === ''         →  auth.type = 'none' (drop the key).
 *   apiKey === 'sk-...'   →  auth.type = 'api-key' with that key
 *                            (replace; electron rejects masks).
 *
 * The renderer MUST NOT include the mask in `llm.auth.apiKey`
 * before this layer — the mask is only safe to send as a
 * standalone `apiKey` field, never embedded in `llm.auth`.
 *
 * The DTO returned by the IPC handler is then projected to the
 * renderer DTO and pushed into the providers cache.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { upsertLlmProviderIPC } from '@/lib/ipc-client';
import { toRendererLlmProviderDTO, type RendererLlmProviderDTO } from '../ipc-types';
import { isMaskedKey } from '../secret';
import {
  modelCapabilitiesQueryKey,
  providerHealthQueryKey,
  providerModelsQueryKey,
  PROVIDERS_KEY,
} from './queryKeys';
import type { LlmProvider } from '../types';

export interface UpsertProviderInput {
  /** The LlmProvider entity to persist. `auth.apiKey` may be left
   *  undefined; the 3-state `apiKey` field below is the source of
   *  truth for the secret. */
  llm: LlmProvider;
  /**
   * User-intent apiKey.
   *  - `undefined` → keep existing (do not touch llm.auth).
   *  - `''`        → clear (auth.type = 'none').
   *  - non-empty   → replace (auth.type = 'api-key' with this value).
   *  Masked values (e.g. 'sk-a***cdef') are forwarded to electron,
   *  which will reject them with `code: 'masked_key'`.
   */
  apiKey: string | undefined;
}

function applyApiKey(
  llm: LlmProvider,
  apiKey: string | undefined,
): LlmProvider {
  if (apiKey === undefined) {
    return llm;
  }
  if (apiKey === '') {
    return {
      ...llm,
      auth: {
        ...llm.auth,
        type: 'none' as const,
        apiKey: undefined,
        accessToken: undefined,
      },
    };
  }
  return {
    ...llm,
    auth: {
      ...llm.auth,
      type: 'api-key' as const,
      apiKey,
    },
  };
}

export function useUpsertProviderMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      llm,
      apiKey,
    }: UpsertProviderInput): Promise<RendererLlmProviderDTO | null> => {
      // Defensive: if a caller wires the auth.apiKey to a masked
      // value (legacy bug surface), drop it. The standalone apiKey
      // field is the only place a raw value flows.
      const llmSafe = isMaskedKey(llm.auth?.apiKey)
        ? { ...llm, auth: { ...llm.auth, apiKey: undefined } }
        : llm;
      const finalLlm = applyApiKey(llmSafe, apiKey);
      const payload: Record<string, unknown> = {
        id: finalLlm.id,
        name: finalLlm.name,
        category: finalLlm.category,
        apiFormat: finalLlm.apiFormat,
        auth: finalLlm.auth,
        endpoints: finalLlm.endpoints,
        ui: finalLlm.ui,
        meta: finalLlm.meta,
        headers: finalLlm.headers,
        options: finalLlm.options,
        extraEnv: finalLlm.extraEnv,
      };
      const res = await upsertLlmProviderIPC(payload);
      if (!res.ok || !res.provider) {
        // Surface the IPC error code. Callers (useProviderEditSave
        // → ProviderEditView) display the message in the error
        // banner. A `masked_key` rejection is the most common case.
        const err = new Error(res.message ?? 'upsert failed') as Error & {
          code?: string;
        };
        err.code = res.code;
        throw err;
      }
      return toRendererLlmProviderDTO(res.provider as never);
    },
    onSuccess: (_dto, input) => {
      // Plan 209: invalidate ALL provider-list cache entries,
      // not just the `'all'` projection. The `['providers']`
      // prefix matches both `useProvidersQuery()` (key
      // `['providers', 'all']`) and
      // `useProvidersQuery('duya')` (key `['providers',
      // 'duya']`). Without the broad prefix, the ProviderList
      // view — which uses the typed `'duya'` projection —
      // would keep showing stale data.
      qc.invalidateQueries({ queryKey: PROVIDERS_KEY });
      qc.invalidateQueries({ queryKey: modelCapabilitiesQueryKey(input.llm.id) });
      qc.invalidateQueries({ queryKey: providerModelsQueryKey(input.llm.id) });
      qc.invalidateQueries({ queryKey: providerHealthQueryKey(input.llm.id) });
    },
  });
}
