"use client";

/**
 * BotComposerExtras — bot-only composer capabilities: the `@`-context popover
 * (SlashCommandPopover driven by useSlashCommands) and its keyboard navigation.
 *
 * Mounted by Composer only when `showPlus` is set (bot host). Factoring this
 * out keeps useSlashCommands' `@` trigger detection away from the group-room
 * `@member` autocomplete, which owns `@` when `enableMentions` is set. Since
 * this is a conditionally-rendered component (not a conditional hook call),
 * hosting useSlashCommands here honours the Rules of Hooks.
 *
 * Keyboard navigation is exposed through the imperative handle so the owning
 * Composer can route the shared textarea's keydown through it and, once the
 * popover stops consuming keys, fall through to normal Enter-send.
 */

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { SlashCommandPopover } from './SlashCommandPopover';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import { filterItems } from '@/lib/message-input-logic';
import type { PopoverItem, PopoverMode } from '@/types/slash-command';
import type { ModeModifierId } from '@/types/mode-id';

export interface BotComposerExtrasHandle {
  /** Open the `@`-context popover (files + modes). */
  open(): void;
  /** Close the popover. */
  close(): void;
  /** Route a textarea keydown through popover navigation. Returns true when
   *  the key was consumed (caller should not fall through to Enter-send). */
  handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean;
}

interface BotComposerExtrasProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  draft: string;
  setDraft: (text: string) => void;
  draftKey: string | null;
  activeModes: Set<ModeModifierId>;
  onToggleMode: (mode: ModeModifierId) => void;
  onAddFiles: () => void;
  onActiveChange: (active: boolean) => void;
}

export const BotComposerExtras = forwardRef<BotComposerExtrasHandle, BotComposerExtrasProps>(
  function BotComposerExtras(
    { textareaRef, draft, setDraft, draftKey, activeModes, onToggleMode, onAddFiles, onActiveChange },
    ref,
  ) {
    const [popoverMode, setPopoverMode] = useState<PopoverMode>(null);
    const [popoverItems, setPopoverItems] = useState<PopoverItem[]>([]);
    const [popoverFilter, setPopoverFilter] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [triggerPos, setTriggerPos] = useState<number | null>(null);
    const popoverRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);

    const closePopover = useCallback(() => {
      setPopoverMode(null);
      setPopoverItems([]);
      setPopoverFilter('');
      setSelectedIndex(0);
      setTriggerPos(null);
    }, []);

    const filteredItems =
      popoverMode === 'skill' || popoverMode === 'context'
        ? filterItems(popoverItems, popoverFilter)
        : popoverItems;

    const { insertItem, contextItems } = useSlashCommands({
      textareaRef,
      inputValue: draft,
      setInputValue: setDraft,
      popoverMode,
      popoverFilter,
      triggerPos,
      setPopoverMode,
      setPopoverFilter,
      setPopoverItems,
      setSelectedIndex,
      setTriggerPos,
      closePopover,
      sessionId: draftKey ?? undefined,
    });

    // Report popover open state to the owning composer (drives `+` active
    // styling and the key-routing branch).
    useEffect(() => {
      onActiveChange(popoverMode !== null);
    }, [popoverMode, onActiveChange]);

    // When the `@` context popover is open, keep the items in sync with the
    // latest contextItems (attachments + modes).
    useEffect(() => {
      if (popoverMode === 'context') {
        setPopoverItems(contextItems);
      }
    }, [popoverMode, contextItems]);

    const open = useCallback(() => {
      setPopoverMode('context');
      setPopoverFilter('');
      setTriggerPos(null);
      setSelectedIndex(0);
      setPopoverItems(contextItems);
    }, [contextItems]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
        if (!popoverMode || popoverMode === 'cli' || filteredItems.length === 0) return false;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % filteredItems.length);
          return true;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length);
          return true;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const item = filteredItems[selectedIndex];
          if (!item) return false;
          switch (item.kind) {
            case 'settings_action':
              if (item.value === '__add_files') {
                onAddFiles();
              }
              closePopover();
              return true;
            case 'mode': {
              const modeValue = item.modeValue as ModeModifierId | undefined;
              if (modeValue) onToggleMode(modeValue);
              return true;
            }
            default:
              insertItem(item);
              return true;
          }
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          closePopover();
          return true;
        }
        return false;
      },
      [popoverMode, filteredItems, selectedIndex, insertItem, closePopover, onAddFiles, onToggleMode],
    );

    useImperativeHandle(
      ref,
      () => ({
        open,
        close: closePopover,
        handleKeyDown,
      }),
      [open, closePopover, handleKeyDown],
    );

    return popoverMode ? (
      <SlashCommandPopover
        popoverMode={popoverMode}
        popoverRef={popoverRef}
        filteredItems={filteredItems}
        selectedIndex={selectedIndex}
        popoverFilter={popoverFilter}
        inputValue={draft}
        triggerPos={triggerPos}
        searchInputRef={searchInputRef}
        allDisplayedItems={filteredItems}
        // Settings state (stubbed — the context popover for a bot only
        // surfaces files + modes, not session settings; the bot's model is
        // configured in the bot settings, not per chat).
        thinkingEffort={null}
        onSelectThinkingEffort={() => {}}
        modelId={undefined}
        providerId={undefined}
        responseStyles={[]}
        selectedStyle={null}
        onSelectStyle={() => {}}
        mcpServers={[]}
        onToggleMcpServer={() => {}}
        onAddFiles={onAddFiles}
        onRequestRecap={async () => ({ success: false, recap: null, error: 'Unsupported for bot chat' })}
        activeModes={activeModes}
        onToggleMode={onToggleMode}
        onInsertItem={insertItem}
        onSetSelectedIndex={setSelectedIndex}
        onSetPopoverFilter={setPopoverFilter}
        onSetInputValue={setDraft}
        onClosePopover={closePopover}
        onFocusTextarea={() => textareaRef.current?.focus()}
      />
    ) : null;
  },
);