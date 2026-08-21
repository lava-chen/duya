// ModelProviderSelector.tsx - Cascading provider/model/effort picker for the
// chat composer. Trigger button shows "<model> <effort>". The first-level menu
// lists every provider directly, plus Thinking and Manage at the bottom.
// Hovering/clicking a provider (or Thinking) opens a second-level flyout next
// to that row listing the provider's models (or the effort options), so the
// root menu stays visible while browsing.

'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  CaretDownIcon,
  CaretRightIcon,
  CheckIcon,
  SpinnerGapIcon,
  GearSixIcon,
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
  supportsVision?: boolean;
  supportsToolUse?: boolean;
  supportsReasoning?: boolean;
  format?: string | null;
  isLoaded?: boolean;
  reasoningEffortOptions?: string[];
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

type FlyoutView = 'models' | 'effort';

interface FlyoutState {
  view: FlyoutView;
  providerId?: string;
  /** Vertical offset of the anchor row within the popover (px). */
  top: number;
  /** Horizontal offset of the flyout relative to the root panel (px). */
  left: number;
  /** Max height so the flyout never extends past the viewport bottom. */
  maxHeight: number;
}

/** Parse a prefixed model id `[providerName] modelId` → { providerName, modelId } */
function parsePrefixed(id: string): { providerName: string | null; modelId: string } {
  const match = id.match(/^\[([^\]]+)\]\s*(.+)$/);
  if (match) return { providerName: match[1], modelId: match[2] };
  return { providerName: null, modelId: id.replace(/^"|"$/g, '') };
}

const FLYOUT_WIDTH = 216;

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
  const [flyout, setFlyout] = useState<FlyoutState | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rootPanelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  const effortRowRef = useRef<HTMLButtonElement | null>(null);

  // Resolve the current provider group from the selected model's prefix.
  const selectedPrefixed = parsePrefixed(selectedModelId);
  const currentProvider =
    providerGroups.find((g) => g.name === selectedPrefixed.providerName) ??
    providerGroups[0] ??
    null;
  const selectedModel = currentProvider?.models.find((m) => m.id === selectedModelId);
  const modelLabel = selectedModel?.display_name || selectedPrefixed.modelId || t('messageInput.selectModel');
  const effortLabel =
    effortOptions.find((o) => o.value === (effortValue || ''))?.label ??
    t('messageInput.effortAuto');

  // Close on click outside.
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setFlyout(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleToggle = useCallback(() => {
    if (disabled) return;
    setOpen((prev) => {
      const next = !prev;
      if (!next) setFlyout(null);
      return next;
    });
  }, [disabled]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        setFlyout(null);
      }
    },
    [],
  );

  /** Open a second-level flyout anchored to `anchor` (a row inside the root panel). */
  const openFlyout = useCallback((view: FlyoutView, anchor: HTMLElement | null, providerId?: string) => {
    const panel = rootPanelRef.current;
    if (!panel) return;
    const panelRect = panel.getBoundingClientRect();
    const top = anchor ? anchor.getBoundingClientRect().top - panelRect.top : 0;

    // Overlap the root panel edge so the two panels look connected (no gap).
    // Open to the right by default; flip to the left when it would overflow
    // the viewport's right edge.
    const overlap = 8;
    const openRight = panelRect.right + FLYOUT_WIDTH - overlap <= window.innerWidth - 8;
    const left = openRight ? panelRect.width - overlap : -(FLYOUT_WIDTH - overlap);

    // Never extend past the viewport bottom: shrink the flyout height to the
    // remaining space (it scrolls internally when there are many items).
    const viewportBottom = window.innerHeight - 8;
    const maxHeight = Math.max(160, Math.min(320, viewportBottom - (panelRect.top + top)));

    setFlyout({ view, providerId, top, left, maxHeight });
  }, []);

  const handleSelectModel = useCallback(
    (modelId: string) => {
      const provider = providerGroups.find((g) => g.models.some((m) => m.id === modelId));
      onSelectModel(modelId, provider?.id);
      setOpen(false);
      setFlyout(null);
    },
    [onSelectModel, providerGroups],
  );

  const handleSelectEffort = useCallback(
    (value: string | null) => {
      onSelectEffort(value);
      setOpen(false);
      setFlyout(null);
    },
    [onSelectEffort],
  );

  const handleManageProviders = useCallback(() => {
    setSettingsTab('providers');
    setCurrentView('settings');
    setOpen(false);
    setFlyout(null);
  }, [setSettingsTab, setCurrentView]);

  const flyoutProvider = flyout?.view === 'models'
    ? providerGroups.find((g) => g.id === flyout.providerId)
    : null;
  const flyoutModels = flyoutProvider?.models ?? [];

  const menuRowStyle = (active: boolean): React.CSSProperties => ({
    backgroundColor: active ? 'var(--command-menu-selected)' : 'transparent',
    color: 'var(--text)',
  });

  const listItemGridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    alignItems: 'center',
    gap: 8,
  };

  // Rows that show a trailing arrow as a third column (label / value / arrow).
  const arrowRowGridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: '1fr auto 16px',
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
          style={{ overflow: 'visible' }}
        >
          <div
            ref={rootPanelRef}
            className="relative"
          >
            {/* First-level menu: providers + thinking + manage */}
            <div
              className="command-menu-popover"
              style={{
                backgroundColor: 'var(--command-menu-bg)',
                border: '1px solid var(--command-menu-border)',
                borderRadius: 10,
                boxShadow: 'var(--command-menu-shadow)',
                padding: 3,
                width: 240,
              }}
            >
              <div
                ref={scrollRef}
                role="listbox"
                className="flex flex-col overflow-y-auto"
                style={{ gap: 1, maxHeight: 320 }}
              >
                {providerGroups.length === 0 ? (
                  <div className="px-2.5 py-2" style={{ fontSize: 11, color: 'var(--command-menu-muted)' }}>
                    {t('messageInput.noModelsAvailable')}
                  </div>
                ) : (
                  providerGroups.map((provider) => {
                    const isActive = provider.id === currentProvider?.id;
                    return (
                      <button
                        key={provider.id}
                        ref={(el) => { rowRefs.current.set(provider.id, el); }}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        onMouseEnter={() => openFlyout('models', rowRefs.current.get(provider.id) ?? null, provider.id)}
                        onClick={() => openFlyout('models', rowRefs.current.get(provider.id) ?? null, provider.id)}
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
                        <CaretRightIcon size={12} style={{ color: 'var(--muted)' }} />
                      </button>
                    );
                  })
                )}
              </div>

              {/* Thinking + Manage footer */}
              <div
                className="flex flex-col"
                style={{ gap: 1, marginTop: 3, borderTop: '1px solid var(--command-menu-border)', paddingTop: 3 }}
              >
                <button
                  ref={effortRowRef}
                  type="button"
                  role="option"
                  onMouseEnter={() => openFlyout('effort', effortRowRef.current)}
                  onClick={() => openFlyout('effort', effortRowRef.current)}
                  className="command-menu-row px-2.5 cursor-pointer select-none"
                  style={{ minHeight: 32, paddingTop: 4, paddingBottom: 4, borderRadius: 6, ...menuRowStyle(false), ...arrowRowGridStyle }}
                >
                  <span className="truncate text-left" style={{ fontSize: 12, fontWeight: 500 }}>{t('messageInput.effort')}</span>
                  <span className="truncate text-right" style={{ fontSize: 11, color: 'var(--command-menu-muted)' }}>{effortLabel}</span>
                  <CaretRightIcon size={12} style={{ color: 'var(--muted)' }} />
                </button>

                <button
                  type="button"
                  role="option"
                  onClick={handleManageProviders}
                  className="command-menu-row px-2.5 cursor-pointer select-none"
                  style={{ minHeight: 32, paddingTop: 4, paddingBottom: 4, borderRadius: 6, ...menuRowStyle(false), ...listItemGridStyle }}
                >
                  <span className="truncate text-left flex items-center gap-1.5" style={{ fontSize: 12, fontWeight: 500 }}>
                    <GearSixIcon size={13} className="shrink-0" style={{ color: 'var(--muted)' }} />
                    {t('messageInput.manageProviders')}
                  </span>
                  <span />
                </button>
              </div>
            </div>

            {/* Second-level flyout: models for a provider, or effort options */}
            {flyout && (
              <div
                className="command-menu-popover overflow-y-auto"
                style={{
                  position: 'absolute',
                  top: flyout.top,
                  left: flyout.left,
                  width: FLYOUT_WIDTH,
                  zIndex: 20,
                  backgroundColor: 'var(--command-menu-bg)',
                  border: '1px solid var(--command-menu-border)',
                  borderRadius: 10,
                  boxShadow: 'var(--command-menu-shadow)',
                  padding: 3,
                  maxHeight: flyout.maxHeight,
                }}
              >
                {flyout.view === 'models' ? (
                  <div role="listbox" className="flex flex-col" style={{ gap: 1 }}>
                    {flyoutModels.length === 0 ? (
                      <div className="px-2.5 py-2" style={{ fontSize: 11, color: 'var(--command-menu-muted)' }}>
                        {t('messageInput.noModelsAvailable')}
                      </div>
                    ) : (
                      flyoutModels.map((model) => {
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
                ) : (
                  <div role="listbox" className="flex flex-col" style={{ gap: 1 }}>
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
            )}
          </div>
        </div>
      )}
    </div>
  );
}
