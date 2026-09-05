/**
 * Plan 491 P2.4: UnreadDivider — marks the boundary between read and unread messages.
 *
 * Rendered inline in the message stream.
 * Uses CSS accent token for styling (not hardcoded).
 *
 * Usage:
 *   <UnreadDivider count={3} onMarkRead={handleMarkRead} />
 */

import React from 'react';

export interface UnreadDividerProps {
  /** Number of unread messages */
  count?: number;
  /** Callback to mark messages as read */
  onMarkRead?: () => void;
  /** Optional className */
  className?: string;
}

/**
 * UnreadDivider — inline divider showing unread message count.
 *
 * Shows a "New messages" label with count and a "Mark as read" action.
 */
export function UnreadDivider({
  count = 0,
  onMarkRead,
  className = '',
}: UnreadDividerProps) {
  const unreadText = count > 0
    ? `${count}条新消息`
    : '新消息';

  return (
    <div
      className={`unread-divider ${className}`}
      role="separator"
      aria-label={unreadText}
    >
      <div className="unread-divider__line" />
      <div className="unread-divider__content">
        <span className="unread-divider__text">{unreadText}</span>
        {onMarkRead && (
          <button
            type="button"
            className="unread-divider__action"
            onClick={onMarkRead}
          >
            标记已读
          </button>
        )}
      </div>
      <div className="unread-divider__line" />
    </div>
  );
}
