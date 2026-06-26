// SlashCommandPopover.tsx - Popover component for slash command selection

'use client';

import { useCallback } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import type { PopoverItem, PopoverMode } from '@/types/slash-command';
import {
  QuestionIcon,
  EraserIcon,
  ChartLineIcon,
  BrainIcon,
  ClockCounterClockwiseIcon,
  CubeIcon,
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
  '/recap': ClockCounterClockwiseIcon,
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
  const { t } = useTranslation();
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
    const IconComponent = item.icon ?? (item.group === 'skills' ? CubeIcon : undefined);
    const isSelected = idx === selectedIndex;
    // Bilingual built-ins: `label` = primary title (CN),
    // `description` = secondary CN, `descriptionEn` = secondary EN.
    // Custom skills: only `description` is set (single language).
    const primary = item.label;
    const secondary = item.builtIn
      ? [item.description, item.descriptionEn].filter(Boolean).join(' · ')
      : item.description;
    const hasSecondary = Boolean(secondary);

    return (
      <div
        key={`${idx}-${item.value}`}
        role="option"
        aria-selected={isSelected}
        onClick={() => onInsertItem(item)}
        onMouseEnter={() => onSetSelectedIndex(idx)}
        ref={isSelected ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
        className="command-menu-row flex items-center gap-2 px-2.5 cursor-pointer select-none"
        style={{
          minHeight: hasSecondary ? 42 : 26,
          borderRadius: 8,
          backgroundColor: isSelected ? 'var(--command-menu-selected)' : 'transparent',
          color: 'var(--text)',
        }}
      >
        {IconComponent ? (
          <span
            style={{
              color: 'var(--muted)',
              flexShrink: 0,
              display: 'inline-flex',
              alignSelf: 'center',
            }}
          >
            <IconComponent size={14} />
          </span>
        ) : (
          <span
            className="font-mono"
            style={{
              color: 'var(--muted)',
              flexShrink: 0,
              width: 14,
              textAlign: 'center',
              fontSize: 11,
              alignSelf: 'center',
            }}
          >
            &gt;_
          </span>
        )}
        <div className="flex-1 min-w-0 flex flex-col" style={{ gap: 2 }}>
          <span
            className="truncate"
            style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', lineHeight: '15px' }}
          >
            {primary}
          </span>
          {secondary && (
            <span
              className="truncate"
              style={{ fontSize: 11, color: 'var(--command-menu-muted)', lineHeight: '14px' }}
            >
              {secondary}
            </span>
          )}
        </div>
        {item.value && item.builtIn && (
          <span
            className="truncate font-mono self-center"
            style={{ color: 'var(--command-menu-muted)', fontSize: 11, opacity: 0.55 }}
          >
            {item.value}
          </span>
        )}
      </div>
    );
  };

  if (!popoverMode || popoverMode === 'cli') return null;
  if (allDisplayedItems.length === 0) return null;

  const settingsItems = filteredItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.group !== 'skills');
  const skillItems = filteredItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.group === 'skills');

  const renderSection = (
    label: string,
    entries: Array<{ item: PopoverItem; index: number }>,
  ) => entries.length > 0 && (
    <section>
      <div
        className="px-2.5 pb-1 pt-2 text-[11px] font-medium"
        style={{ color: 'var(--command-menu-muted)' }}
      >
        {label}
      </div>
      {entries.map(({ item, index }) => renderItem(item, index))}
    </section>
  );

  return (
    <div
      ref={popoverRef}
      className="absolute bottom-full left-0 z-50"
      style={{ marginBottom: 8, width: '100%', maxWidth: 920 }}
    >
      <div
        className="command-menu-popover overflow-y-auto"
        style={{
          backgroundColor: 'var(--command-menu-bg)',
          border: '1px solid var(--command-menu-border)',
          borderRadius: 12,
          boxShadow: '0 6px 18px rgba(0, 0, 0, 0.32), 0 1px 4px rgba(0, 0, 0, 0.18)',
          padding: 4,
          // Cap to ~9 rows (built-in two-line ≈ 42px each) + padding;
          // rest scrolls inside.
          maxHeight: 42 * 9 + 8,
        }}
      >
        <div role="listbox" className="flex flex-col" style={{ gap: 1 }}>
          {renderSection(t('common.settings'), settingsItems)}
          {renderSection(t('settings.skills'), skillItems)}
        </div>
      </div>
    </div>
  );
}
