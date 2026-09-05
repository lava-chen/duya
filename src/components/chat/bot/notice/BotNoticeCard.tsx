/**
 * Plan 491 P2.2: BotNoticeCard — inline notice for failure/compact/mode switch.
 *
 * Rendered inline in the message stream (not a toast).
 * Can be scrolled back to and provides context without interrupting flow.
 *
 * Types:
 *   - 'error': Stream failed or message send failed
 *   - 'compact': Compact summary marker (separates old/new content)
 *   - 'mode-switch': Mode changed (plan/research/conductor/goal)
 */

import React from 'react';

export type NoticeCardType = 'error' | 'compact' | 'mode-switch';

export interface BotNoticeCardProps {
  /** Type of notice */
  type: NoticeCardType;
  /** Main message text */
  message: string;
  /** Optional secondary details */
  details?: string;
  /** Timestamp of the event */
  timestamp?: number;
  /** Optional action button (e.g., "Retry", "View") */
  action?: {
    label: string;
    onClick: () => void;
  };
  /** Optional className for additional styling */
  className?: string;
}

/**
 * Get icon for notice type.
 */
function getNoticeIcon(type: NoticeCardType): string {
  switch (type) {
    case 'error':
      return '⚠';
    case 'compact':
      return '📋';
    case 'mode-switch':
      return '🔄';
    default:
      return 'ℹ';
  }
}

/**
 * Get default message for notice type.
 */
function getDefaultMessage(type: NoticeCardType): string {
  switch (type) {
    case 'error':
      return '发生错误';
    case 'compact':
      return '对话已压缩';
    case 'mode-switch':
      return '模式已切换';
    default:
      return '通知';
  }
}

/**
 * Format timestamp to readable time string.
 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * BotNoticeCard — inline notice card for chat stream.
 *
 * Provides contextual notices that are part of the message history,
 * unlike toast notifications which are transient.
 */
export function BotNoticeCard({
  type,
  message,
  details,
  timestamp,
  action,
  className = '',
}: BotNoticeCardProps) {
  const icon = getNoticeIcon(type);
  const defaultMessage = getDefaultMessage(type);
  const displayMessage = message || defaultMessage;

  return (
    <div
      className={`bot-notice-card bot-notice-card--${type} ${className}`}
      role="status"
      aria-live="polite"
    >
      <div className="bot-notice-card__icon">{icon}</div>

      <div className="bot-notice-card__content">
        <div className="bot-notice-card__message">{displayMessage}</div>
        {details && (
          <div className="bot-notice-card__details">{details}</div>
        )}
      </div>

      {timestamp && (
        <div className="bot-notice-card__time">
          {formatTime(timestamp)}
        </div>
      )}

      {action && (
        <button
          type="button"
          className="bot-notice-card__action"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
