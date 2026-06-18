/**
 * MailboxBubble.tsx - AgentMailbox bubble component (Plan 202)
 *
 * Compact single-row layout that sits inline in the MailboxPanel body.
 * Designed as a "stash table" row: kind chip + content + per-row actions
 * (guide, delete, more). Edit is reachable from the more menu.
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
import { Pencil, Trash, DotsThree, ArrowBendDownRight, X } from '@phosphor-icons/react';
import type { MailboxRow, MailboxKind } from '@/stores/mailbox-store';

// =============================================================================
// Kind label mapping (kept for accessibility / title attrs; not rendered
// as a chip anymore — the row is intentionally chip-less).
// =============================================================================

const KIND_LABELS: Record<MailboxKind, string> = {
  followup: 'Follow-up',
  correction: 'Correction',
  constraint: 'Constraint',
  stop: 'Stop',
  abort_and_replace: 'Replace',
};

const KIND_COLORS: Record<MailboxKind, string> = {
  followup: 'var(--accent)',
  correction: '#f59e0b',
  constraint: '#ef4444',
  stop: '#f59e0b',
  abort_and_replace: '#ef4444',
};

// =============================================================================
// Props
// =============================================================================

interface MailboxBubbleProps {
  row: MailboxRow;
  onEdit: (id: string, patch: { content?: string; kind?: MailboxKind }) => void;
  onCancel: (id: string) => void;
  onGuide?: (row: MailboxRow) => void;
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
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(row.content);
  const isPending = row.status === 'pending';
  const isCancelled = row.status === 'cancelled';
  const isGuided = row.source.endsWith(':guide');

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
  const kindLabel = KIND_LABELS[row.kind] ?? row.kind;

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
        <button
          type="button"
          onClick={handleSaveEdit}
          className="mailbox-bubble-save"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => setIsEditing(false)}
          className="mailbox-bubble-action"
          title="Cancel edit"
          aria-label="Cancel edit"
        >
          <X size={13} />
        </button>
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
          <button
            type="button"
            onClick={handleGuide}
            className="mailbox-bubble-action mailbox-bubble-action--guide"
            title="Guide — let the agent absorb this message at the next checkpoint"
            aria-label="Guide"
          >
            <ArrowBendDownRight size={13} />
            <span>引导</span>
          </button>
        )}
        {isPending && isGuided && (
          <span className="mailbox-bubble-guided">引导中</span>
        )}
        {isPending && (
          <button
            type="button"
            onClick={handleCancel}
            className="mailbox-bubble-action mailbox-bubble-action--danger"
            title="Delete from queue"
            aria-label="Delete"
          >
            <Trash size={13} />
          </button>
        )}
        <button
          type="button"
          onClick={handleMore}
          className="mailbox-bubble-action"
          title="More actions"
          aria-label="More actions"
        >
          <DotsThree size={13} weight="bold" />
        </button>
      </div>

      {/* Hover actions — edit (separate so it doesn't clash with the
          always-visible guide/delete/more) */}
      {isPending && (
        <div className="mailbox-bubble-hover-actions">
          <button
            type="button"
            onClick={() => {
              setEditContent(row.content);
              setIsEditing(true);
            }}
            className="mailbox-bubble-action"
            title="Edit content"
            aria-label="Edit"
          >
            <Pencil size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
