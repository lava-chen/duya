// ProviderModelEditor.tsx
// Plan 205 Phase H5: chat-side model picker. Shows the user's
// currently-enabled models and lets them remove entries. Pulling
// a fresh model list from the provider API used to happen in-
// place via a broken `fetchModels` that called `testProviderIPC`
// with empty strings. Plan 205 removes that path — the user now
// goes to `ProviderEditView` (settings → providers → edit) to
// fetch a fresh list and pick the enabled set.
//
// Plan 203 Phase 2.6: state management delegated to
// `useModelSelection`. The component now only owns UI-only state
// (expanded, filter) and the IPC call to `upsertModelCapabilityIPC`.

'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  MagnifyingGlassIcon,
  CheckIcon,
  CaretDownIcon,
  CaretUpIcon,
  ArrowUpRightIcon,
} from '@/components/icons';
import { upsertModelCapabilityIPC } from '@/lib/ipc-client';
import { useModelSelection } from '@/components/settings/forms/hooks/useModelSelection';
import { useTranslation } from '@/hooks/useTranslation';
import { useConversationStore } from '@/stores/conversation-store';

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
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const enterProviderEdit = useConversationStore(
    (s) => s.enterProviderEdit,
  );

  // Delegate the model + capability state to the L2 hook.
  const selection = useModelSelection({
    initialEnabled: enabledModelIds,
  });

  // UI-only state.
  const [filter, setFilter] = useState('');

  // Sync the hook's enabled set with prop changes (only when
  // prop changes from outside; user toggles flow through the
  // hook directly).
  useEffect(() => {
    selection.setEnabledFromProp(enabledModelIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabledModelIds.join('|')]);

  // Plan 205: route the user to the settings page to fetch a
  // fresh model list. The chat-side editor no longer maintains
  // its own (broken) `allModels` cache.
  const openEditorForFreshModels = useCallback(() => {
    enterProviderEdit({ providerId });
  }, [enterProviderEdit, providerId]);

  // Wrap the hook's toggle with parent notification so the
  // enabled list in `MessageInput` stays accurate.
  const toggleAndNotify = useCallback(
    (modelId: string) => {
      const wasEnabled = selection.isEnabled(modelId);
      selection.toggleModel(modelId);
      onChange(
        wasEnabled
          ? enabledModelIds.filter((m) => m !== modelId)
          : Array.from(new Set([...enabledModelIds, modelId])),
      );
    },
    [selection, enabledModelIds, onChange],
  );

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
      } catch {
        // Capability upsert is best-effort; the model list still works.
      }
    },
    [selection, providerId],
  );

  // Derive the enabled list directly from the prop. Long lists
  // are common, so we keep a search filter.
  const enabledModelObjects = enabledModelIds
    .filter(
      (id) =>
        !filter || id.toLowerCase().includes(filter.toLowerCase()),
    )
    .map((id) => ({ id, display_name: id, context_length: undefined }));

  const formatContext = (ctx?: number) => {
    if (!ctx) return '';
    if (ctx >= 1000000) return `${(ctx / 1000000).toFixed(1)}M`;
    if (ctx >= 1000) return `${(ctx / 1000).toFixed(0)}K`;
    return String(ctx);
  };

  const selectedCount = enabledModelIds.length;

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
          {/* Plan 205: the Search + Refresh + Add controls are
              gone. The user goes to the settings page to fetch
              a fresh list and add new models. We keep the
              filter for the enabled list because long lists
              are common. */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border/30 bg-chip/50 text-[11px] text-muted-foreground">
            <MagnifyingGlassIcon
              size={12}
              className="text-muted-foreground shrink-0"
            />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter enabled models…"
              className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
            <button
              type="button"
              onClick={openEditorForFreshModels}
              className="inline-flex items-center gap-1 text-[10px] text-accent hover:underline shrink-0"
            >
              {t('provider.modelInput.fetch')}
              <ArrowUpRightIcon size={10} />
            </button>
          </div>

          {enabledModelObjects.length === 0 ? (
            <div className="px-3 py-4 text-xs text-muted-foreground text-center">
              {t('provider.modelInput.noEnabledHint')}
            </div>
          ) : (
            <div className="max-h-[300px] overflow-y-auto">
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
                      <div className="text-xs truncate font-mono">
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
            </div>
          )}

          <div className="px-3 py-1.5 border-t border-border/30 text-[10px] text-muted-foreground flex items-center justify-between">
            <span>
              {selectedCount} model{selectedCount !== 1 ? 's' : ''} selected
            </span>
            <button
              type="button"
              onClick={openEditorForFreshModels}
              className="inline-flex items-center gap-1 text-accent hover:underline"
            >
              {t('provider.modelInput.manageInSettings')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
