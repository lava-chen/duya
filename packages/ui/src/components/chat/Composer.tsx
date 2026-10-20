"use client";

/**
 * Composer.tsx — unified chat input shared by the bot DM surface
 * (BotDirectChatView) and the group-room surface (GroupRoomChatView).
 *
 * One component, gated by capability props:
 *   - group : enableMentions + mentionMembers (plain-text submit, `@member`
 *     autocomplete, arrow send).
 *   - bot   : showPlus + enableAttachments + reply chip + contextRing slot
 *     (rich submit payload: mode / files).
 *
 * The visual shell and its CSS (`bot-chat-composer__*`) are shared verbatim
 * between the two hosts. The bot-only `@`-context popover (useSlashCommands)
 * is factored into the BotComposerExtras sub-component so its `@` trigger
 * detection never collides with the group `@member` autocomplete.
 *
 * Draft persistence is keyed by `draftKey` via useBotDraft (bot passes the
 * session id, group passes the room id).
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ArrowUpIcon, PlusIcon, XIcon } from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import { useBotDraft } from './bot/draft/use-bot-draft';
import { useAttachments } from '@/hooks/useAttachments';
import { BotComposerExtras, type BotComposerExtrasHandle } from './BotComposerExtras';
import { BotCharacterAvatar } from '@/components/layout/sidebar/BotCharacterAvatar';
import { MODE_KIND, toggleModeInSet, isModeExcludedByActive } from '@/types/mode-id';
import type { ModeModifierId } from '@/types/mode-id';
import type { FileAttachment } from '@/types/message';

export interface MentionableMember {
  id: string;
  name: string;
  avatarColor?: string;
}

export interface ComposerPayload {
  text: string;
  /** Message-level mode (plan-task / research / ...). Absent → none. */
  mode?: string;
  /** User-attached files (files/images). Absent → no attachment. */
  files?: FileAttachment[];
}

export interface ComposerProps {
  /** localStorage draft key (replaces botId). Bot passes its session id,
   *  group passes the bare room id. Null → no persistence. */
  draftKey: string | null;
  disabled?: boolean;
  busy?: boolean;
  /** Fired on send with the shared payload. The host injects any extra intent
   *  (model / provider / reasoning / replyTo) from its own state. */
  onSubmit: (payload: ComposerPayload) => void;
  /** Shown (■) only when busy, replacing the send arrow. */
  onStop?: () => void;
  placeholder?: string;
  // ---- Group-only capabilities ------------------------------------------
  /** Enables the `@` member mention autocomplete. */
  enableMentions?: boolean;
  /** Candidate members for `@name` mention autocomplete. */
  mentionMembers?: MentionableMember[];
  // ---- Bot-only capabilities --------------------------------------------
  /** Renders the `+` button + `@`-context popover (files + modes). */
  showPlus?: boolean;
  /** Engages the attachment chips + hidden file input. */
  enableAttachments?: boolean;
  /** Active reply target — renders the "Replying to …" chip. */
  replyPreview?: { id: string; text: string } | null;
  /** Cancels the active reply (chip ✕). */
  onClearReply?: () => void;
  /** Optional slot in the right action group (context-usage ring). */
  contextRing?: React.ReactNode;
  // ---- Test hooks (keep existing host testids stable) -------------------
  inputTestId?: string;
  sendTestId?: string;
  mentionListTestId?: string;
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

export function Composer({
  draftKey,
  disabled = false,
  busy = false,
  onSubmit,
  onStop,
  placeholder,
  enableMentions = false,
  mentionMembers = [],
  showPlus = false,
  enableAttachments = false,
  replyPreview = null,
  onClearReply,
  contextRing,
  inputTestId,
  sendTestId,
  mentionListTestId,
}: ComposerProps) {
  const { t } = useTranslation();
  const { draft, setDraft, clearDraft } = useBotDraft(draftKey);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const extrasRef = useRef<BotComposerExtrasHandle | null>(null);

  // Unified attachment state (reused from the session / bot composer paths).
  const {
    attachments,
    addFile,
    remove: removeAttachment,
    clear: clearAttachments,
  } = useAttachments();

  // Group `@member` autocomplete — only active when enableMentions.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const mentionCandidates = useMemo(() => {
    if (!enableMentions || mentionQuery == null) return [];
    const query = mentionQuery.toLowerCase();
    return mentionMembers.filter(
      (m) => m.name.toLowerCase().includes(query) || m.id.toLowerCase().includes(query),
    );
  }, [enableMentions, mentionQuery, mentionMembers]);

  // Popover open state reported by the extras sub-component (drives `+` active).
  const [popoverActive, setPopoverActive] = useState(false);

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
  // Auto-resize + mention detection + submit
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
    const value = e.target.value;
    setDraft(value);
    resizeTextarea();
    if (enableMentions) {
      const match = /(?:^|\s)@([\w-]*)$/.exec(value);
      setMentionQuery(match ? (match[1] ?? '') : null);
    }
  };

  const insertMention = (member: MentionableMember) => {
    setDraft(draft.replace(/@([\w-]*)$/, `@${member.name} `));
    setMentionQuery(null);
    textareaRef.current?.focus();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    if (!input.files) return;
    for (const file of Array.from(input.files)) {
      await addFile(file);
    }
    input.value = '';
  };

  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (!text || disabled || busy) return;
    const mode = pickSendMode(activeModes);
    onSubmit({
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
  }, [draft, disabled, busy, onSubmit, activeModes, attachments, clearDraft, clearAttachments]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Let the bot @-context popover consume navigation keys first.
    if (showPlus && popoverActive && extrasRef.current) {
      if (extrasRef.current.handleKeyDown(e)) return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  const canSend = !disabled && !busy && draft.trim().length > 0;
  const placeholderText = placeholder || t('bot.chat.placeholder');

  return (
    <div className="bot-chat-composer">
      <div className="bot-chat-composer__shell">
        {/* Group `@member` candidate list (only when enableMentions). */}
        {enableMentions && mentionCandidates.length > 0 && (
          <div
            className="mb-2 max-h-[180px] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-canvas)]"
            data-testid={mentionListTestId}
          >
            {mentionCandidates.map((member) => (
              <button
                key={member.id}
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-hover)]"
                onClick={() => insertMention(member)}
              >
                <BotCharacterAvatar
                  name={member.name}
                  agentId={member.id}
                  avatarColor={member.avatarColor}
                  size={20}
                />
                <span className="text-[13px] text-[var(--text)]">{member.name}</span>
              </button>
            ))}
          </div>
        )}

        {/* Bot-only @-context popover (files + modes). Mounted only for bot. */}
        {showPlus && (
          <BotComposerExtras
            ref={extrasRef}
            textareaRef={textareaRef}
            draft={draft}
            setDraft={setDraft}
            draftKey={draftKey}
            activeModes={activeModes}
            onToggleMode={handleToggleMode}
            onAddFiles={() => fileInputRef.current?.click()}
            onActiveChange={setPopoverActive}
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

        {/* Field: mirror + auto-resizing textarea (grok prompt-shell). */}
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
            data-testid={inputTestId}
          />
        </div>

        {/* Actions row: plus/attach left, context ring + send right. */}
        <div className="bot-chat-composer__actions">
          <div className="bot-chat-composer__actions-left">
            {showPlus && (
              <button
                type="button"
                className={`bot-chat-composer__plus${popoverActive ? ' active' : ''}`}
                data-plus-trigger
                onClick={() => {
                  if (popoverActive) {
                    extrasRef.current?.close();
                  } else {
                    extrasRef.current?.open();
                  }
                }}
                title={t('common.settings') || 'Settings'}
                aria-label={t('common.settings') || 'Settings'}
                disabled={disabled || busy}
              >
                <PlusIcon size={16} />
              </button>
            )}
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
                data-testid={sendTestId}
              >
                <ArrowUpIcon size={16} />
              </button>
            )}
          </div>
        </div>

        {/* Hidden file input shared by the plus popover's 添加附件 and the
            attachment path. Only mounted when attachments are enabled. */}
        {enableAttachments && (
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileChange}
          />
        )}
      </div>
    </div>
  );
}