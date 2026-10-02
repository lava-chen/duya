"use client";

/**
 * BotPermissionCard — Plan 494: compact generic tool-permission card for
 * the bot-direct transcript.
 *
 * Without ChatView mounted, a generic permission_request in a bot session
 * had no renderer and the stream sat in `awaiting_permission` until the
 * entry expired. This card gives the user a minimal allow/deny surface
 * riding the same respondToPermission channel as the workspace panel.
 * (AskUserQuestion requests render as BotAskCard instead.)
 */

import type { PermissionRequestEvent } from '@/types/stream';
import type { TranslationKey } from '@/i18n';

export interface BotPermissionCardProps {
  request: PermissionRequestEvent;
  onRespond: (
    decision: 'allow' | 'allow_session' | 'deny',
    updatedInput?: Record<string, unknown>,
    denyMessage?: string,
  ) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  /** Extra root class — the bubble-group seam modifiers ride in here. */
  className?: string;
}

/** One-line summary of the tool input (stringified, capped). */
function inputSummary(toolInput: Record<string, unknown> | undefined): string {
  if (!toolInput) return '';
  try {
    const text = JSON.stringify(toolInput);
    return text.length > 160 ? `${text.slice(0, 157)}…` : text;
  } catch {
    return '';
  }
}

export function BotPermissionCard({ request, onRespond, t, className }: BotPermissionCardProps) {
  const summary = inputSummary(request.toolInput);
  return (
    <div className={`bot-permission-card${className ? ` ${className}` : ''}`} data-permission-id={request.id}>
      <div className="bot-permission-card__head">
        <span className="bot-permission-card__tool">{request.toolName || t('permission.toolFallback')}</span>
        <span className="bot-permission-card__pill">{t('permission.approvalRequired')}</span>
      </div>
      {summary && <code className="bot-permission-card__summary">{summary}</code>}
      <div className="bot-permission-card__actions">
        <button
          type="button"
          className="bot-permission-card__btn bot-permission-card__btn--danger"
          onClick={() => onRespond('deny')}
        >
          {t('permission.deny')}
        </button>
        <button
          type="button"
          className="bot-permission-card__btn"
          onClick={() => onRespond('allow')}
        >
          {t('permission.allowOnce')}
        </button>
        <button
          type="button"
          className="bot-permission-card__btn bot-permission-card__btn--primary"
          onClick={() => onRespond('allow_session')}
        >
          {t('permission.allowForSession')}
        </button>
      </div>
    </div>
  );
}
