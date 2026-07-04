// SlashCommandPopover.tsx - Unified command popover (settings + mode + skills)

'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import type { PopoverItem, PopoverMode, SettingsSubmenu } from '@/types/slash-command';
import {
  CubeIcon,
  CaretLeftIcon,
  CheckIcon,
} from '@/components/icons';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface McpServerInfo {
  name: string;
  description?: string;
  enabled?: boolean;
}

interface ResponseStyleInfo {
  id: string;
  name: string;
  description?: string;
}

interface ThinkingEffortOption {
  value: string | null;
  label: string;
  description: string;
}

const THINKING_EFFORT_OPTIONS: ThinkingEffortOption[] = [
  { value: null, label: 'Auto', description: 'Default thinking level' },
  { value: 'low', label: 'Low', description: 'Quick responses' },
  { value: 'medium', label: 'Medium', description: 'Balanced approach' },
  { value: 'high', label: 'High', description: 'Deep reasoning' },
  { value: 'max', label: 'Max', description: 'Maximum capability' },
];

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
  placement?: 'top' | 'bottom';

  // Settings state + callbacks
  thinkingEffort: string | null;
  onSelectThinkingEffort: (effort: string | null) => void;
  responseStyles: ResponseStyleInfo[];
  selectedStyle: string | null;
  onSelectStyle: (styleId: string) => void;
  mcpServers: McpServerInfo[];
  onToggleMcpServer: (name: string, enabled: boolean) => void;
  onAddFiles: () => void;

  // Action commands (/compact, /memory, /export, /recap)
  onExecuteAction: (action: string) => void;

  // Mode state (mutually exclusive single-select)
  currentMode: string | null;
  onSelectMode: (mode: string | null) => void;

  // Skill insertion (existing behavior)
  onInsertItem: (item: PopoverItem) => void;
  onSetSelectedIndex: (index: number) => void;
  onSetPopoverFilter: (filter: string) => void;
  onSetInputValue: (value: string) => void;
  onClosePopover: () => void;
  onFocusTextarea: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

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
  placement = 'top',

  thinkingEffort,
  onSelectThinkingEffort,
  responseStyles,
  selectedStyle,
  onSelectStyle,
  mcpServers,
  onToggleMcpServer,
  onAddFiles,

  onExecuteAction,

  currentMode,
  onSelectMode,

  onInsertItem,
  onSetSelectedIndex,
  onSetPopoverFilter,
  onSetInputValue,
  onClosePopover,
  onFocusTextarea,
}: SlashCommandPopoverProps) {
  const [subView, setSubView] = useState<SettingsSubmenu | null>(null);
  // The actual scrollable container is the outer .command-menu-popover div
  // (it owns overflow-y-auto + maxHeight). listboxRef points to that element
  // so we can keep selected rows visible without scrollIntoView side effects.
  const listboxRef = useRef<HTMLDivElement>(null);
  // Tracks the origin of the last selectedIndex change.
  // 'mouse' = hover changed selection → must NOT auto-scroll (would fight the
  //           mouse and cause flicker / jump-back).
  // 'keyboard' = ArrowUp/Down changed selection → should auto-scroll to keep
  //              the highlighted row visible.
  const lastSelectSource = useRef<'mouse' | 'keyboard'>('mouse');

  // -----------------------------------------------------------------------
  // Item click handler — dispatches by kind
  // -----------------------------------------------------------------------
  const handleItemClick = useCallback((item: PopoverItem) => {
    switch (item.kind) {
      case 'settings_action':
        if (item.value === '__add_files') {
          onAddFiles();
          onClosePopover();
        } else {
          // /compact, /memory, /export, /recap
          onExecuteAction(item.value);
          onClosePopover();
        }
        return;

      case 'settings_submenu':
        setSubView(item.submenu ?? null);
        return;

      case 'mode': {
        const modeValue = item.modeValue ?? '';
        // Toggle: if already active, deactivate; otherwise activate.
        onSelectMode(currentMode === modeValue ? null : modeValue);
        // Don't close — user may want to see the selection.
        return;
      }

      default:
        // slash_command, agent_skill — insert into input.
        onInsertItem(item);
        return;
    }
  }, [onAddFiles, onClosePopover, onExecuteAction, onInsertItem, onSelectMode, currentMode]);

  // -----------------------------------------------------------------------
  // Keyboard handler (for main view only)
  // -----------------------------------------------------------------------
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (subView) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setSubView(null);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onClosePopover();
      onFocusTextarea();
    }
  }, [subView, onClosePopover, onFocusTextarea]);

  // -----------------------------------------------------------------------
  // Detect keyboard arrow navigation so the scroll effect knows to run.
  // We listen on the capture phase so this fires before the textarea's
  // own keydown handler changes selectedIndex — by the time the scroll
  // effect runs, lastSelectSource is already 'keyboard'.
  // -----------------------------------------------------------------------
  useEffect(() => {
    const markKeyboard = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Home' || e.key === 'End') {
        lastSelectSource.current = 'keyboard';
      }
    };
    window.addEventListener('keydown', markKeyboard, true);
    return () => window.removeEventListener('keydown', markKeyboard, true);
  }, []);

  // -----------------------------------------------------------------------
  // Close popover when clicking outside of it.
  // Uses mousedown (not click) so we close before any inner onClick fires,
  // and checks whether the pointer landed inside the popover container.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!popoverMode) return;
    const handlePointerDown = (e: MouseEvent) => {
      const popoverEl = popoverRef.current;
      if (popoverEl && popoverEl.contains(e.target as Node)) return;
      // Don't close when clicking the plus toggle button — its onClick
      // handles the open/close toggle. Without this, mousedown closes the
      // popover before onClick fires, so the button could only ever open.
      if ((e.target as HTMLElement).closest('[data-plus-trigger]')) return;
      // Click landed outside — close.
      onClosePopover();
    };
    // Defer attaching by one tick so the same click that opened the popover
    // (e.g. the plus button) doesn't immediately close it.
    const timer = window.setTimeout(() => {
      document.addEventListener('mousedown', handlePointerDown, true);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mousedown', handlePointerDown, true);
    };
  }, [popoverMode, onClosePopover, popoverRef]);

  // -----------------------------------------------------------------------
  // Scroll the selected row into view — but ONLY for keyboard navigation.
  // Mouse-hover changes to selectedIndex must not trigger scrolling, because
  // the user is already pointing at the row with their cursor; auto-scrolling
  // would move the list under the mouse, trigger another mouseenter on a
  // different row, and loop — manifesting as flicker and the highlight
  // disagreeing with the hovered row.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (subView) return;
    if (lastSelectSource.current !== 'keyboard') return;
    const container = listboxRef.current;
    if (!container) return;
    const rows = container.querySelectorAll<HTMLElement>('[role="option"]');
    const target = rows[selectedIndex];
    if (!target) return;
    const cTop = container.scrollTop;
    const cBottom = cTop + container.clientHeight;
    const tTop = target.offsetTop;
    const tBottom = tTop + target.offsetHeight;
    // Only scroll if the row is actually outside the visible window.
    if (tTop < cTop) {
      container.scrollTop = tTop;
    } else if (tBottom > cBottom) {
      container.scrollTop = tBottom - container.clientHeight;
    }
  }, [selectedIndex, subView, allDisplayedItems]);

  // -----------------------------------------------------------------------
  // Row renderer
  // -----------------------------------------------------------------------
  const renderRow = (item: PopoverItem, idx: number, isActive: boolean) => {
    const IconComponent = item.icon ?? (item.group === 'skills' ? CubeIcon : undefined);
    const isSelected = isActive;

    // For mode items, show a check if active.
    // For settings_submenu items, show a caret-right.
    // For settings items with a current value, show it on the right.
    const isModeActive = item.kind === 'mode' && currentMode === item.modeValue;
    const isSubmenu = item.kind === 'settings_submenu';

    // Current value label for submenu items
    let currentValueLabel: string | null = null;
    if (item.submenu === 'thinking') {
      const opt = THINKING_EFFORT_OPTIONS.find(o => o.value === thinkingEffort);
      currentValueLabel = opt?.label ?? null;
    } else if (item.submenu === 'style') {
      const style = responseStyles.find(s => s.id === selectedStyle);
      currentValueLabel = style?.name ?? null;
    } else if (item.submenu === 'mcp') {
      const enabledCount = mcpServers.filter(s => s.enabled).length;
      currentValueLabel = `${enabledCount}/${mcpServers.length}`;
    }

    return (
      <div
        key={`${idx}-${item.value}`}
        role="option"
        aria-selected={isSelected}
        onClick={() => handleItemClick(item)}
        onMouseEnter={() => {
          // Mark as mouse-originated so the scroll effect won't fight the cursor.
          lastSelectSource.current = 'mouse';
          onSetSelectedIndex(idx);
        }}
        onMouseMove={() => {
          // If the pointer moves over a different row without a mouseenter
          // (e.g. after a keyboard scroll moved a row under the cursor),
          // keep the source flagged as mouse so we don't scroll again.
          lastSelectSource.current = 'mouse';
        }}
        className="command-menu-row flex items-center gap-2 px-2.5 cursor-pointer select-none"
        style={{
          minHeight: 28,
          paddingTop: 4,
          paddingBottom: 4,
          borderRadius: 6,
          backgroundColor: isSelected ? 'var(--command-menu-selected)' : 'transparent',
          color: 'var(--text)',
        }}
      >
        {IconComponent ? (
          <span style={{ color: 'var(--muted)', flexShrink: 0, display: 'inline-flex', alignSelf: 'center' }}>
            <IconComponent size={14} />
          </span>
        ) : (
          <span className="font-mono" style={{ color: 'var(--muted)', flexShrink: 0, width: 14, textAlign: 'center', fontSize: 11, alignSelf: 'center' }}>
            &gt;_
          </span>
        )}
        <div className="flex-1 min-w-0 flex items-baseline" style={{ gap: 8 }}>
          <span
            className="truncate flex-shrink-0"
            style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', lineHeight: '16px' }}
          >
            {item.label}
          </span>
          {item.description && (
            <span className="truncate" style={{ fontSize: 11, color: 'var(--command-menu-muted)', lineHeight: '14px' }}>
              {item.description}
            </span>
          )}
        </div>
        {/* Right side indicators */}
        {isModeActive && (
          <CheckIcon size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} />
        )}
        {currentValueLabel && (
          <span style={{ fontSize: 11, color: 'var(--command-menu-muted)', flexShrink: 0 }}>
            {currentValueLabel}
          </span>
        )}
        {isSubmenu && (
          <CaretLeftIcon size={10} style={{ color: 'var(--command-menu-muted)', flexShrink: 0, transform: 'rotate(180deg)' }} />
        )}
      </div>
    );
  };

  // -----------------------------------------------------------------------
  // Section renderer. Maps the parent's global `selectedIndex` (index in
  // `filteredItems`) into a per-section row index so the highlight lines
  // up with what the user is actually hovering / keyboard-stepping to.
  // Without this conversion, hovering the first row of any group would
  // either never highlight (if global idx != 0) or always highlight
  // (if global idx == 0), since the global idx has no meaning inside a
  // specific section.
  // -----------------------------------------------------------------------
  const renderSection = (
    label: string,
    items: PopoverItem[],
    startIndex: number,
  ) => items.length > 0 && (
    <section>
      <div
        className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium"
        style={{ color: 'var(--command-menu-muted)' }}
      >
        {label}
      </div>
      {items.map((item, idx) => renderRow(item, idx, startIndex + idx === selectedIndex))}
    </section>
  );

  // -----------------------------------------------------------------------
  // Sub-view renderer
  // -----------------------------------------------------------------------
  const renderSubView = () => {
    if (!subView) return null;

    const backLabel = {
      thinking: 'Thinking',
      style: 'Output style',
      mcp: 'MCP',
    }[subView];

    return (
      <div role="listbox" className="flex flex-col" style={{ gap: 1 }}>
        {/* Back button */}
        <div
          className="command-menu-row flex items-center gap-2 px-2.5 cursor-pointer select-none"
          onClick={() => setSubView(null)}
          style={{
            minHeight: 28,
            paddingTop: 4,
            paddingBottom: 4,
            borderRadius: 6,
            color: 'var(--text)',
          }}
        >
          <CaretLeftIcon size={12} style={{ color: 'var(--muted)', flexShrink: 0 }} />
          <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)' }}>
            {backLabel}
          </span>
        </div>

        {/* Thinking options */}
        {subView === 'thinking' && (
          <section>
            <div className="px-2.5 pb-1 pt-1 text-[11px] font-medium" style={{ color: 'var(--command-menu-muted)' }}>
              Thinking effort
            </div>
            {THINKING_EFFORT_OPTIONS.map((option) => {
              const isActive = thinkingEffort === option.value;
              return (
                <div
                  key={option.value || 'auto'}
                  role="option"
                  aria-selected={isActive}
                  onClick={() => {
                    onSelectThinkingEffort(option.value);
                    onClosePopover();
                  }}
                  className="command-menu-row flex items-center gap-2 px-2.5 cursor-pointer select-none"
                  style={{
                    minHeight: 28,
                    paddingTop: 4,
                    paddingBottom: 4,
                    borderRadius: 6,
                    backgroundColor: isActive ? 'var(--command-menu-selected)' : 'transparent',
                    color: 'var(--text)',
                  }}
                >
                  <div className="flex-1 min-w-0 flex items-baseline" style={{ gap: 8 }}>
                    <span className="truncate flex-shrink-0" style={{ fontSize: 12, fontWeight: isActive ? 600 : 500, color: isActive ? 'var(--accent)' : 'var(--text)', lineHeight: '16px' }}>
                      {option.label}
                    </span>
                    <span className="truncate" style={{ fontSize: 11, color: 'var(--command-menu-muted)', lineHeight: '14px' }}>
                      {option.description}
                    </span>
                  </div>
                  {isActive && <CheckIcon size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} />}
                </div>
              );
            })}
          </section>
        )}

        {/* Style options */}
        {subView === 'style' && (
          <section>
            <div className="px-2.5 pb-1 pt-1 text-[11px] font-medium" style={{ color: 'var(--command-menu-muted)' }}>
              Output style
            </div>
            {responseStyles.length === 0 ? (
              <div className="px-2.5 py-2 text-[12px]" style={{ color: 'var(--command-menu-muted)' }}>
                No styles available
              </div>
            ) : (
              responseStyles.map((style) => {
                const isActive = selectedStyle === style.id;
                return (
                  <div
                    key={style.id}
                    role="option"
                    aria-selected={isActive}
                    onClick={() => {
                      onSelectStyle(style.id);
                      onClosePopover();
                    }}
                    className="command-menu-row flex items-center gap-2 px-2.5 cursor-pointer select-none"
                    style={{
                      minHeight: 28,
                      paddingTop: 4,
                      paddingBottom: 4,
                      borderRadius: 6,
                      backgroundColor: isActive ? 'var(--command-menu-selected)' : 'transparent',
                      color: 'var(--text)',
                    }}
                  >
                    <div className="flex-1 min-w-0 flex items-baseline" style={{ gap: 8 }}>
                      <span className="truncate flex-shrink-0" style={{ fontSize: 12, fontWeight: isActive ? 600 : 500, color: isActive ? 'var(--accent)' : 'var(--text)', lineHeight: '16px' }}>
                        {style.name}
                      </span>
                      {style.description && (
                        <span className="truncate" style={{ fontSize: 11, color: 'var(--command-menu-muted)', lineHeight: '14px' }}>
                          {style.description}
                        </span>
                      )}
                    </div>
                    {isActive && <CheckIcon size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} />}
                  </div>
                );
              })
            )}
          </section>
        )}

        {/* MCP options */}
        {subView === 'mcp' && (
          <section>
            <div className="px-2.5 pb-1 pt-1 text-[11px] font-medium" style={{ color: 'var(--command-menu-muted)' }}>
              MCP servers
            </div>
            {mcpServers.length === 0 ? (
              <div className="px-2.5 py-2 text-[12px]" style={{ color: 'var(--command-menu-muted)' }}>
                No MCP servers configured
              </div>
            ) : (
              mcpServers.map((server) => {
                const isEnabled = server.enabled ?? false;
                return (
                  <div
                    key={server.name}
                    onClick={() => onToggleMcpServer(server.name, !isEnabled)}
                    className="command-menu-row flex items-center gap-2 px-2.5 cursor-pointer select-none"
                    style={{
                      minHeight: 28,
                      paddingTop: 4,
                      paddingBottom: 4,
                      borderRadius: 6,
                      color: 'var(--text)',
                    }}
                  >
                    <div className="flex-1 min-w-0 flex items-baseline" style={{ gap: 8 }}>
                      <span className="truncate flex-shrink-0" style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', lineHeight: '16px' }}>
                        {server.name}
                      </span>
                      {server.description && (
                        <span className="truncate" style={{ fontSize: 11, color: 'var(--command-menu-muted)', lineHeight: '14px' }}>
                          {server.description}
                        </span>
                      )}
                    </div>
                    {/* Toggle switch */}
                    <div
                      style={{
                        width: 28,
                        height: 16,
                        borderRadius: 8,
                        backgroundColor: isEnabled ? 'var(--accent)' : 'var(--command-menu-border)',
                        position: 'relative',
                        flexShrink: 0,
                        transition: 'background-color 0.15s',
                      }}
                    >
                      <div
                        style={{
                          position: 'absolute',
                          top: 2,
                          left: isEnabled ? 14 : 2,
                          width: 12,
                          height: 12,
                          borderRadius: 6,
                          backgroundColor: '#fff',
                          transition: 'left 0.15s',
                        }}
                      />
                    </div>
                  </div>
                );
              })
            )}
          </section>
        )}
      </div>
    );
  };

  // -----------------------------------------------------------------------
  // Early returns
  // -----------------------------------------------------------------------
  if (!popoverMode || popoverMode === 'cli') return null;
  if (allDisplayedItems.length === 0 && !subView) return null;

  // -----------------------------------------------------------------------
  // Partition items into 3 groups
  // -----------------------------------------------------------------------
  // When filtering (typing after /), static settings/mode items are always
  // shown; only skill/action items are filtered.
  const settingsGroup = filteredItems.filter(
    (item) => item.group === 'settings' || item.kind === 'settings_action' || item.kind === 'settings_submenu',
  );
  const modeGroup = filteredItems.filter(
    (item) => item.group === 'mode' || item.kind === 'mode',
  );
  const skillGroup = filteredItems.filter(
    (item) => item.group === 'skills' && item.kind !== 'settings_action',
  );

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  return (
    <div
      ref={popoverRef}
      className={`absolute left-0 z-50 ${placement === 'bottom' ? 'top-full' : 'bottom-full'}`}
      style={{
        [placement === 'bottom' ? 'marginTop' : 'marginBottom']: 8,
        width: '100%',
        maxWidth: 920,
      }}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={listboxRef}
        className="command-menu-popover overflow-y-auto"
        style={{
          backgroundColor: 'var(--command-menu-bg)',
          border: '1px solid var(--command-menu-border)',
          borderRadius: 10,
          boxShadow: 'var(--command-menu-shadow)',
          padding: 3,
          maxHeight: 28 * 10 + 40,
        }}
      >
        {subView ? (
          renderSubView()
        ) : (
          <div role="listbox" className="flex flex-col" style={{ gap: 1 }}>
            {renderSection('Settings', settingsGroup, 0)}
            {renderSection('Mode', modeGroup, settingsGroup.length)}
            {renderSection('Skills', skillGroup, settingsGroup.length + modeGroup.length)}
          </div>
        )}
      </div>
    </div>
  );
}
