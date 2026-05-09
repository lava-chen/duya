// SlashCommandPopover.tsx - Popover component for slash command selection

'use client';

import { useCallback } from 'react';
import type { PopoverItem, PopoverMode } from '@/types/slash-command';
import {
  TerminalIcon,
  QuestionIcon,
  EraserIcon,
  ChartLineIcon,
  BrainIcon,
  GlobeSimpleIcon,
} from '@/components/icons';

interface SlashCommandPopoverProps {
  popoverMode: PopoverMode;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  filteredItems: PopoverItem[];
  selectedIndex: number;
  popoverFilter: string;
  inputValue: string;
  triggerPos: number | null;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  allDisplayedItems: PopoverItem[];
  onInsertItem: (item: PopoverItem) => void;
  onSetSelectedIndex: (index: number) => void;
  onSetPopoverFilter: (filter: string) => void;
  onSetInputValue: (value: string) => void;
  onClosePopover: () => void;
  onFocusTextarea: () => void;
}

// Icon mapping for built-in commands
const ICON_MAP: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  '/help': QuestionIcon,
  '/clear': EraserIcon,
  '/cost': ChartLineIcon,
  '/compact': BrainIcon,
};

export function SlashCommandPopover({
  popoverMode,
  popoverRef,
  filteredItems,
  selectedIndex,
  popoverFilter,
  inputValue,
  triggerPos,
  searchInputRef,
  allDisplayedItems,
  onInsertItem,
  onSetSelectedIndex,
  onSetPopoverFilter,
  onSetInputValue,
  onClosePopover,
  onFocusTextarea,
}: SlashCommandPopoverProps) {
  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        onSetSelectedIndex((selectedIndex + 1) % allDisplayedItems.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        onSetSelectedIndex((selectedIndex - 1 + allDisplayedItems.length) % allDisplayedItems.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (allDisplayedItems[selectedIndex]) {
          onInsertItem(allDisplayedItems[selectedIndex]);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClosePopover();
        onFocusTextarea();
      }
    },
    [selectedIndex, allDisplayedItems, onSetSelectedIndex, onInsertItem, onClosePopover, onFocusTextarea],
  );

  const handleFilterChange = useCallback(
    (val: string) => {
      onSetPopoverFilter(val);
      onSetSelectedIndex(0);
      // Sync textarea: replace the filter portion after /
      if (triggerPos !== null) {
        const before = inputValue.slice(0, triggerPos + 1);
        onSetInputValue(before + val);
      }
    },
    [triggerPos, inputValue, onSetPopoverFilter, onSetSelectedIndex, onSetInputValue],
  );

  const renderItem = (item: PopoverItem, idx: number) => {
    const IconComponent = item.icon || (item.builtIn ? TerminalIcon : GlobeSimpleIcon);
    const isSelected = idx === selectedIndex;

    return (
      <div
        key={`${idx}-${item.value}`}
        className="flex items-center gap-3 px-3 py-2 cursor-pointer text-sm transition-colors"
        style={{
          backgroundColor: isSelected ? 'var(--accent-soft)' : 'transparent',
          color: isSelected ? 'var(--accent)' : 'var(--text)',
        }}
        onClick={() => onInsertItem(item)}
        onMouseEnter={() => onSetSelectedIndex(idx)}
        ref={isSelected ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
      >
        <IconComponent size={16} style={{ color: 'var(--muted)' }} />
        <span className="font-mono text-xs truncate">{item.label}</span>
        {item.description && (
          <span className="text-xs truncate max-w-[200px]" style={{ color: 'var(--muted)' }}>
            {item.description}
          </span>
        )}
      </div>
    );
  };

  if (!popoverMode || popoverMode === 'cli') return null;
  if (allDisplayedItems.length === 0) return null;

  return (
    <div ref={popoverRef} className="absolute bottom-full left-0 mb-2 w-full max-w-2xl z-50">
      <div
        className="border rounded-xl shadow-lg overflow-hidden"
        style={{ backgroundColor: 'var(--main-bg)', borderColor: 'var(--border)' }}
      >
        {/* Search header */}
        {popoverMode === 'skill' && (
          <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
            <input
              ref={searchInputRef}
              type="text"
              value={popoverFilter}
              onChange={(e) => handleFilterChange(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="Filter commands..."
              className="w-full px-3 py-1.5 text-sm rounded-lg focus:outline-none focus:ring-2 focus:ring-accent/50"
              style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
              autoFocus
            />
          </div>
        )}

        {/* Command list */}
        <div className="max-h-48 overflow-y-auto">
          {filteredItems.map((item, i) => renderItem(item, i))}
        </div>

        {/* Footer hint */}
        <div
          className="px-3 py-2 text-xs"
          style={{ borderTop: '1px solid var(--border)', color: 'var(--muted)' }}
        >
          <span className="mr-4">
            <kbd
              className="px-1.5 py-0.5 rounded text-[10px]"
              style={{ backgroundColor: 'var(--surface)' }}
            >↑↓</kbd> navigate
          </span>
          <span className="mr-4">
            <kbd
              className="px-1.5 py-0.5 rounded text-[10px]"
              style={{ backgroundColor: 'var(--surface)' }}
            >Enter</kbd> select
          </span>
          <span>
            <kbd
              className="px-1.5 py-0.5 rounded text-[10px]"
              style={{ backgroundColor: 'var(--surface)' }}
            >Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
