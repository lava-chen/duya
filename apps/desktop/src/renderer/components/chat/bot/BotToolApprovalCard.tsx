"use client";

/**
 * BotToolApprovalCard — Plan 498: durable tool-approval card (rakazo
 * action-approval alignment).
 *
 * Rendered from a persisted assistant row (msg_type 'tool-approval',
 * sendMessageMeta.approval). Unlike the ephemeral BotPermissionCard (plan
 * 494, in-memory SSE prompt), this card survives reloads and answers
 * through `toolApproval.resolve`, which CAS-transitions the approval row
 * and enqueues an approval.resume continuation run — the bot learns the
 * decision even if it answered long after the paused turn ended.
 */

import { useCallback, useState } from 'react';
import type { TranslationKey } from '@/i18n';

export type ToolApprovalStatus = 'pending' | 'approved' | 'consumed' | 'denied';
export type ToolApprovalDecision = 'allow' | 'always' | 'deny';

export interface ToolApprovalCardData {
  approvalId: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
}

export interface BotToolApprovalCardProps {
  approval: ToolApprovalCardData;
  status: ToolApprovalStatus;
  onResolve?: (id: string, decision: ToolApprovalDecision) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

/** One-line summary of the tool input (stringified, capped). */
function inputSummary(toolInput: Record<string, unknown> | undefined): string {
  if (!toolInput || Object.keys(toolInput).length === 0) return '';
  try {
    const text = JSON.stringify(toolInput);
    return text.length > 160 ? `${text.slice(0, 157)}…` : text;
  } catch {
    return '';
  }
}

export function BotToolApprovalCard({ approval, status, onResolve, t }: BotToolApprovalCardProps) {
  const [busy, setBusy] = useState<ToolApprovalDecision | null>(null);

  const handle = useCallback(
    (decision: ToolApprovalDecision) => {
      if (status !== 'pending' || busy) return;
      setBusy(decision);
      onResolve?.(approval.approvalId, decision);
    },
    [approval.approvalId, busy, onResolve, status],
  );

  const pending = status === 'pending';
  const statusLabel = !pending
    ? status === 'denied'
      ? t('toolApproval.denied')
      : t('toolApproval.approved')
    : t('toolApproval.waiting');
  const summary = inputSummary(approval.toolInput);

  return (
    <div
      className="bot-tool-approval-card"
      data-approval-id={approval.approvalId}
      data-status={status}
    >
      <div className="bot-tool-approval-card__head">
        <span className="bot-tool-approval-card__tool">
          {approval.toolName || t('permission.toolFallback')}
        </span>
        <span
          className={`bot-tool-approval-card__pill${
            pending ? '' : status === 'denied' ? ' bot-tool-approval-card__pill--denied' : ' bot-tool-approval-card__pill--answered'
          }`}
        >
          {statusLabel}
        </span>
      </div>
      {summary && <code className="bot-tool-approval-card__summary">{summary}</code>}
      {pending && (
        <div className="bot-tool-approval-card__actions">
          <button
            type="button"
            className="bot-tool-approval-card__btn bot-tool-approval-card__btn--danger"
            disabled={busy != null}
            onClick={() => handle('deny')}
          >
            {t('permission.deny')}
          </button>
          <button
            type="button"
            className="bot-tool-approval-card__btn"
            disabled={busy != null}
            onClick={() => handle('allow')}
          >
            {t('permission.allowOnce')}
          </button>
          <button
            type="button"
            className="bot-tool-approval-card__btn bot-tool-approval-card__btn--primary"
            disabled={busy != null}
            onClick={() => handle('always')}
          >
            {t('permission.alwaysAllow')}
          </button>
        </div>
      )}
    </div>
  );
}
