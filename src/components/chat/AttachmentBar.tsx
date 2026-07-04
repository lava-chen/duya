/**
 * AttachmentBar.tsx - Plan 220 Phase 4.
 *
 * Unified renderer for all 5 attachment kinds. Replaces:
 *   - `PastedContentAttachment` / `PastedContentList`
 *   - `FileAttachmentCard` for inline file/pasted cards (when mode='input')
 *   - the file-chip row, terminal-reference-chip-list block, and
 *     `RichTextInput`'s inline browser/file/terminal chip DOM
 *   - the `message-pasted-content-item` div and `BrowserReferenceCard`
 *     in `MessageItem` (when mode='history')
 *
 * Variants:
 *   - `mode='input'`  — shows an X button on each card; clicking calls
 *     `onRemove(id)`. Cards with kind='browser-ref' + screenshot also
 *     couple to the paired image attachment via `metadata.attachmentId`.
 *   - `mode='history'` — hides the X button; cards become clickable to
 *     open the attachment preview via `onPreview(att)`.
 *
 * For non-image / non-document kinds (pasted-text, terminal-ref, browser-ref,
 * file-tree-ref) the preview is purely textual. For kind='file' or kind='image',
 * the bar delegates to `FileAttachmentCard` for the visual treatment.
 */

'use client';

import React from 'react';
import { FileIcon, XIcon } from '@/components/icons';
import type { FileAttachment } from '@/types/message';
import { FileAttachmentCard } from './FileAttachmentCard';

export interface AttachmentBarProps {
  attachments: FileAttachment[];
  mode: 'input' | 'history';
  onRemove?: (id: string) => void;
  onPreview?: (att: FileAttachment) => void;
}

function buildLabel(att: FileAttachment): string {
  if (att.previewText) return att.previewText;
  return att.name;
}

function AttachmentChipCard({
  att,
  mode,
  onRemove,
  onPreview,
}: {
  att: FileAttachment;
  mode: 'input' | 'history';
  onRemove?: (id: string) => void;
  onPreview?: (att: FileAttachment) => void;
}) {
  const label = buildLabel(att);
  const kindLabel = (() => {
    switch (att.kind) {
      case 'pasted-text':
        return 'PASTED';
      case 'terminal-ref':
        return 'TERMINAL';
      case 'browser-ref':
        return (att.metadata as { elementKind?: string } | undefined)?.elementKind === 'screenshot'
          ? 'BROWSER SHOT'
          : 'BROWSER';
      case 'file-tree-ref':
        return 'FILE TREE';
      default:
        return att.kind?.toUpperCase() ?? 'ATTACHMENT';
    }
  })();

  if (mode === 'history') {
    return (
      <button
        type="button"
        data-attachment-id={att.id}
        className="attachment-chip attachment-chip--history"
        onClick={() => onPreview?.(att)}
      >
        <span className="attachment-chip-label">{label}</span>
        <span className="attachment-chip-kind">{kindLabel}</span>
      </button>
    );
  }

  return (
    <div
      data-attachment-id={att.id}
      className="attachment-chip attachment-chip--input"
    >
      <button
        type="button"
        className="attachment-chip-remove"
        onClick={() => onRemove?.(att.id)}
        aria-label="Remove attachment"
      >
        <XIcon size={10} />
      </button>
      {att.kind === 'file-tree-ref' ? (
        <FileIcon size={12} />
      ) : null}
      <span className="attachment-chip-label">{label}</span>
      <span className="attachment-chip-kind">{kindLabel}</span>
    </div>
  );
}

export function AttachmentBar({
  attachments,
  mode,
  onRemove,
  onPreview,
}: AttachmentBarProps) {
  if (attachments.length === 0) return null;

  // Separate kinds into two render tracks:
  //  - file / image use FileAttachmentCard (existing visual treatment)
  //  - everything else uses the lightweight chip
  const fileKindAttachments = attachments.filter(
    (a) => a.kind === 'file' || a.kind === 'image',
  );
  const chipAttachments = attachments.filter(
    (a) => a.kind !== 'file' && a.kind !== 'image',
  );

  return (
    <div className="attachment-bar" data-mode={mode}>
      {fileKindAttachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {fileKindAttachments.map((att) => (
            <FileAttachmentCard
              key={att.id}
              id={att.id}
              name={att.name}
              thumbnail={att.displayUrl || att.thumbnail}
              url={att.url}
              width={104}
              onRemove={mode === 'input' ? (id) => onRemove?.(id) : undefined}
              onClick={mode === 'history' ? () => onPreview?.(att) : undefined}
            />
          ))}
        </div>
      )}
      {chipAttachments.length > 0 && (
        <div className="attachment-bar-chips flex flex-wrap gap-1.5 mb-2">
          {chipAttachments.map((att) => (
            <AttachmentChipCard
              key={att.id}
              att={att}
              mode={mode}
              onRemove={onRemove}
              onPreview={onPreview}
            />
          ))}
        </div>
      )}
    </div>
  );
}