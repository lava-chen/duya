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
import { DocumentTextIcon, FileIcon, FolderIcon, GlobeIcon, TerminalIcon, XIcon } from '@/components/icons';
import type { FileAttachment } from '@/types/message';
import { FileAttachmentCard } from './FileAttachmentCard';

export interface AttachmentBarProps {
  attachments: FileAttachment[];
  mode: 'input' | 'history';
  onRemove?: (id: string) => void;
  onPreview?: (att: FileAttachment) => void;
}

function isImageLikeAttachment(attachment: FileAttachment): boolean {
  if (attachment.kind === 'image') return true;
  if (attachment.type.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(attachment.name);
}

function isBrowserScreenshotRef(attachment: FileAttachment): boolean {
  return (
    attachment.kind === 'browser-ref' &&
    (attachment.metadata as { elementKind?: string } | undefined)?.elementKind === 'screenshot'
  );
}

function resolveLinkedBrowserScreenshotImage(
  attachment: FileAttachment,
  attachments: FileAttachment[],
): FileAttachment | undefined {
  if (!isBrowserScreenshotRef(attachment)) return undefined;

  const linkedImageId = (attachment.metadata as { attachmentId?: string } | undefined)?.attachmentId;
  const linkedById = linkedImageId ? attachments.find((item) => item.id === linkedImageId) : undefined;
  if (linkedById && isImageLikeAttachment(linkedById)) {
    return linkedById;
  }

  const index = attachments.findIndex((item) => item.id === attachment.id);
  if (index < 0) return undefined;

  const candidates: Array<FileAttachment | undefined> = [
    attachments[index - 1],
    attachments[index + 1],
    attachments[index - 2],
    attachments[index + 2],
  ];

  return candidates.find(
    (candidate) =>
      !!candidate &&
      isImageLikeAttachment(candidate) &&
      candidate.name.startsWith('browser-screenshot-'),
  );
}

// Reference card for all non-file/image kinds: pasted-text, terminal-ref,
// browser-ref, file-tree-ref. Mirrors the pre-Plan-220 pasted-content
// card visual (160px wide, 4-line line-clamp preview, label chip at the
// bottom, top-right X in input mode). The kind is distinguished by the
// icon + label text at the bottom of the card.
function AttachmentChipCard({
  att,
  mode,
  onRemove,
  onPreview,
  previewImage,
}: {
  att: FileAttachment;
  mode: 'input' | 'history';
  onRemove?: (id: string) => void;
  onPreview?: (att: FileAttachment) => void;
  previewImage?: string;
}) {
  const preview = att.previewText || att.name;
  const { kindLabel, Icon } = (() => {
    switch (att.kind) {
      case 'pasted-text':
        return { kindLabel: 'PASTED', Icon: DocumentTextIcon };
      case 'terminal-ref':
        return { kindLabel: 'TERMINAL', Icon: TerminalIcon };
      case 'browser-ref':
        return {
          kindLabel:
            (att.metadata as { elementKind?: string } | undefined)?.elementKind === 'screenshot'
              ? 'BROWSER SHOT'
              : 'BROWSER',
          Icon: GlobeIcon,
        };
      case 'file-tree-ref':
        return { kindLabel: 'FILE TREE', Icon: FileIcon };
      default:
        return { kindLabel: att.kind?.toUpperCase() ?? 'ATTACHMENT', Icon: FolderIcon };
    }
  })();
  const handleActivate = () => onPreview?.(att);
  const isBrowserScreenshot = isBrowserScreenshotRef(att);

  if (isBrowserScreenshot && previewImage) {
    const card = (
      <>
        {mode === 'input' && (
          <button
            type="button"
            className="browser-screenshot-attachment-remove"
            onClick={(event) => {
              event.stopPropagation();
              onRemove?.(att.id);
            }}
            aria-label="Remove attachment"
          >
            <XIcon size={10} />
          </button>
        )}
        <img
          src={previewImage}
          alt={preview}
          className="browser-screenshot-attachment-image"
          loading="lazy"
        />
        <div className="browser-screenshot-attachment-shade" />
        <div className="browser-screenshot-attachment-meta">
          <span className="browser-screenshot-attachment-title">{preview}</span>
          <span className="browser-screenshot-attachment-label">
            <Icon size={10} />
            <span className="browser-screenshot-attachment-label-text">{kindLabel}</span>
          </span>
        </div>
      </>
    );

    if (mode === 'history') {
      return (
        <button
          type="button"
          data-attachment-id={att.id}
          className="browser-screenshot-attachment-card"
          onClick={handleActivate}
        >
          {card}
        </button>
      );
    }

    return (
      <div
        data-attachment-id={att.id}
        className="browser-screenshot-attachment-card"
      >
        {card}
      </div>
    );
  }

  if (mode === 'history') {
    return (
      <div
        data-attachment-id={att.id}
        className="message-pasted-content-item cursor-pointer hover:border-accent-soft hover:bg-surface-hover transition-all"
        onClick={handleActivate}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') handleActivate();
        }}
      >
        <div className="message-pasted-content-preview">{preview}</div>
        <div className="message-pasted-content-label">
          <Icon size={10} />
          <span>{kindLabel}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      data-attachment-id={att.id}
      className="pasted-content-attachment"
    >
      <button
        type="button"
        className="pasted-content-remove"
        onClick={() => onRemove?.(att.id)}
        aria-label="Remove attachment"
      >
        <XIcon size={10} />
      </button>
      <div className="pasted-content-preview">{preview}</div>
      <div className="pasted-content-label">
        <Icon size={10} />
        <span>{kindLabel}</span>
      </div>
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

  const linkedBrowserScreenshotImageIds = new Set(
    attachments
      .map((attachment) => resolveLinkedBrowserScreenshotImage(attachment, attachments)?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );

  // Separate kinds into two render tracks:
  //  - file/image kinds use FileAttachmentCard (square visual preview)
  //  - browser screenshot refs are rendered as image cards too, alongside
  //    ordinary images, so all visual attachments share the same component
  //  - everything else uses the unified reference card
  const fileKindAttachments = attachments.filter(
    (a) =>
      a.kind === 'file' ||
      isBrowserScreenshotRef(a) ||
      (isImageLikeAttachment(a) && !linkedBrowserScreenshotImageIds.has(a.id)),
  );
  const chipAttachments = attachments.filter(
    (a) => a.kind !== 'file' && !isImageLikeAttachment(a) && !isBrowserScreenshotRef(a),
  );

  return (
    <div className="attachment-bar" data-mode={mode}>
      {fileKindAttachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {fileKindAttachments.map((att) => {
            const isBrowserShot = isBrowserScreenshotRef(att);
            const linkedImage = isBrowserShot
              ? resolveLinkedBrowserScreenshotImage(att, attachments)
              : undefined;
            return (
              <FileAttachmentCard
                key={att.id}
                id={att.id}
                name={isBrowserShot ? att.previewText || att.name : att.name}
                thumbnail={
                  isBrowserShot
                    ? linkedImage?.displayUrl || linkedImage?.thumbnail || linkedImage?.url
                    : att.displayUrl || att.thumbnail || (att.kind === 'image' ? att.url : undefined)
                }
                url={isBrowserShot ? undefined : att.url}
                width={104}
                onRemove={mode === 'input' ? (id) => onRemove?.(id) : undefined}
                onClick={mode === 'history' ? () => onPreview?.(att) : undefined}
              />
            );
          })}
        </div>
      )}
      {chipAttachments.length > 0 && (
        <div className="pasted-content-list">
          {chipAttachments.map((att) => (
            <AttachmentChipCard
              key={att.id}
              att={att}
              mode={mode}
              onRemove={onRemove}
              onPreview={onPreview}
              previewImage={(() => {
                const linkedImage = resolveLinkedBrowserScreenshotImage(att, attachments);
                return linkedImage?.displayUrl || linkedImage?.thumbnail || linkedImage?.url;
              })()}
            />
          ))}
        </div>
      )}
    </div>
  );
}
