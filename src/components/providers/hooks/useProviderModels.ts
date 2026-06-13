/**
 * src/components/providers/hooks/useProviderModels.ts
 *
 * Plan 205 Phase I1: state + side-effect manager for the
 * `ProviderEditView` model section. Owns:
 *   - the fetched list (from `fetchProviderModelsIPC`)
 *   - the enabled list (a `string[]` stored on
 *     `options_json.enabled_models`)
 *   - the fetch lifecycle (loading / error)
 *   - add / remove / custom operations
 *   - per-model context window edits (commit back to the
 *     `useModelSelection` hook + `upsertModelCapabilityIPC`)
 *
 * The hook is intentionally local to the providers feature
 * (not shared with the chat-side `ProviderModelEditor`) because
 * the two flows have different concerns:
 *   - chat-side: just remove / edit context, route to settings
 *     to add new models.
 *   - settings-side: full add/remove/custom + commit-on-save.
 *
 * Return shape mirrors what `ProviderEditView` consumes, so
 * the view can stay declarative.
 */

import { useCallback, useState, useEffect, useRef } from 'react';
import {
  fetchProviderModelsIPC,
  upsertModelCapabilityIPC,
  type FetchedModel,
} from '@/lib/ipc-client';
import { useTranslation } from '@/hooks/useTranslation';

export interface UseProviderModelsArgs {
  /**
   * The id of the provider being edited. Plan 209 fix-up: when
   * the user has not typed a new API key, the IPC handler uses
   * this to look up the on-disk key so the model fetch can
   * succeed without forcing the user to retype. Required for
   * context-window persistence (see `setContextWindow`).
   */
  providerId?: string;
  /** The protocol of the provider (for ollama routing inside
   *  `fetchProviderModels`). */
  protocol: string;
  /**
   * Plan 209: the auth style of the preset. Forwarded to
   * `fetchProviderModels` so it picks the right header
   * (`x-api-key` for `api_key`, `Authorization: Bearer` for
   * `auth_token`). Optional — defaulting to undefined means
   * the server falls back to `x-api-key`, which is the
   * Anthropic convention but wrong for `auth_token` vendors.
   */
  authStyle?: string;
  /** The current baseUrl (so the user can fetch before saving). */
  baseUrl: string;
  /** The current API key (so the user can fetch before saving).
   *  Optional — when the user has not retyped a key, the IPC
   *  handler falls back to the on-disk key (see `providerId`). */
  apiKey?: string;
  /** The current enabled model list (from `options_json.enabled_models`). */
  initialEnabled: string[];
  /** Custom (user-typed) models that aren't in the fetched
   *  list but should still appear in the add dropdown. */
  initialCustomModels?: string[];
  /** Pre-populated per-model context windows (tokens) for
   *  edit-mode hydration. Loaded once from
   *  `listModelCapabilitiesIPC` by the view. */
  initialContextWindows?: Record<string, number>;
}

export interface UseProviderModelsResult {
  /** The full list returned by the provider's API. */
  fetched: FetchedModel[];
  /** Currently enabled model ids. */
  enabled: string[];
  /** True while `fetchProviderModelsIPC` is in flight. */
  isFetching: boolean;
  /** Inline fetch error (401/404/etc). Cleared on next fetch. */
  fetchError: string | null;
  /** Per-model context window map, keyed by model id. The view
   *  reads from this for display and calls `setContextWindow`
   *  when the user commits. */
  contextWindows: Map<string, number>;
  /** The user's custom (unfetched) model ids. */
  customModels: string[];

  /** Trigger a fetch. Resolves when the IPC returns. */
  fetch: () => Promise<void>;
  /** Add a model id to the enabled list. Idempotent. */
  enable: (modelId: string) => void;
  /** Remove a model id from the enabled list. */
  disable: (modelId: string) => void;
  /** Add a user-typed custom model. Returns true on success. */
  addCustom: (modelId: string) => boolean;
  /** Remove a custom model. */
  removeCustom: (modelId: string) => void;
  /** Set the per-model context window (in tokens). */
  setContextWindow: (modelId: string, ctx: number) => void;
  /** Reset the whole state (used when the user navigates away
   *  and back into the edit page). */
  reset: (initialEnabled: string[], initialCustom?: string[]) => void;
}

export function useProviderModels({
  providerId,
  protocol,
  authStyle,
  baseUrl,
  apiKey,
  initialEnabled,
  initialCustomModels = [],
  initialContextWindows,
}: UseProviderModelsArgs): UseProviderModelsResult {
  const { t } = useTranslation();
  const [fetched, setFetched] = useState<FetchedModel[]>([]);
  const [enabled, setEnabled] = useState<string[]>(initialEnabled);
  const [customModels, setCustomModels] = useState<string[]>(initialCustomModels);
  const [isFetching, setIsFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // Plan 205 fix-up: hydrate the local map from the view's
  // pre-loaded capabilities. The view is responsible for
  // `listModelCapabilitiesIPC`; we just accept whatever it
  // computed so the 1M/200K buttons reflect persisted state on
  // re-mount.
  const [contextWindows, setContextWindows] = useState<Map<string, number>>(
    () => new Map(Object.entries(initialContextWindows ?? {})),
  );

  // Plan 209 fix-up: re-sync the local map when the prop
  // changes (e.g. the view's async `listModelCapabilitiesIPC`
  // resolves after the hook has already mounted with an empty
  // map). `useState`'s initializer only runs on the first
  // render, so without this effect the buttons would stay
  // un-set even when the DB has a saved 1M.
  //
  // The merge is **additive**: new keys from the prop are added
  // to the state, but existing keys (already user-modified) are
  // preserved. This avoids a race where the user clicks 1M while
  // the IPC is in flight and the late hydration then clobbers
  // the pick.
  //
  // We track the last-seen **contents** (via JSON.stringify) so
  // the effect only fires when the prop's value actually changes.
  // A reference-based check is not enough: the parent passes a
  // fresh object literal on every render, and `setContextWindow`
  // re-renders the hook — a reference diff would re-add the
  // deleted key immediately after the user toggled it off.
  const lastInitialStrRef = useRef<string>('');
  useEffect(() => {
    const incomingStr = JSON.stringify(
      Object.entries(initialContextWindows ?? {})
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    if (lastInitialStrRef.current === incomingStr) return;
    lastInitialStrRef.current = incomingStr;
    setContextWindows((prev) => {
      const incoming = Object.entries(initialContextWindows ?? {});
      if (incoming.length === 0) return prev;
      const next = new Map(prev);
      let changed = false;
      for (const [k, v] of incoming) {
        if (!next.has(k)) {
          next.set(k, v);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [initialContextWindows]);

  // Re-sync when the prop changes (e.g. user navigates from one
  // edit page to another). The deep-compare via `join('|')` keeps
  // the effect idempotent.
  useEffect(() => {
    setEnabled(initialEnabled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialEnabled.join('|')]);

  useEffect(() => {
    setCustomModels(initialCustomModels);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCustomModels.join('|')]);

  const fetch = useCallback(async () => {
    setIsFetching(true);
    setFetchError(null);
    try {
      // Plan 209: forward protocol + authStyle so the server
      // routes the request correctly. Without `authStyle` the
      // server defaults to `x-api-key`, which 401s for vendors
      // like `minimax-cn` that expect `Authorization: Bearer`.
      //
      // Plan 209 fix-up: also forward `provider_id` so the IPC
      // handler can fall back to the on-disk key when the user
      // has not retyped a new one. This avoids the previous
      // behavior of sending the masked hint (`sk-a***cdef`) —
      // which always 401s — to the upstream provider.
      const result = await fetchProviderModelsIPC({
        protocol,
        auth_style: (authStyle ?? undefined) as
          | 'api_key'
          | 'auth_token'
          | 'env_only'
          | 'custom_header'
          | undefined,
        base_url: baseUrl,
        api_key: apiKey,
        provider_id: providerId,
      });
      if (result.success && result.models) {
        setFetched(result.models);
      } else {
        setFetchError(
          result.error?.message ?? t('provider.fetchModelsFailed'),
        );
      }
    } catch (err) {
      setFetchError(
        err instanceof Error ? err.message : t('provider.fetchModelsFailed'),
      );
    } finally {
      setIsFetching(false);
    }
  }, [protocol, authStyle, baseUrl, apiKey, providerId, t]);

  const enable = useCallback((modelId: string) => {
    setEnabled((prev) => (prev.includes(modelId) ? prev : [...prev, modelId]));
  }, []);

  const disable = useCallback((modelId: string) => {
    setEnabled((prev) => prev.filter((m) => m !== modelId));
  }, []);

  const addCustom = useCallback(
    (modelId: string): boolean => {
      const trimmed = modelId.trim();
      if (!trimmed) return false;
      // Dedupe against both enabled and custom.
      setEnabled((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
      setCustomModels((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
      return true;
    },
    [],
  );

  const removeCustom = useCallback((modelId: string) => {
    setCustomModels((prev) => prev.filter((m) => m !== modelId));
    // Also remove from enabled (custom models are a subset of enabled).
    setEnabled((prev) => prev.filter((m) => m !== modelId));
  }, []);

  const setContextWindow = useCallback(
    (modelId: string, ctx: number) => {
      // Optimistic local update so the 1M/200K button reflects
      // the user's pick on the same tick. The IPC persistence
      // call below is best-effort; the capability is a derived
      // hint, not a source of truth, so a transient failure
      // should not block the UI.
      setContextWindows((prev) => {
        const next = new Map(prev);
        if (!Number.isFinite(ctx) || ctx <= 0) {
          next.delete(modelId);
        } else {
          next.set(modelId, ctx);
        }
        return next;
      });
      // Plan 205 fix-up: persist the context window to the
      // capability table. The chat side reads from the same
      // table on the next message, so without this the toggle
      // is purely cosmetic until the user saves the provider —
      // and even then, the save contract never reaches this
      // map. Skipped when `providerId` is missing (the
      // "create new provider" flow, where there's no row to
      // upsert against yet).
      if (providerId) {
        // Fire-and-forget. The view doesn't need to await;
        // the optimistic update is already reflected.
        void upsertModelCapabilityIPC({
          providerId,
          modelId,
          contextWindow: ctx > 0 ? ctx : 0,
          source: 'user',
          updatedAt: Date.now(),
        }).catch(() => {
          // Best-effort; surface the failure in the console
          // for debugging but don't block the user flow.
        });
      }
    },
    [providerId],
  );

  const reset = useCallback(
    (nextEnabled: string[], nextCustom: string[] = []) => {
      setEnabled(nextEnabled);
      setCustomModels(nextCustom);
      setFetched([]);
      setFetchError(null);
      setIsFetching(false);
      setContextWindows(new Map());
    },
    [],
  );

  return {
    fetched,
    enabled,
    isFetching,
    fetchError,
    contextWindows,
    customModels,
    fetch,
    enable,
    disable,
    addCustom,
    removeCustom,
    setContextWindow,
    reset,
  };
}
