/**
 * src/lib/providers/hooks/useProviderEditSave.ts
 *
 * Plan 205 Phase C: shared save logic for the `ProviderEditView`
 * page. Centralizes the upsert + cache invalidation flow that
 * used to live inside `ProviderManagement.handleSave`. Both the
 * legacy `ProviderConnectDialog` and the new `ProviderEditView`
 * consume this hook.
 *
 * Plan 209: rewrote the `apiKey` contract. The hook no longer
 * stamps the (possibly masked) string into `auth.apiKey`. Instead
 * it passes the user-intent value as a separate field:
 *
 *   apiKey === undefined  →  "user did not modify, keep current"
 *   apiKey === ''         →  "user explicitly cleared, drop the key"
 *   apiKey === 'sk-...'   →  "user typed a new key, replace"
 *
 * The mutation layer (`useUpsertProviderMutation`) translates this
 * to the right `AuthConfig` shape. The electron `provider-store`
 * adds a final mask-detection check (defense in depth).
 */

import { useCallback } from 'react';
import { useUpsertProviderMutation } from './useUpsertProviderMutation';
import { findPresetByKey } from '@/lib/providers';
import { QUICK_PRESETS, type QuickPreset } from '@/lib/provider-presets';
import type { LlmProvider } from '@/lib/providers';
import { extractErrorMessage } from '@/lib/errors/extractErrorMessage';

export interface ProviderEditFormData {
  name: string;
  provider_type: string;
  protocol: string;
  base_url: string;
  /**
   * User-intent apiKey. The 3-state contract:
   *  - `undefined` → keep existing (renderer did not modify)
   *  - `''`        → clear (user explicitly removed it)
   *  - non-empty   → replace (user typed a new value)
   *
   * `useApiKeyState` derives this from its `keyState` field.
   */
  api_key: string | undefined;
  extra_env: string;
  role_models_json?: string;
  enabled_models?: string[];
  /**
   * Plan 209 P4-prime: structured options object (enabled_models,
   * custom_models, title_model, role_models, defaultModel).
   * Forwarded to `LlmProvider.options` so the renderer DTO and
   * the IPC runtime config both see the user's selections.
   * The form is responsible for building this; the save hook
   * just relays it.
   */
  options?: Record<string, unknown>;
  options_json?: string;
  notes?: string;
  /**
   * Plan 209 / Fix-up: the caller's stable preset id
   * (e.g. 'minimax-cn'). When adding a provider from the
   * picker, the preset `key` is the only stable identifier
   * and MUST be used as the provider id, otherwise an entry
   * already created via the onboarding flow (which uses
   * `id: preset.key`) gets silently overwritten.
   * Optional — fully-custom providers without a preset skip
   * this and fall back to `generateProviderId`.
   */
  preset_id?: string;
  /**
   * Plan 209: the existing provider DTO (renderer projection).
   * Used on edit to preserve `headers` / `extraEnv` round-trip
   * and to keep the `meta` fields the form doesn't manage.
   * Optional for backwards compat — the form is the only caller.
   */
  existing_provider_dto?: {
    headers?: string;
    extraEnv?: string;
    notes?: string;
  };
}

export interface UseProviderEditSaveResult {
  save: (data: ProviderEditFormData, editingId: string | null) => Promise<void>;
  isPending: boolean;
  error: string | null;
}

function safeParse(json: string | undefined | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function generateProviderId(
  providerType: string,
  name: string,
  existingIds: string[],
): string {
  const baseId = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || providerType.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (!existingIds.includes(baseId)) return baseId;
  const suffix = crypto.randomUUID().slice(-8);
  return `${baseId}-${suffix}`;
}

export function useProviderEditSave(): UseProviderEditSaveResult {
  const upsert = useUpsertProviderMutation();

  const save = useCallback(
    async (data: ProviderEditFormData, editingId: string | null) => {
      // Plan 205 Phase J fix: `findPresetByKey` can return
      // undefined for providers whose protocol is not in the
      // preset registry (custom user-added providers). For
      // edits, we don't actually need the preset to match the
      // protocol — we need it to read the canonical
      // `category` / `apiFormat` / `ui` defaults. When the
      // preset isn't found, we fall back to the existing
      // provider's fields (preserved on edit) or the protocol
      // string itself.
      const newPreset = findPresetByKey(data.provider_type);
      const category =
        newPreset?.category ??
        (data.provider_type === 'openai-compatible' ? 'custom' : 'custom');
      const apiFormat = newPreset?.apiFormat ?? (data.provider_type as never);
      const ui = newPreset?.ui;

      // Plan 209: build the LlmProvider WITHOUT stamping the
      // apiKey into `auth.apiKey`. We carry the user-intent value
      // separately on the mutation input (`apiKey` field) so the
      // mutation layer can apply the 3-state contract atomically.
      //
      // Note: when `data.api_key === undefined` (the 'untouched'
      // branch of the 3-state machine), `auth.apiKey` is also
      // undefined here. The provider-store backend detects this
      // case and re-attaches the existing on-disk apiKey before
      // validation, so the save does not get rejected with
      // `auth.missingApiKey`.
      const llmAuth = { type: 'api-key' as const };
      // Plan 209: preserve `meta`, `headers`, and `extraEnv`
      // across edits. The pre-Plan-209 implementation rebuilt
      // `meta` on every save, which silently dropped the
      // `active` tag and re-created timestamps.
      const existingDto = data.existing_provider_dto;
      const sharedMeta = {
        id: editingId ?? '',
        name: data.name,
        category,
        apiFormat,
        auth: llmAuth,
        endpoints: { baseUrl: data.base_url, isFullUrl: false },
        ...(ui ? { ui } : {}),
        // Plan 209 P4-prime: thread the structured options
        // (enabled_models, title_model, role_models, ...) onto
        // the LlmProvider. Without this, the LlmProvider
        // round-trip via `provider-store.persist()` loses the
        // user's model selections and the chat fails with
        // "No model configured in provider".
        meta: {
          createdAt: Date.now(),
          updatedAt: Date.now(),
          sortIndex: 0,
        },
        headers: existingDto ? safeParse(existingDto.headers) : {},
        extraEnv: existingDto ? safeParse(existingDto.extraEnv) : {},
        ...(data.options && Object.keys(data.options).length > 0
          ? { options: data.options }
          : {}),
      };

      if (editingId) {
        await upsert.mutateAsync({
          llm: {
            ...sharedMeta,
            id: editingId,
            auth: llmAuth,
          } as LlmProvider,
          apiKey: data.api_key,
        });
      } else {
        // Plan 209 / Fix-up: when adding from the picker the
        // caller already knows the preset's stable `key`
        // (e.g. 'minimax-cn', 'kimi-cn'). Using it as the
        // provider id prevents `generateProviderId` from
        // colliding with an existing onboarding entry that
        // was created with the same preset key. The caller
        // passes the preferred id via `data.preset_id` when
        // present; we still fall back to `generateProviderId`
        // for fully-custom providers that have no preset.
        const providerId =
          data.preset_id || generateProviderId(data.provider_type, data.name, []);
        await upsert.mutateAsync({
          llm: {
            ...sharedMeta,
            id: providerId,
            auth: llmAuth,
            meta: {
              ...sharedMeta.meta,
              tags: ['active'],
            },
          } as LlmProvider,
          apiKey: data.api_key,
        });
      }
    },
    [upsert],
  );

  // Surface mutation error to the caller. We don't catch the
  // thrown error here — callers handle it via try/catch.
  const error = upsert.error
    ? extractErrorMessage(upsert.error).message
    : null;

  return { save, isPending: upsert.isPending, error };
}

// Re-export so existing call sites can keep their import path.
export { QUICK_PRESETS, type QuickPreset };

/**
 * Plan 205: legacy alias for `ProviderFormData` from the
 * deprecated `ProviderConnectDialog`. The onboarding flow
 * (outside this plan's scope) still imports it; we keep an
 * alias here so the import path can be migrated incrementally
 * without breaking the build.
 *
 * @deprecated use `ProviderEditFormData` in new code.
 */
export type ProviderFormData = ProviderEditFormData;
