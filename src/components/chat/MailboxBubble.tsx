/**
 * MailboxBubble.tsx - AgentMailbox bubble component (Plan 202)
 *
 * Compact single-row layout that sits inline in the MailboxPanel body.
 * Designed as a "stash table" row: kind chip + content + per-row actions
 * (guide current run, delete, more). Edit is reachable from the more menu.
 *
 * Visual contract:
 *   - 2px left accent strip in the kind color (visual differentiation)
 *   - kind chip on the left (icon + short label, no border)
 *   - content text in the middle, single-line truncated
 *   - per-row action buttons on the right: guide / delete / more
 *   - cancelled rows dim the text and strike through
 *
 * Statuses: pending, cancelled (observed/applied come in PR2)
 */

'use client';

import React, { useState, useCallback } from 'react';
import { PencilIcon, TrashIcon, DotsThreeIcon, ArrowBendDownRightIcon, XIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import type { MailboxRow, MailboxKind } from '@/stores/mailbox-store';
import { useTranslation } from '@/hooks/useTranslation';

// =============================================================================
// Kind label mapping (kept for accessibility / title attrs; not rendered
// as a chip anymore — the row is intentionally chip-less).
// =============================================================================

const KIND_LABEL_KEYS: Record<MailboxKind, 'mailbox.composer.kindFollowup' | 'mailbox.composer.kindCorrection' | 'mailbox.composer.kindConstraint' | 'mailbox.composer.stop' | 'mailbox.bubble.replace'> = {
  followup: 'mailbox.composer.kindFollowup',
  correction: 'mailbox.composer.kindCorrection',
  constraint: 'mailbox.composer.kindConstraint',
  stop: 'mailbox.composer.stop',
  abort_and_replace: 'mailbox.bubble.replace',
  // System notifications (sub-agent / background command completion) never
  // appear as user-editable rows; this label is only a compile-time fill.
  background_notification: 'mailbox.composer.kindFollowup',
};

const KIND_COLORS: Record<MailboxKind, string> = {
  followup: 'var(--accent)',
  correction: '#f59e0b',
  constraint: '#ef4444',
  stop: '#f59e0b',
  abort_and_replace: '#ef4444',
  background_notification: 'var(--muted)',
};

// =============================================================================
// Props
// =============================================================================

interface MailboxBubbleProps {
  row: MailboxRow;
  onEdit: (id: string, patch: { content?: string; kind?: MailboxKind }) => void;
  onCancel: (id: string) => void;
  onGuide?: (row: MailboxRow) => void | Promise<void>;
  onMore?: (row: MailboxRow) => void;
}

// =============================================================================
// Component
// =============================================================================

export function MailboxBubble({
  row,
  onEdit,
  onCancel,
  onGuide,
  onMore,
}: MailboxBubbleProps) {
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(row.content);
  const isPending = row.status === 'pending';
  const isCancelled = row.status === 'cancelled';
  const isGuided = row.applyMode === 'runtime_instruction';

  const handleSaveEdit = useCallback(() => {
    if (editContent.trim() && editContent !== row.content) {
      onEdit(row.id, { content: editContent.trim() });
    }
    setIsEditing(false);
  }, [row.id, row.content, editContent, onEdit]);

  const handleCancel = useCallback(() => {
    onCancel(row.id);
  }, [row.id, onCancel]);

  const handleGuide = useCallback(() => {
    onGuide?.(row);
  }, [row, onGuide]);

  const handleMore = useCallback(() => {
    onMore?.(row);
  }, [row, onMore]);

  const kindColor = KIND_COLORS[row.kind] ?? 'var(--muted)';
  const kindLabel = t(KIND_LABEL_KEYS[row.kind] ?? 'mailbox.composer.kindFollowup');

  // Editing replaces the whole row with an input. Compact, inline.
  if (isEditing) {
    return (
      <div
        className="mailbox-bubble mailbox-bubble--editing"
        style={{ borderLeftColor: kindColor }}
        title={kindLabel}
      >
        <input
          type="text"
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSaveEdit();
            if (e.key === 'Escape') setIsEditing(false);
          }}
          className="mailbox-bubble-input"
          autoFocus
        />
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={handleSaveEdit}
          className="mailbox-bubble-save"
        >
          {t('mailbox.bubble.save')}
        </Button>
        <IconButton
          type="button"
          variant="ghost"
          shape="square"
          size="sm"
          onClick={() => setIsEditing(false)}
          className="mailbox-bubble-action"
          title={t('mailbox.bubble.cancelEdit')}
          aria-label={t('mailbox.bubble.cancelEdit')}
        >
          <XIcon size={13} />
        </IconButton>
      </div>
    );
  }

  return (
    <div
      className={`mailbox-bubble ${isCancelled ? 'mailbox-bubble--cancelled' : ''}`}
      style={{ borderLeftColor: kindColor }}
    >
      {/* Content — single line, truncated. No kind chip, no status
          spinner — the row is a simple "message + actions" line.
          The kind name is still reachable via the `title` attr. */}
      <p
        className={`mailbox-bubble-content ${
          isCancelled ? 'mailbox-bubble-content--cancelled' : ''
        }`}
        title={`${kindLabel} — ${row.content}`}
      >
        {row.content}
      </p>

      {/* Per-row actions: guide / delete / more — always visible */}
      <div className="mailbox-bubble-actions">
        {isPending && !isGuided && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleGuide}
            className="mailbox-bubble-action mailbox-bubble-action--guide"
            title={t('mailbox.bubble.guideHint')}
            aria-label={t('mailbox.guide')}
          >
            <ArrowBendDownRightIcon size={13} />
            <span>{t('mailbox.guide')}</span>
          </Button>
        )}
        {isPending && isGuided && (
          <span className="mailbox-bubble-guided">{t('mailbox.bubble.guiding')}</span>
        )}
        {isPending && (
          <IconButton
            type="button"
            variant="danger"
            shape="square"
            size="sm"
            onClick={handleCancel}
            className="mailbox-bubble-action mailbox-bubble-action--danger"
            title={t('mailbox.bubble.delete')}
            aria-label={t('mailbox.bubble.delete')}
          >
            <TrashIcon size={13} />
          </IconButton>
        )}
        <IconButton
          type="button"
          variant="ghost"
          shape="square"
          size="sm"
          onClick={handleMore}
          className="mailbox-bubble-action"
          title={t('mailbox.more')}
          aria-label={t('mailbox.more')}
        >
          <DotsThreeIcon size={13} />
        </IconButton>
      </div>

      {/* Hover actions — edit (separate so it doesn't clash with the
          always-visible guide/delete/more) */}
      {isPending && (
        <div className="mailbox-bubble-hover-actions">
          <IconButton
            type="button"
            variant="ghost"
            shape="square"
            size="sm"
            onClick={() => {
              setEditContent(row.content);
              setIsEditing(true);
            }}
            className="mailbox-bubble-action"
            title={t('mailbox.bubble.edit')}
            aria-label={t('mailbox.bubble.edit')}
          >
            <PencilIcon size={13} />
          </IconButton>
        </div>
      )}
    </div>
  );
}
