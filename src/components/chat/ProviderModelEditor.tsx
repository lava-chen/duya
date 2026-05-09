// ProviderModelEditor.tsx - Edit which models a provider can use
// Fetches available models from provider API, allows user to select/deselect

'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  MagnifyingGlassIcon,
  CheckIcon,
  SpinnerGapIcon,
  PlusIcon,
  XIcon,
  CaretDownIcon,
  CaretUpIcon,
} from '@/components/icons';
import type { ModelOption } from './ModelSelector';

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
  const [allModels, setAllModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set(enabledModelIds));
  const [customModelInput, setCustomModelInput] = useState('');
  // Track if we've synced with prop changes to avoid update loops
  const syncedRef = useRef(true);

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
  }, [providerId]);

  // Fetch on expand
  useEffect(() => {
    if (expanded && allModels.length === 0) {
      fetchModels();
    }
  }, [expanded, allModels.length, fetchModels]);

  // Sync selected set with prop changes only when needed (not from user interaction)
  useEffect(() => {
    if (syncedRef.current) {
      syncedRef.current = false;
      setSelected(new Set(enabledModelIds));
    }
  }, [enabledModelIds]);

  const toggleModel = useCallback((modelId: string) => {
    console.log("[ProviderModelEditor] toggleModel called:", modelId);
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(modelId)) {
        next.delete(modelId);
        console.log("[ProviderModelEditor] Removed model:", modelId);
      } else {
        next.add(modelId);
        console.log("[ProviderModelEditor] Added model:", modelId);
      }
      // Notify parent immediately
      const newSelected = Array.from(next);
      console.log("[ProviderModelEditor] Calling onChange with:", newSelected);
      onChange(newSelected);
      return next;
    });
  }, [onChange]);

  const addCustomModel = useCallback(() => {
    const id = customModelInput.trim();
    if (!id) return;
    if (selected.has(id)) {
      setCustomModelInput('');
      return;
    }

    // Add to selected and to allModels if not already present
    setSelected(prev => {
      const next = new Set(prev);
      next.add(id);
      onChange(Array.from(next));
      return next;
    });

    if (!allModels.find(m => m.id === id)) {
      setAllModels(prev => [...prev, { id, display_name: id }]);
    }

    setCustomModelInput('');
  }, [customModelInput, selected, allModels, onChange]);

  // Filter models
  const filteredModels = filter
    ? allModels.filter(m =>
        m.id.toLowerCase().includes(filter.toLowerCase()) ||
        m.display_name.toLowerCase().includes(filter.toLowerCase())
      )
    : allModels;

  // Separate into enabled (selected) and available
  const enabledModels = filteredModels.filter(m => selected.has(m.id));
  const availableModels = filteredModels.filter(m => !selected.has(m.id));

  const formatContext = (ctx?: number) => {
    if (!ctx) return '';
    if (ctx >= 1000000) return `${(ctx / 1000000).toFixed(1)}M`;
    if (ctx >= 1000) return `${(ctx / 1000).toFixed(0)}K`;
    return String(ctx);
  };

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        {expanded ? <CaretUpIcon size={12} /> : <CaretDownIcon size={12} />}
        Model Selection
        {selected.size > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">
            {selected.size}
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
              onChange={e => setFilter(e.target.value)}
              placeholder="Type to filter models..."
              className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
            {loading && <SpinnerGapIcon size={14} className="animate-spin text-muted-foreground" />}
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
              onChange={e => setCustomModelInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustomModel(); } }}
              placeholder="Add custom model ID..."
              className="flex-1 px-2 py-1 rounded border border-border/50 text-xs bg-chip text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent/50 font-mono"
            />
            <button
              type="button"
              onClick={addCustomModel}
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
            {enabledModels.length > 0 && (
              <>
                <div className="px-3 py-1 text-[10px] text-muted-foreground font-medium bg-chip/30 sticky top-0">
                  ENABLED ({enabledModels.length})
                </div>
                {enabledModels.map(model => (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => toggleModel(model.id)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-accent/5 transition-colors"
                  >
                    <span className="shrink-0 w-4 h-4 rounded border border-accent bg-accent/10 flex items-center justify-center">
                      <CheckIcon size={10} className="text-accent" />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs truncate">{model.display_name}</div>
                      <div className="text-[10px] text-muted-foreground truncate font-mono">{model.id}</div>
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

            {/* Available models section */}
            {availableModels.length > 0 && (
              <>
                <div className="px-3 py-1 text-[10px] text-muted-foreground font-medium bg-chip/30 sticky top-0 border-t border-border/20">
                  AVAILABLE ({availableModels.length})
                </div>
                {availableModels.map(model => (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => toggleModel(model.id)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-accent/5 transition-colors"
                  >
                    <span className="shrink-0 w-4 h-4 rounded border border-border/50" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs truncate">{model.display_name}</div>
                      <div className="text-[10px] text-muted-foreground truncate font-mono">{model.id}</div>
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
            <span>{selected.size} model{selected.size !== 1 ? 's' : ''} selected</span>
            <span>{allModels.length} available</span>
          </div>
        </div>
      )}
    </div>
  );
}
