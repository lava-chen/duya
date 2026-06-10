/**
 * src/components/settings/forms/hooks/useModelSelection.ts
 *
 * L2 hook — concern: enabled models + custom model + context window.
 *
 * Plan 203 Phase 2.3: a single source of truth for the model-list
 * editor that `ProviderConnectDialog` and `ProviderModelEditor` both
 * implement today with ad-hoc `useState` clusters.
 *
 * The hook owns:
 * - the enabled-model set (toggle on / off)
 * - the user's custom models (free-text entries, not in the preset)
 * - the per-model contextWindow edit flow (begin / commit / cancel)
 *
 * It does NOT own the model list fetch; that is a separate concern
 * handled by `useProviderModelList` (or directly via
 * `getOllamaModelsIPC` / `syncProviderModelsIPC`). The hook receives
 * `presetModels` as a prop.
 */

import { useCallback, useMemo, useState } from 'react';

export interface ModelSelectionState {
  enabledModels: Set<string>;
  customModels: string[];
  /** Per-model context window overrides. modelId → tokens. */
  modelCapabilities: Map<string, number>;
  /** The model currently being edited for context window (or null). */
  editingCtxFor: string | null;
  /** The current edit input value (stringified number). */
  editingCtxValue: string;
  setEditingCtxValue: (next: string) => void;
  beginEditContext: (modelId: string, current?: number) => void;
  commitEditContext: () => void;
  cancelEditContext: () => void;
  toggleModel: (modelId: string) => void;
  addCustomModel: (modelId: string) => void;
  removeCustomModel: (modelId: string) => void;
  setContextWindow: (modelId: string, tokens: number) => void;
  isEnabled: (modelId: string) => boolean;
  /** Replace the enabled set from outside (e.g. when the parent's
   *  `enabledModelIds` prop changes due to async data load). */
  setEnabledFromProp: (modelIds: string[]) => void;
}

export interface UseModelSelectionInput {
  /** Initial set of enabled model ids. */
  initialEnabled?: string[];
  /** Initial custom models (user-typed, not in the preset). */
  initialCustom?: string[];
  /** Initial per-model context window overrides. */
  initialContextWindows?: Record<string, number>;
}

export function useModelSelection(
  input?: UseModelSelectionInput,
): ModelSelectionState {
  const initialEnabled = useMemo(
    () => new Set(input?.initialEnabled ?? []),
    // We only consume `initialEnabled` on the first render; subsequent
    // changes do not retroactively change the user's selections.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [enabledModels, setEnabledModels] = useState<Set<string>>(initialEnabled);
  const [customModels, setCustomModels] = useState<string[]>(input?.initialCustom ?? []);
  const [modelCapabilities, setModelCapabilities] = useState<Map<string, number>>(
    () => new Map(Object.entries(input?.initialContextWindows ?? {})),
  );
  const [editingCtxFor, setEditingCtxFor] = useState<string | null>(null);
  const [editingCtxValue, setEditingCtxValue] = useState<string>('');

  const isEnabled = useCallback(
    (modelId: string) => enabledModels.has(modelId),
    [enabledModels],
  );

  const setEnabledFromProp = useCallback((modelIds: string[]) => {
    setEnabledModels(new Set(modelIds));
  }, []);

  const toggleModel = useCallback((modelId: string) => {
    setEnabledModels((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  }, []);

  const addCustomModel = useCallback((modelId: string) => {
    const trimmed = modelId.trim();
    if (!trimmed) return;
    setCustomModels((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
    setEnabledModels((prev) => {
      if (prev.has(trimmed)) return prev;
      const next = new Set(prev);
      next.add(trimmed);
      return next;
    });
  }, []);

  const removeCustomModel = useCallback((modelId: string) => {
    setCustomModels((prev) => prev.filter((m) => m !== modelId));
    setEnabledModels((prev) => {
      if (!prev.has(modelId)) return prev;
      const next = new Set(prev);
      next.delete(modelId);
      return next;
    });
  }, []);

  const setContextWindow = useCallback((modelId: string, tokens: number) => {
    setModelCapabilities((prev) => {
      const next = new Map(prev);
      next.set(modelId, tokens);
      return next;
    });
  }, []);

  const beginEditContext = useCallback((modelId: string, current?: number) => {
    setEditingCtxFor(modelId);
    setEditingCtxValue(current !== undefined ? String(current) : '');
  }, []);

  const commitEditContext = useCallback(() => {
    if (!editingCtxFor) return;
    const tokens = Number.parseInt(editingCtxValue, 10);
    if (Number.isFinite(tokens) && tokens > 0) {
      setModelCapabilities((prev) => {
        const next = new Map(prev);
        next.set(editingCtxFor, tokens);
        return next;
      });
    }
    setEditingCtxFor(null);
    setEditingCtxValue('');
  }, [editingCtxFor, editingCtxValue]);

  const cancelEditContext = useCallback(() => {
    setEditingCtxFor(null);
    setEditingCtxValue('');
  }, []);

  return {
    enabledModels,
    customModels,
    modelCapabilities,
    editingCtxFor,
    editingCtxValue,
    setEditingCtxValue,
    beginEditContext,
    commitEditContext,
    cancelEditContext,
    toggleModel,
    addCustomModel,
    removeCustomModel,
    setContextWindow,
    isEnabled,
    setEnabledFromProp,
  };
}
