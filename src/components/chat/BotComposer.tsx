'use client';

/**
 * BotComposer.tsx — Telegram-style chat input for BotDirectChatView.
 *
 * Visual consistency with the Session ChatView (MessageInput):
 *   - Rounded shell with a clean input row: [plus] [textarea] [send/stop]
 *   - Auto-expanding textarea (mirror-div technique, max 120px)
 *   - Send enabled only when there is non-whitespace text
 *   - Stop (■) shown while the bot is streaming
 *
 * The model is NOT picked here: a bot's model/provider is configured once in
 * the bot settings (create/edit dialog + BotSettingsPanel) and the view
 * injects it into the send payload.
 *
 * Reuses the session composer's components (2026-09-05):
 *   - SlashCommandPopover + useSlashCommands — the `+` button opens the same
 *     `@` context popup as the session (添加附件 + modes). `/`-typed command
 *     mode is intentionally NOT wired here: a 1:1 bot chat has no session
 *     settings (compaction / recap / output style) to surface.
 *   - useAttachments — the session's unified attachment state (files/images).
 *
 * Props:
 *   disabled    — true when the bot has no bound session
 *   busy        — true while streaming or queued
 *   onSend      — called with a BotComposerSendPayload when the user sends
 *   onStop      — called when user clicks Stop
 */

import React, { useRef, useCallback, useState } from 'react';
import { ArrowUpIcon, PlusIcon, XIcon } from '@/components/icons';
import { IconButton } from '@/components/ui/IconButton';
import { useTranslation } from '@/hooks/useTranslation';
import { useBotDraft } from './bot/draft';
import { useAttachments } from '@/hooks/useAttachments';
import { SlashCommandPopover } from './SlashCommandPopover';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import { filterItems } from '@/lib/message-input-logic';
import type { PopoverItem, PopoverMode } from '@/types/slash-command';
import type { ModeModifierId } from '@/types/mode-id';
import { MODE_KIND, toggleModeInSet, isModeExcludedByActive } from '@/types/mode-id';
import type { FileAttachment } from '@/types/message';

export interface BotComposerSendPayload {
  text: string;
  /** Raw model id (no `[provider] ` prefix). Injected by the view from the bot's settings; absent → default provider model. */
  model?: string;
  /** Provider store id the model belongs to. Injected by the view. */
  providerId?: string;
  /** Message-level mode (plan-task / research / ...). */
  mode?: string;
  /** User-attached files (files/images). */
  files?: FileAttachment[];
  /** Message being replied to (attached by the view from its reply state). */
  replyTo?: { id: string; text: string };
}

interface BotComposerProps {
  /** Bot session ID for draft persistence key */
  botId?: string | null;
  disabled?: boolean;
  busy?: boolean;
  onSend: (payload: BotComposerSendPayload) => void;
  onStop?: () => void;
  placeholder?: string;
  /** Active reply target — renders the "Replying to …" chip above the input. */
  replyPreview?: { id: string; text: string } | null;
  /** Cancels the active reply (chip ✕). */
  onClearReply?: () => void;
  /** Optional slot in the right action group next to the send button (the
   *  context-usage ring). Self-contained node — the composer only places it. */
  contextRing?: React.ReactNode;
}

/**
 * Message-level mode for the send payload: goal wins, otherwise the first
 * non-conductor active mode (conductor is session-level, not per-message).
 */
function pickSendMode(activeModes: Set<ModeModifierId>): string | undefined {
  if (activeModes.has('goal')) return 'goal';
  for (const mode of activeModes) {
    if (mode !== 'conductor') return mode;
  }
  return undefined;
}

/** Keep session-level modes (conductor, plan-task); clear per-message ones. */
function clearMessageModes(prev: Set<ModeModifierId>): Set<ModeModifierId> {
  const next = new Set<ModeModifierId>();
  for (const mode of prev) {
    if (MODE_KIND[mode] === 'session') next.add(mode);
  }
  return next;
}

export function BotComposer({
  botId,
  disabled = false,
  busy = false,
  onSend,
  onStop,
  placeholder,
  replyPreview,
  onClearReply,
  contextRing,
}: BotComposerProps) {
  const { t } = useTranslation();
  // Plan 491 P2.1: Use bot draft hook for persistence per botId
  const { draft, setDraft, clearDraft } = useBotDraft(botId ?? null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Plan 220 Phase 4: unified attachment state (reused from the session).
  const {
    attachments,
    addFile,
    remove: removeAttachment,
    clear: clearAttachments,
  } = useAttachments();

  // ---------------------------------------------------------------------------
  // Plus-button context popover — reuses the session's SlashCommandPopover.
  // ---------------------------------------------------------------------------
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
    sessionId: botId ?? undefined,
  });

  // Open the `@` context popup (添加附件 + modes) — the plus button opens this
  // directly, exactly like MessageInput's openContextPopover.
  const openContextPopover = useCallback(() => {
    setPopoverMode('context');
    setPopoverFilter('');
    setTriggerPos(null);
    setSelectedIndex(0);
    setPopoverItems(contextItems);
  }, [contextItems]);

  // Mode toggling for the context popover (visual state only — the agent
  // server resolves the actual per-run mode from the payload).
  const [activeModes, setActiveModes] = useState<Set<ModeModifierId>>(new Set());
  const handleToggleMode = useCallback((mode: ModeModifierId) => {
    setActiveModes((prev) => {
      if (!prev.has(mode) && isModeExcludedByActive(prev, mode)) return prev;
      return toggleModeInSet(prev, mode);
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Auto-resize + submit
  // ---------------------------------------------------------------------------
  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!ta || !mirror) return;
    mirror.textContent = ta.value + '\n';
    const newHeight = Math.min(mirror.scrollHeight, 120);
    ta.style.height = `${newHeight}px`;
  }, []);

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    resizeTextarea();
  };

  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (!text || disabled || busy) return;
    const mode = pickSendMode(activeModes);
    onSend({
      text,
      mode,
      files: attachments.length > 0 ? attachments : undefined,
    });
    clearDraft();
    clearAttachments();
    setActiveModes((prev) => clearMessageModes(prev));
    // Reset height after clearing
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    if (mirrorRef.current) mirrorRef.current.textContent = '';
  }, [
    draft, disabled, busy, onSend, activeModes, attachments, clearDraft, clearAttachments,
  ]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    if (!input.files) return;
    for (const file of Array.from(input.files)) {
      await addFile(file);
    }
    input.value = '';
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Keyboard navigation when the context popover is open.
    if (popoverMode && popoverMode !== 'cli' && filteredItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % filteredItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const item = filteredItems[selectedIndex];
        if (!item) return;
        switch (item.kind) {
          case 'settings_action':
            if (item.value === '__add_files') {
              fileInputRef.current?.click();
            }
            closePopover();
            return;
          case 'mode': {
            const modeValue = item.modeValue as ModeModifierId | undefined;
            if (modeValue) handleToggleMode(modeValue);
            return;
          }
          default:
            insertItem(item);
            return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closePopover();
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  const canSend = !disabled && !busy && draft.trim().length > 0;
  const placeholderText = placeholder || t('bot.chat.placeholder');
  const plusActive = popoverMode === 'context';

  return (
    <div className="bot-chat-composer">
      <div className="bot-chat-composer__shell">
        {/* Reused session context popover (plus button → 添加附件 + modes). */}
        {popoverMode && (
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
            // surfaces files + modes, not session settings; the bot's model
            // is configured in the bot settings, not per chat).
            thinkingEffort={null}
            onSelectThinkingEffort={() => {}}
            modelId={undefined}
            providerId={undefined}
            responseStyles={[]}
            selectedStyle={null}
            onSelectStyle={() => {}}
            mcpServers={[]}
            onToggleMcpServer={() => {}}
            onAddFiles={() => fileInputRef.current?.click()}
            onRequestRecap={async () => ({ success: false, recap: null, error: 'Unsupported for bot chat' })}
            activeModes={activeModes}
            onToggleMode={handleToggleMode}
            onInsertItem={insertItem}
            onSetSelectedIndex={setSelectedIndex}
            onSetPopoverFilter={setPopoverFilter}
            onSetInputValue={setDraft}
            onClosePopover={closePopover}
            onFocusTextarea={() => textareaRef.current?.focus()}
          />
        )}

        {/* Reply chip above the input (rakazo reply-chip): label + cancel. */}
        {replyPreview && (
          <div className="bot-chat-reply-chip" data-testid="reply-chip">
            <span className="bot-chat-reply-chip__label">
              {t('bot.chat.replyingTo', { name: replyPreview.text || '…' })}
            </span>
            {onClearReply && (
              <button
                type="button"
                className="bot-chat-reply-chip__cancel"
                onClick={onClearReply}
                aria-label={t('bot.chat.cancelReply')}
              >
                <XIcon size={13} />
              </button>
            )}
          </div>
        )}

        {/* Attachment chips above the input (files picked via + / attach). */}
        {attachments.length > 0 && (
          <div className="bot-chat-composer__chips">
            {attachments.map((a) => (
              <span key={a.id} className="bot-chat-composer__chip" title={a.path ?? a.name}>
                <span className="bot-chat-composer__chip-name">{a.name}</span>
                <button
                  type="button"
                  className="bot-chat-composer__chip-remove"
                  onClick={() => removeAttachment(a.id)}
                  aria-label={t('bot.chat.removeAttachment')}
                >
                  <XIcon size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Field on top: mirror + auto-resizing textarea (grok prompt-shell). */}
        <div className="bot-chat-composer__input-area">
          {/* Mirror div — invisible, measures text height for auto-resize */}
          <div
            ref={mirrorRef}
            className="bot-chat-composer__mirror"
            aria-hidden="true"
          />
          <textarea
            ref={textareaRef}
            className="bot-chat-composer__input"
            value={draft}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={placeholderText}
            disabled={disabled}
            rows={1}
            aria-label={placeholderText}
          />
        </div>

        {/* Actions row below: plus/attach left, model + send right (mirrors the
            session MessageInput toolbar). */}
        <div className="bot-chat-composer__actions">
          <div className="bot-chat-composer__actions-left">
            {/* Plus Button — opens the `@` context popup (添加附件 / modes),
                reusing the session's plus button behavior. */}
            <IconButton
              variant="ghost"
              shape="square"
              size="md"
              aria-label={t('common.settings') || 'Settings'}
              data-plus-trigger
              onClick={() => {
                if (plusActive) {
                  closePopover();
                } else {
                  openContextPopover();
                }
              }}
              className={`border ${
                plusActive
                  ? 'text-foreground bg-chip border-border'
                  : 'text-muted-foreground border-transparent hover:text-foreground hover:bg-accent/50'
              }`}
              title={t('common.settings') || 'Settings'}
              disabled={disabled || busy}
            >
              <PlusIcon size={16} />
            </IconButton>

          </div>

          <div className="bot-chat-composer__actions-right">
            {contextRing}
            {busy && onStop ? (
              <button
                type="button"
                className="bot-chat-composer__send bot-chat-composer__send--stop"
                onClick={onStop}
                aria-label={t('bot.chat.stop')}
                title={t('bot.chat.stop')}
              >
                ■
              </button>
            ) : (
              <button
                type="button"
                className="bot-chat-composer__send"
                onClick={handleSend}
                disabled={!canSend}
                aria-label={t('bot.chat.send')}
                title={t('bot.chat.send')}
              >
                <ArrowUpIcon size={16} />
              </button>
            )}
          </div>
        </div>

        {/* Hidden file input shared by the plus popover's 添加附件 and the attach button. */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileChange}
        />
      </div>
    </div>
  );
}
