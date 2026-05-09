// ModelSelector.tsx - Compact model selector with settings navigation

'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  CaretDownIcon,
  CheckIcon,
  SpinnerGapIcon,
  GearSixIcon,
} from '@/components/icons';
import { useConversationStore } from '@/stores/conversation-store';

export interface ModelOption {
  id: string;
  display_name: string;
  context_length?: number;
  pricing?: { prompt: string; completion: string };
}

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
  const listRef = useRef<HTMLDivElement>(null);
  const { setCurrentView, setSettingsTab } = useConversationStore();

  const selectedModel = models.find(m => m.id === selectedModelId);
  const displayLabel = selectedModel?.display_name || selectedModelId || 'Select model';

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
            {loading ? 'Loading models...' : displayLabel}
          </span>
          <CaretDownIcon size={14} className="shrink-0 ml-2 text-muted-foreground" />
        </button>

        {/* Dropdown */}
        {open && (
          <div
            className="absolute z-50 mt-1 w-full border rounded-xl overflow-hidden"
            style={{
              backgroundColor: 'var(--sidebar-bg)',
              borderColor: 'var(--border)',
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
            }}
          >
            {/* Model list */}
            <div ref={listRef} className="max-h-[300px] overflow-y-auto scrollbar-thin">
              {models.length === 0 ? (
                <div className="px-3 py-4 text-sm text-center" style={{ color: 'var(--muted)' }}>
                  No models available
                </div>
              ) : (
                models.map(model => (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => handleSelect(model.id)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors"
                    style={{
                      backgroundColor: model.id === selectedModelId ? 'var(--surface)' : 'transparent',
                    }}
                    onMouseEnter={e => {
                      e.currentTarget.style.backgroundColor = 'var(--surface-hover)';
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.backgroundColor = model.id === selectedModelId ? 'var(--surface)' : 'transparent';
                    }}
                  >
                    <span className="shrink-0 w-4">
                      {model.id === selectedModelId && (
                        <CheckIcon size={14} style={{ color: 'var(--accent)' }} />
                      )}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate" style={{ color: 'var(--text)' }}>{model.display_name}</div>
                      <div className="text-[10px] truncate font-mono" style={{ color: 'var(--muted)' }}>
                        {model.id}
                      </div>
                    </div>
                    {model.context_length && (
                      <span className="shrink-0 text-[10px]" style={{ color: 'var(--muted)' }}>
                        {formatContext(model.context_length)}
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>

            {/* Settings button */}
            <button
              type="button"
              onClick={handleGoToSettings}
              className="w-full flex items-center gap-2 px-3 py-2 border-t text-xs transition-colors"
              style={{
                borderColor: 'var(--border)',
                color: 'var(--muted)',
                backgroundColor: 'transparent',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.backgroundColor = 'var(--surface-hover)';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.backgroundColor = 'transparent';
              }}
            >
              <GearSixIcon size={14} className="shrink-0" />
              <span>Manage providers</span>
            </button>
          </div>
        )}
      </div>
    );
  }

  // Compact variant for chat input
  return (
    <div ref={containerRef} className="relative" onKeyDown={handleKeyDown}>
      {/* Trigger button */}
      <button
        type="button"
        onClick={handleToggle}
        disabled={disabled || loading}
        className="flex items-center gap-1 px-2 py-1 rounded-lg transition-colors text-xs cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
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
        <span className="truncate max-w-[120px]" style={{ color: 'var(--text)' }}>
          {loading ? (
            <SpinnerGapIcon size={12} className="animate-spin inline" />
          ) : (
            displayLabel
          )}
        </span>
        <CaretDownIcon size={12} className="shrink-0" style={{ color: 'var(--muted)' }} />
      </button>

      {/* Dropdown */}
      {open && (
        <div
          className="absolute bottom-full left-0 mb-1 w-72 border rounded-xl overflow-hidden z-50"
          style={{
            backgroundColor: 'var(--sidebar-bg)',
            borderColor: 'var(--border)',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
          }}
        >
          {/* Model list */}
          <div ref={listRef} className="max-h-[250px] overflow-y-auto scrollbar-thin">
            {models.length === 0 ? (
              <div className="px-3 py-3 text-xs text-center" style={{ color: 'var(--muted)' }}>
                No models available
              </div>
            ) : (
              models.map(model => (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => handleSelect(model.id)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors"
                  style={{
                    backgroundColor: model.id === selectedModelId ? 'var(--surface)' : 'transparent',
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.backgroundColor = 'var(--surface-hover)';
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.backgroundColor = model.id === selectedModelId ? 'var(--surface)' : 'transparent';
                  }}
                >
                  <span className="shrink-0 w-3">
                    {model.id === selectedModelId && (
                      <CheckIcon size={12} style={{ color: 'var(--accent)' }} />
                    )}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs truncate" style={{ color: 'var(--text)' }}>{model.display_name}</div>
                    <div className="text-[10px] truncate font-mono" style={{ color: 'var(--muted)' }}>
                      {model.id}
                    </div>
                  </div>
                  {model.context_length && (
                    <span className="shrink-0 text-[10px]" style={{ color: 'var(--muted)' }}>
                      {formatContext(model.context_length)}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>

          {/* Settings button */}
          <button
            type="button"
            onClick={handleGoToSettings}
            className="w-full flex items-center gap-2 px-3 py-1.5 border-t text-xs transition-colors"
            style={{
              borderColor: 'var(--border)',
              color: 'var(--muted)',
              backgroundColor: 'transparent',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.backgroundColor = 'var(--surface-hover)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
          >
            <GearSixIcon size={12} className="shrink-0" />
            <span>Manage providers</span>
          </button>
        </div>
      )}
    </div>
  );
}
