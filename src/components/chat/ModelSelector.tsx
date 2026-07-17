// ModelSelector.tsx - Compact model selector with settings navigation

'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  CaretDownIcon,
  SpinnerGapIcon,
  GearSixIcon,
} from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import { useConversationStore } from '@/stores/conversation-store';
import {
  OptionPanel,
  type OptionPanelItem,
  useOptionPanelPlacement,
} from '@/components/ui/OptionPanel';
import type { ModelOption } from '@duya/conductor/renderer';
export type { ModelOption } from '@duya/conductor/renderer';

interface ModelSelectorProps {
  models: ModelOption[];
  selectedModelId: string;
  onSelect: (modelId: string) => void;
  disabled?: boolean;
  loading?: boolean;
  /** Compact mode for chat input bar (default), or full mode for settings */
  variant?: 'compact' | 'full';
}

export function ModelSelector({
  models,
  selectedModelId,
  onSelect,
  disabled = false,
  loading = false,
  variant = 'compact',
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { placement, maxListHeight } = useOptionPanelPlacement(open, containerRef);
  const { setCurrentView, setSettingsTab } = useConversationStore();
  const { t } = useTranslation();

  const selectedModel = models.find(m => m.id === selectedModelId);
  const displayLabel = selectedModel?.display_name || selectedModelId || t('messageInput.selectModel');

  // Close on click outside
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
    setOpen(prev => !prev);
  }, [disabled]);

  const handleSelect = useCallback((modelId: string) => {
    onSelect(modelId);
    setOpen(false);
  }, [onSelect]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
    }
  }, []);

  const handleGoToSettings = useCallback(() => {
    setSettingsTab('providers');
    setCurrentView('settings');
    setOpen(false);
  }, [setSettingsTab, setCurrentView]);

  // Format context length for display
  const formatContext = (ctx?: number) => {
    if (!ctx) return '';
    if (ctx >= 1000000) return `${(ctx / 1000000).toFixed(1)}M`;
    if (ctx >= 1000) return `${(ctx / 1000).toFixed(0)}K`;
    return String(ctx);
  };

  const modelItems: OptionPanelItem[] = models.map((model) => ({
    id: model.id,
    label: model.display_name,
    description: model.id,
    meta: formatContext(model.context_length),
    searchText: `${model.display_name} ${model.id}`,
  }));

  const renderOptionPanel = (className: string) => (
    <OptionPanel
      className={className}
      title={t('messageInput.selectModel')}
      items={modelItems}
      selectedId={selectedModelId}
      onSelect={(item) => handleSelect(item.id)}
      onClose={() => setOpen(false)}
      maxListHeight={maxListHeight}
      searchPlaceholder={t('messageInput.searchModels')}
      emptyMessage={models.length === 0 ? t('messageInput.noModelsAvailable') : t('messageInput.noModelMatches')}
      footer={
        <button
          type="button"
          onClick={handleGoToSettings}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-colors hover:bg-[var(--surface-hover)]"
          style={{ color: 'var(--muted)' }}
        >
          <GearSixIcon size={13} className="shrink-0" />
          <span>{t('messageInput.manageProviders')}</span>
        </button>
      }
    />
  );

  if (variant === 'full') {
    return (
      <div ref={containerRef} className="relative" onKeyDown={handleKeyDown}>
        {/* Trigger button */}
        <button
          type="button"
          onClick={handleToggle}
          disabled={disabled || loading}
          className="w-full flex items-center justify-between px-3 py-2 rounded-lg border border-border/50 text-sm bg-chip text-foreground hover:border-accent/50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <span className="truncate">
            {loading ? t('messageInput.loadingModels') : displayLabel}
          </span>
          <CaretDownIcon size={14} className="shrink-0 ml-2 text-muted-foreground" />
        </button>

        {open && renderOptionPanel(`absolute left-0 z-50 w-full ${placement === 'below' ? 'top-full mt-1' : 'bottom-full mb-1'}`)}
      </div>
    );
  }

  // Compact variant for chat input
  return (
    <div ref={containerRef} className="relative min-w-0 shrink" onKeyDown={handleKeyDown}>
      {/* Trigger button */}
      <button
        type="button"
        onClick={handleToggle}
        disabled={disabled || loading}
        className="flex min-w-0 max-w-full items-center gap-1 px-2 py-1 rounded-lg transition-colors text-xs cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
        style={{
          backgroundColor: 'transparent',
        }}
        onMouseEnter={e => {
          if (!disabled) {
            e.currentTarget.style.backgroundColor = 'var(--surface-hover)';
          }
        }}
        onMouseLeave={e => {
          e.currentTarget.style.backgroundColor = 'transparent';
        }}
      >
        <span className="min-w-0 max-w-[120px] shrink truncate" style={{ color: 'var(--text)' }}>
          {loading ? (
            <SpinnerGapIcon size={12} className="animate-spin inline" />
          ) : (
            displayLabel
          )}
        </span>
        <CaretDownIcon size={12} className="shrink-0" style={{ color: 'var(--muted)' }} />
      </button>

      {open && renderOptionPanel(`absolute left-0 w-72 z-50 ${placement === 'below' ? 'top-full mt-1' : 'bottom-full mb-1'}`)}
    </div>
  );
}
