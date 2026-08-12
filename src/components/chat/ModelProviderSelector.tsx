// ModelProviderSelector.tsx - Multi-level model/provider/effort picker for the
// chat composer. Trigger button shows "<model> <effort>". The first-level menu
// lists Provider / Model / Thinking / Manage. Picking a provider drills into
// that provider's model list (and applies it as the new provider), while Model
// directly lists the current provider's models.

'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CheckIcon,
  SpinnerGapIcon,
  GearSixIcon,
  CpuIcon,
  HardDrivesIcon,
  LightbulbIcon,
} from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import { useConversationStore } from '@/stores/conversation-store';

export interface EffortOption {
  value: string;
  label: string;
}

export interface ProviderModelGroup {
  id: string;
  name: string;
  models: ModelOption[];
}

export interface ModelOption {
  id: string;
  display_name: string;
  context_length?: number;
}

interface ModelProviderSelectorProps {
  /** Providers grouped by their models (prefixed ids). */
  providerGroups: ProviderModelGroup[];
  /** Currently selected model id (with `[provider] ` prefix). */
  selectedModelId: string;
  onSelectModel: (modelId: string, providerId?: string) => void;
  /** Thinking effort value + options. */
  effortValue?: string | null;
  effortOptions: EffortOption[];
  onSelectEffort: (effort: string | null) => void;
  disabled?: boolean;
  loading?: boolean;
}

type SubView = 'root' | 'provider' | 'model' | 'effort';

/** Parse a prefixed model id `[providerName] modelId` → { providerName, modelId } */
function parsePrefixed(id: string): { providerName: string | null; modelId: string } {
  const match = id.match(/^\[([^\]]+)\]\s*(.+)$/);
  if (match) return { providerName: match[1], modelId: match[2] };
  return { providerName: null, modelId: id.replace(/^"|"$/g, '') };
}

export function ModelProviderSelector({
  providerGroups,
  selectedModelId,
  onSelectModel,
  effortValue,
  effortOptions,
  onSelectEffort,
  disabled = false,
  loading = false,
}: ModelProviderSelectorProps) {
  const { t } = useTranslation();
  const { setCurrentView, setSettingsTab } = useConversationStore();
  const [open, setOpen] = useState(false);
  const [subView, setSubView] = useState<SubView>('root');
  const [drillProviderId, setDrillProviderId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Resolve the current provider group from the selected model's prefix.
  const selectedPrefixed = parsePrefixed(selectedModelId);
  const currentProvider =
    providerGroups.find((g) => g.name === selectedPrefixed.providerName) ??
    providerGroups[0] ??
    null;
  const currentProviderModels = currentProvider?.models ?? [];
  const selectedModel = currentProviderModels.find((m) => m.id === selectedModelId);
  const modelLabel = selectedModel?.display_name || selectedPrefixed.modelId || t('messageInput.selectModel');
  const effortLabel =
    effortOptions.find((o) => o.value === (effortValue || ''))?.label ??
    t('messageInput.effortAuto');

  // Close on click outside / Escape.
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleToggle = useCallback(() => {
    if (disabled) return;
    setOpen((prev) => {
      const next = !prev;
      if (next) setSubView('root');
      return next;
    });
  }, [disabled]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (subView !== 'root') setSubView('root');
      else setOpen(false);
    }
  }, [subView]);

  const handleSelectProvider = useCallback((provider: ProviderModelGroup) => {
    // Enter the chosen provider's model list; user picks a model, which applies
    // the new provider + model.
    setSubView('model');
    // Track which provider the model sub-view belongs to via a ref-ish state.
    setDrillProviderId(provider.id);
  }, []);

  const drillProvider = providerGroups.find((g) => g.id === drillProviderId) ?? currentProvider;
  const drillModels = drillProvider?.models ?? [];

  const handleSelectModel = useCallback(
    (modelId: string) => {
      const provider = providerGroups.find((g) => g.models.some((m) => m.id === modelId));
      onSelectModel(modelId, provider?.id);
      setOpen(false);
    },
    [onSelectModel, providerGroups],
  );

  const handleSelectEffort = useCallback(
    (value: string | null) => {
      onSelectEffort(value);
      setOpen(false);
    },
    [onSelectEffort],
  );

  const handleManageProviders = useCallback(() => {
    setSettingsTab('providers');
    setCurrentView('settings');
    setOpen(false);
  }, [setSettingsTab, setCurrentView]);

  const menuRowStyle = (active: boolean): React.CSSProperties => ({
    backgroundColor: active ? 'var(--command-menu-selected)' : 'transparent',
    color: 'var(--text)',
  });

  const menuGridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: '20px 1fr auto 16px',
    alignItems: 'center',
    gap: 8,
  };

  const listItemGridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    alignItems: 'center',
    gap: 8,
  };

  return (
    <div ref={containerRef} className="relative min-w-0 shrink" onKeyDown={handleKeyDown}>
      {/* Trigger button: <model> <effort> */}
      <button
        type="button"
        onClick={handleToggle}
        disabled={disabled || loading}
        className="flex min-w-0 max-w-full items-center gap-1.5 px-2 py-1.5 rounded-lg transition-colors text-xs cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 hover:bg-[var(--surface-hover)]"
        style={{ color: 'var(--text)', justifyContent: 'flex-start' }}
      >
        {loading ? (
          <SpinnerGapIcon size={12} className="animate-spin" style={{ color: 'var(--muted)' }} />
        ) : (
          <>
            <span className="min-w-0 max-w-[110px] shrink truncate" style={{ color: 'var(--text)' }}>
              {modelLabel}
            </span>
            <span className="shrink-0" style={{ color: 'var(--command-menu-muted)' }}>·</span>
            <span className="shrink-0" style={{ color: 'var(--muted)' }}>{effortLabel}</span>
          </>
        )}
        <CaretDownIcon size={12} className="shrink-0" style={{ color: 'var(--muted)' }} />
      </button>

      {open && (
        <div
          className="absolute left-0 z-50 bottom-full mb-1"
          style={{ width: subView === 'root' ? 240 : 280, maxWidth: 320 }}
        >
          <div
            className="command-menu-popover overflow-y-auto"
            style={{
              backgroundColor: 'var(--command-menu-bg)',
              border: '1px solid var(--command-menu-border)',
              borderRadius: 10,
              boxShadow: 'var(--command-menu-shadow)',
              padding: 3,
              maxHeight: 400,
            }}
          >
            {subView === 'root' && (
              <div role="listbox" className="flex flex-col" style={{ gap: 1 }}>
                {/* Provider */}
                <button
                  type="button"
                  role="option"
                  onClick={() => setSubView('provider')}
                  className="command-menu-row px-2.5 cursor-pointer select-none"
                  style={{ minHeight: 32, paddingTop: 4, paddingBottom: 4, borderRadius: 6, ...menuRowStyle(false), ...menuGridStyle }}
                >
                  <HardDrivesIcon size={14} style={{ color: 'var(--muted)' }} />
                  <span className="truncate text-left" style={{ fontSize: 12, fontWeight: 500 }}>{t('messageInput.provider')}</span>
                  <span className="truncate text-right" style={{ fontSize: 11, color: 'var(--command-menu-muted)' }}>
                    {currentProvider?.name ?? ''}
                  </span>
                  <CaretRightIcon size={12} style={{ color: 'var(--muted)' }} />
                </button>

                {/* Model */}
                <button
                  type="button"
                  role="option"
                  onClick={() => { setDrillProviderId(currentProvider?.id ?? null); setSubView('model'); }}
                  className="command-menu-row px-2.5 cursor-pointer select-none"
                  style={{ minHeight: 32, paddingTop: 4, paddingBottom: 4, borderRadius: 6, ...menuRowStyle(false), ...menuGridStyle }}
                >
                  <CpuIcon size={14} style={{ color: 'var(--muted)' }} />
                  <span className="truncate text-left" style={{ fontSize: 12, fontWeight: 500 }}>{t('messageInput.model')}</span>
                  <span className="truncate text-right" style={{ fontSize: 11, color: 'var(--command-menu-muted)' }}>{modelLabel}</span>
                  <CaretRightIcon size={12} style={{ color: 'var(--muted)' }} />
                </button>

                {/* Thinking effort */}
                <button
                  type="button"
                  role="option"
                  onClick={() => setSubView('effort')}
                  className="command-menu-row px-2.5 cursor-pointer select-none"
                  style={{ minHeight: 32, paddingTop: 4, paddingBottom: 4, borderRadius: 6, ...menuRowStyle(false), ...menuGridStyle }}
                >
                  <LightbulbIcon size={14} style={{ color: 'var(--muted)' }} />
                  <span className="truncate text-left" style={{ fontSize: 12, fontWeight: 500 }}>{t('messageInput.effort')}</span>
                  <span className="truncate text-right" style={{ fontSize: 11, color: 'var(--command-menu-muted)' }}>{effortLabel}</span>
                  <CaretRightIcon size={12} style={{ color: 'var(--muted)' }} />
                </button>

                {/* Manage providers */}
                <button
                  type="button"
                  role="option"
                  onClick={handleManageProviders}
                  className="command-menu-row px-2.5 cursor-pointer select-none"
                  style={{ minHeight: 32, paddingTop: 4, paddingBottom: 4, borderRadius: 6, ...menuRowStyle(false), ...menuGridStyle }}
                >
                  <GearSixIcon size={14} style={{ color: 'var(--muted)' }} />
                  <span className="truncate text-left" style={{ fontSize: 12, fontWeight: 500 }}>{t('messageInput.manageProviders')}</span>
                  <span />
                  <span />
                </button>
              </div>
            )}

            {subView === 'provider' && (
              <div role="listbox" className="flex flex-col" style={{ gap: 1 }}>
                <button
                  type="button"
                  onClick={() => setSubView('root')}
                  className="command-menu-row flex items-center gap-2 px-2.5 cursor-pointer select-none"
                  style={{ minHeight: 28, paddingTop: 4, paddingBottom: 4, borderRadius: 6, color: 'var(--text)' }}
                >
                  <CaretLeftIcon size={12} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                  <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)' }}>{t('messageInput.provider')}</span>
                </button>
                {providerGroups.map((provider) => {
                  const isActive = provider.id === currentProvider?.id;
                  return (
                    <button
                      key={provider.id}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onClick={() => handleSelectProvider(provider)}
                      className="command-menu-row px-2.5 cursor-pointer select-none"
                      style={{ minHeight: 32, paddingTop: 4, paddingBottom: 4, borderRadius: 6, ...menuRowStyle(isActive), ...listItemGridStyle }}
                    >
                      <div className="min-w-0 flex items-baseline" style={{ gap: 8 }}>
                        <span className="truncate" style={{ fontSize: 12, fontWeight: isActive ? 600 : 500, color: isActive ? 'var(--accent)' : 'var(--text)' }}>
                          {provider.name}
                        </span>
                        <span className="truncate" style={{ fontSize: 11, color: 'var(--command-menu-muted)' }}>
                          {provider.models.length} model{provider.models.length === 1 ? '' : 's'}
                        </span>
                      </div>
                      {isActive && <CheckIcon size={12} style={{ color: 'var(--accent)' }} />}
                    </button>
                  );
                })}
              </div>
            )}

            {subView === 'model' && (
              <div role="listbox" className="flex flex-col" style={{ gap: 1 }}>
                <button
                  type="button"
                  onClick={() => setSubView('root')}
                  className="command-menu-row flex items-center gap-2 px-2.5 cursor-pointer select-none"
                  style={{ minHeight: 28, paddingTop: 4, paddingBottom: 4, borderRadius: 6, color: 'var(--text)' }}
                >
                  <CaretLeftIcon size={12} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                  <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)' }}>
                    {drillProvider ? `${drillProvider.name} · ${t('messageInput.model')}` : t('messageInput.model')}
                  </span>
                </button>
                {drillModels.length === 0 ? (
                  <div className="px-2.5 py-2" style={{ fontSize: 11, color: 'var(--command-menu-muted)' }}>
                    {t('messageInput.noModelsAvailable')}
                  </div>
                ) : (
                  drillModels.map((model) => {
                    const isActive = model.id === selectedModelId;
                    return (
                      <button
                        key={model.id}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        onClick={() => handleSelectModel(model.id)}
                        className="command-menu-row px-2.5 cursor-pointer select-none"
                        style={{ minHeight: 32, paddingTop: 4, paddingBottom: 4, borderRadius: 6, ...menuRowStyle(isActive), ...listItemGridStyle }}
                      >
                        <div className="min-w-0 flex items-baseline" style={{ gap: 8 }}>
                          <span className="truncate" style={{ fontSize: 12, fontWeight: isActive ? 600 : 500, color: isActive ? 'var(--accent)' : 'var(--text)' }}>
                            {model.display_name}
                          </span>
                          {model.context_length ? (
                            <span className="truncate" style={{ fontSize: 11, color: 'var(--command-menu-muted)' }}>
                              {model.context_length >= 1000000
                                ? `${(model.context_length / 1000000).toFixed(1)}M`
                                : model.context_length >= 1000
                                  ? `${(model.context_length / 1000).toFixed(0)}K`
                                  : String(model.context_length)}
                            </span>
                          ) : null}
                        </div>
                        {isActive && <CheckIcon size={12} style={{ color: 'var(--accent)' }} />}
                      </button>
                    );
                  })
                )}
              </div>
            )}

            {subView === 'effort' && (
              <div role="listbox" className="flex flex-col" style={{ gap: 1 }}>
                <button
                  type="button"
                  onClick={() => setSubView('root')}
                  className="command-menu-row flex items-center gap-2 px-2.5 cursor-pointer select-none"
                  style={{ minHeight: 28, paddingTop: 4, paddingBottom: 4, borderRadius: 6, color: 'var(--text)' }}
                >
                  <CaretLeftIcon size={12} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                  <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)' }}>{t('messageInput.effort')}</span>
                </button>
                {effortOptions.map((option) => {
                  const isActive = (effortValue || '') === option.value;
                  return (
                    <button
                      key={option.value || 'auto'}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onClick={() => handleSelectEffort(option.value || null)}
                      className="command-menu-row px-2.5 cursor-pointer select-none"
                      style={{ minHeight: 32, paddingTop: 4, paddingBottom: 4, borderRadius: 6, ...menuRowStyle(isActive), ...listItemGridStyle }}
                    >
                      <span className="truncate text-left" style={{ fontSize: 12, fontWeight: isActive ? 600 : 500, color: isActive ? 'var(--accent)' : 'var(--text)' }}>
                        {option.label}
                      </span>
                      {isActive && <CheckIcon size={12} style={{ color: 'var(--accent)' }} />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}