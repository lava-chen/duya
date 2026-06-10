// ProviderModelEditor.tsx - Edit which models a provider can use
// Fetches available models from provider API, allows user to select/deselect
//
// Plan 203 Phase 2.6: state management delegated to `useModelSelection`.
// The component now only owns UI-only state (expanded, filter,
// customModelInput, fetch loading/error) and the IPC call to
// `upsertModelCapabilityIPC`. The model set + capability map + edit
// flow live in the L2 hook, which is unit-tested independently.

'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  MagnifyingGlassIcon,
  CheckIcon,
  SpinnerGapIcon,
  PlusIcon,
  CaretDownIcon,
  CaretUpIcon,
} from '@/components/icons';
import type { ModelOption } from './ModelSelector';
import { upsertModelCapabilityIPC } from '@/lib/ipc-client';
import { useModelSelection } from '@/components/settings/forms/hooks/useModelSelection';

interface ProviderModelEditorProps {
  providerId: string;
  /** Currently enabled model IDs stored in options_json.enabled_models */
  enabledModelIds: string[];
  /** Callback when user saves changes */
  onChange: (enabledModelIds: string[]) => void;
}

export function ProviderModelEditor({
  providerId,
  enabledModelIds,
  onChange,
}: ProviderModelEditorProps) {
  const [expanded, setExpanded] = useState(false);

  // Delegate the model + capability state to the L2 hook.
  const selection = useModelSelection({
    initialEnabled: enabledModelIds,
  });

  // UI-only state (kept in the component because they are display-only
  // and don't need cross-form sharing).
  const [allModels, setAllModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [customModelInput, setCustomModelInput] = useState('');

  // Sync the hook's enabled set with prop changes (only when prop changes
  // from outside; user toggles flow through the hook directly).
  useEffect(() => {
    selection.setEnabledFromProp(enabledModelIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabledModelIds.join('|')]);

  // Fetch models from provider API
  const fetchModels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (window.electronAPI?.net?.testProvider) {
        const result = await window.electronAPI.net.testProvider({
          provider_type: '',
          base_url: '',
          api_key: '',
          model: '',
        });
        if (result.success && result.message) {
          try {
            const data = JSON.parse(result.message);
            const models: ModelOption[] = (data.models || []).map((m: Record<string, unknown>) => ({
              id: m.id as string,
              display_name: (m.display_name as string) || (m.name as string) || (m.id as string),
              context_length: m.context_length as number | undefined,
              pricing: m.pricing as { prompt: string; completion: string } | undefined,
            }));
            setAllModels(models);
          } catch {
            setError('Failed to parse models response');
          }
        } else {
          setError(result.error?.message || 'Failed to fetch models');
        }
      } else {
        setError('Provider API not available');
      }
    } catch {
      setError('Network error fetching models');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on expand
  useEffect(() => {
    if (expanded && allModels.length === 0) {
      fetchModels();
    }
  }, [expanded, allModels.length, fetchModels]);

  // Wrap hook toggles to notify the parent on every change.
  const toggleAndNotify = useCallback(
    (modelId: string) => {
      selection.toggleModel(modelId);
      // The new set will be reflected in the next render; compute the
      // toggle's effect synchronously so the parent's enabledModelIds
      // stays accurate.
      const wasEnabled = selection.isEnabled(modelId);
      onChange(
        wasEnabled
          ? enabledModelIds.filter((m) => m !== modelId)
          : Array.from(new Set([...enabledModelIds, modelId])),
      );
    },
    [selection, enabledModelIds, onChange],
  );

  const addCustomModelAndNotify = useCallback(() => {
    const id = customModelInput.trim();
    if (!id) return;
    selection.addCustomModel(id);
    if (!allModels.find((m) => m.id === id)) {
      setAllModels((prev) => [...prev, { id, display_name: id }]);
    }
    if (!enabledModelIds.includes(id)) {
      onChange([...enabledModelIds, id]);
    }
    setCustomModelInput('');
  }, [customModelInput, allModels, enabledModelIds, onChange, selection]);

  // Per-model context window editor. Wraps the hook's
  // begin/commit/cancel with the IPC persistence call.
  const saveCapability = useCallback(
    async (modelId: string) => {
      const parsed = Number.parseInt(selection.editingCtxValue, 10);
      selection.commitEditContext();
      if (!Number.isFinite(parsed) || parsed <= 0) return;
      try {
        await upsertModelCapabilityIPC({
          providerId,
          modelId,
          contextWindow: parsed,
          source: 'user',
          updatedAt: Date.now(),
        });
        setAllModels((prev) =>
          prev.map((m) => (m.id === modelId ? { ...m, context_length: parsed } : m)),
        );
      } catch {
        // Capability upsert is best-effort; the model list still works.
      }
    },
    [selection, providerId],
  );

  const filteredModels = filter
    ? allModels.filter(
        (m) =>
          m.id.toLowerCase().includes(filter.toLowerCase()) ||
          m.display_name.toLowerCase().includes(filter.toLowerCase()),
      )
    : allModels;

  const enabledModelObjects = filteredModels.filter((m) => selection.isEnabled(m.id));
  const availableModels = filteredModels.filter((m) => !selection.isEnabled(m.id));

  const formatContext = (ctx?: number) => {
    if (!ctx) return '';
    if (ctx >= 1000000) return `${(ctx / 1000000).toFixed(1)}M`;
    if (ctx >= 1000) return `${(ctx / 1000).toFixed(0)}K`;
    return String(ctx);
  };

  const selectedCount = selection.enabledModels.size;

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        {expanded ? <CaretUpIcon size={12} /> : <CaretDownIcon size={12} />}
        Model Selection
        {selectedCount > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">
            {selectedCount}
          </span>
        )}
      </button>

      {expanded && (
        <div className="border border-border/50 rounded-lg overflow-hidden">
          {/* Search + actions bar */}
          <div className="flex items-center gap-2 p-2 border-b border-border/30 bg-chip/50">
            <MagnifyingGlassIcon size={14} className="text-muted-foreground shrink-0" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Type to filter models..."
              className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
            {loading && (
              <SpinnerGapIcon size={14} className="animate-spin text-muted-foreground" />
            )}
            <button
              type="button"
              onClick={fetchModels}
              className="text-[10px] text-accent hover:underline"
            >
              Refresh
            </button>
          </div>

          {/* Custom model input */}
          <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border/30">
            <input
              type="text"
              value={customModelInput}
              onChange={(e) => setCustomModelInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addCustomModelAndNotify();
                }
              }}
              placeholder="Add custom model ID..."
              className="flex-1 px-2 py-1 rounded border border-border/50 text-xs bg-chip text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent/50 font-mono"
            />
            <button
              type="button"
              onClick={addCustomModelAndNotify}
              disabled={!customModelInput.trim()}
              className="flex items-center gap-1 px-2 py-1 rounded border border-border/50 bg-chip text-[10px] hover:bg-accent/10 disabled:opacity-50"
            >
              <PlusIcon size={10} />
              Add
            </button>
          </div>

          {error && (
            <div className="px-3 py-2 text-xs text-destructive bg-destructive/10">
              {error}
            </div>
          )}

          {/* Model list */}
          <div className="max-h-[300px] overflow-y-auto">
            {/* Enabled models section */}
            {enabledModelObjects.length > 0 && (
              <>
                <div className="px-3 py-1 text-[10px] text-muted-foreground font-medium bg-chip/30 sticky top-0">
                  ENABLED ({enabledModelObjects.length})
                </div>
                {enabledModelObjects.map((model) => (
                  <div
                    key={model.id}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-accent/5 transition-colors"
                  >
                    <button
                      type="button"
                      onClick={() => toggleAndNotify(model.id)}
                      className="flex-1 flex items-center gap-2 min-w-0"
                    >
                      <span className="shrink-0 w-4 h-4 rounded border border-accent bg-accent/10 flex items-center justify-center">
                        <CheckIcon size={10} className="text-accent" />
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs truncate">{model.display_name}</div>
                        <div className="text-[10px] text-muted-foreground truncate font-mono">
                          {model.id}
                        </div>
                      </div>
                    </button>
                    {selection.editingCtxFor === model.id ? (
                      <input
                        autoFocus
                        type="number"
                        value={selection.editingCtxValue}
                        onChange={(e) => selection.setEditingCtxValue(e.target.value)}
                        onBlur={() => saveCapability(model.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveCapability(model.id);
                          if (e.key === 'Escape') selection.cancelEditContext();
                        }}
                        placeholder="ctx"
                        className="w-20 px-1.5 py-0.5 rounded border border-border/50 text-[10px] bg-chip text-foreground focus:outline-none focus:ring-1 focus:ring-accent/50"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => selection.beginEditContext(model.id, model.context_length)}
                        className="shrink-0 text-[10px] text-muted-foreground hover:text-accent"
                        title="Set context window"
                      >
                        {formatContext(
                          selection.modelCapabilities.get(model.id) ?? model.context_length,
                        ) || 'set ctx'}
                      </button>
                    )}
                  </div>
                ))}
              </>
            )}

            {/* Available models section */}
            {availableModels.length > 0 && (
              <>
                <div className="px-3 py-1 text-[10px] text-muted-foreground font-medium bg-chip/30 sticky top-0 border-t border-border/20">
                  AVAILABLE ({availableModels.length})
                </div>
                {availableModels.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => toggleAndNotify(model.id)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-accent/5 transition-colors"
                  >
                    <span className="shrink-0 w-4 h-4 rounded border border-border/50" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs truncate">{model.display_name}</div>
                      <div className="text-[10px] text-muted-foreground truncate font-mono">
                        {model.id}
                      </div>
                    </div>
                    {model.context_length && (
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {formatContext(model.context_length)}
                      </span>
                    )}
                  </button>
                ))}
              </>
            )}

            {/* Empty state */}
            {!loading && filteredModels.length === 0 && !error && (
              <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                {allModels.length === 0
                  ? 'No models available. Try adding a custom model ID above.'
                  : 'No models match your filter'}
              </div>
            )}

            {/* Loading */}
            {loading && allModels.length === 0 && (
              <div className="px-3 py-4 text-xs text-muted-foreground text-center flex items-center justify-center gap-2">
                <SpinnerGapIcon size={14} className="animate-spin" />
                Fetching models...
              </div>
            )}
          </div>

          {/* Footer with summary */}
          <div className="px-3 py-1.5 border-t border-border/30 text-[10px] text-muted-foreground flex items-center justify-between">
            <span>
              {selectedCount} model{selectedCount !== 1 ? 's' : ''} selected
            </span>
            <span>{allModels.length} available</span>
          </div>
        </div>
      )}
    </div>
  );
}
