/**
 * BotMessageHoverBar — rakazo-style hover overlay for bot chat rows.
 *
 * Mirrors rakazo's MessageHoverMetadata + MessageHoverActions (apps/web
 * Shell.tsx). Placement (2026-09-05, screenshot-aligned): the bar sits
 * OUTSIDE the bubble on its open side — right of assistant bubbles,
 * left of user bubbles — bottom-aligned with the bubble. It shows the
 * message time plus a bare action row (reply / thumbs-up / copy, the
 * rakazo action order). Visibility rides the ROW hover
 * (`.bot-chat-row:hover`), not the bubble — the whole row is the hover
 * target, rakazo `group/message` parity. Rows suppress the bar while
 * streaming so text selection and stop clicks stay free (the rakazo
 * `progress:` exemption).
 *
 * Thumbs-up persists to localStorage keyed by message id (duya has no
 * reactions store yet); the 👍 badge pinned to the bubble's bottom-right
 * corner is rendered by the row from the same state via <BotThumbsBadge>.
 */

import React from 'react';
import { CopyIcon, ReplyIcon, ThumbsUpIcon } from '@/components/icons';

const THUMBS_UP_KEY = 'duya:bot-chat:thumbs-up';

function readThumbsUpIds(): string[] {
  try {
    const raw = window.localStorage.getItem(THUMBS_UP_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeThumbsUpIds(ids: string[]): void {
  try {
    window.localStorage.setItem(THUMBS_UP_KEY, JSON.stringify(ids));
  } catch {
    // localStorage unavailable (quota / privacy mode) — state stays in-memory
  }
}

/**
 * Persisted thumbs-up toggle for one message. Falls back to a plain
 * in-memory toggle when localStorage throws (the value is still usable
 * for the session; it just does not survive a restart).
 */
export function useMessageThumbsUp(messageId?: string): [boolean, () => void] {
  const [thumbsUp, setThumbsUp] = React.useState<boolean>(() =>
    messageId ? readThumbsUpIds().includes(messageId) : false,
  );

  const toggle = React.useCallback(() => {
    if (!messageId) return;
    setThumbsUp((prev) => {
      const next = !prev;
      const ids = new Set(readThumbsUpIds());
      if (next) ids.add(messageId);
      else ids.delete(messageId);
      writeThumbsUpIds([...ids]);
      return next;
    });
  }, [messageId]);

  return [thumbsUp, toggle];
}

interface BotMessageHoverBarProps {
  /** Epoch ms — rendered as the rakazo-style <time> label */
  timestamp?: number;
  /** Text copied by the copy button; hides the button when absent */
  textToCopy?: string;
  /** Message id — enables the persisted thumbs-up toggle when present */
  messageId?: string;
  /** Thumbs-up state + toggle, lifted to the row (badge shares it) */
  thumbsUp?: boolean;
  onToggleThumbsUp?: () => void;
  /** Reply action (rakazo onReply); hides the button when absent */
  onReply?: () => void;
}

export function BotMessageHoverBar({
  timestamp,
  textToCopy,
  messageId,
  thumbsUp = false,
  onToggleThumbsUp,
  onReply,
}: BotMessageHoverBarProps) {
  const canReact = messageId != null && onToggleThumbsUp != null;
  const hasTime = timestamp != null && Number.isFinite(timestamp);

  // rakazo copyMessage: fire-and-forget, no copied-state feedback.
  const copyMessage = () => {
    if (!textToCopy || !navigator.clipboard) return;
    void navigator.clipboard.writeText(textToCopy).catch(() => undefined);
  };

  return (
    <div className="bot-message-hover-metadata">
      {hasTime && (
        <time
          dateTime={new Date(timestamp).toISOString()}
          className="bot-message-hover-metadata__time"
        >
          {new Date(timestamp).toLocaleTimeString(undefined, {
            hour: 'numeric',
            minute: '2-digit',
          })}
        </time>
      )}
      <div className="bot-message-hover-pill" data-testid="message-hover-actions">
        {onReply && (
          <button
            type="button"
            aria-label="Reply"
            onClick={onReply}
            className="bot-message-hover-pill__btn"
          >
            <ReplyIcon size={14} strokeWidth={1.8} />
          </button>
        )}
        {canReact && (
          <button
            type="button"
            aria-label={thumbsUp ? 'Remove thumbs-up' : 'Add thumbs-up'}
            aria-pressed={thumbsUp}
            onClick={onToggleThumbsUp}
            className={`bot-message-hover-pill__btn${thumbsUp ? ' bot-message-hover-pill__btn--active' : ''}`}
          >
            <ThumbsUpIcon size={14} strokeWidth={1.8} />
          </button>
        )}
        {textToCopy && (
          <button
            type="button"
            aria-label="Copy"
            onClick={copyMessage}
            className="bot-message-hover-pill__btn"
          >
            <CopyIcon size={14} strokeWidth={1.8} />
          </button>
        )}
      </div>
    </div>
  );
}

interface BotThumbsBadgeProps {
  /** Toggle off — the badge is only rendered while the reaction is set */
  onRemove: () => void;
}

/** Persisted 👍 badge pinned to the bubble's bottom-right corner. */
export function BotThumbsBadge({ onRemove }: BotThumbsBadgeProps) {
  return (
    <button
      type="button"
      aria-label="Remove thumbs-up"
      onClick={onRemove}
      className="bot-chat-thumbs-badge"
    >
      👍
    </button>
  );
}
