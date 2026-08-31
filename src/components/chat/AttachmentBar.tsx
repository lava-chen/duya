/**
 * AttachmentBar.tsx - Plan 220 Phase 4 + Plan 472 visual unification.
 *
 * Unified renderer for all 5 attachment kinds. Replaces:
 *   - `PastedContentAttachment` / `PastedContentList`
 *   - `FileAttachmentCard` for inline file/pasted cards (when mode='input')
 *   - the file-chip row, terminal-reference-chip-list block, and
 *     `RichTextInput`'s inline browser/file/terminal chip DOM
 *   - the legacy `message-pasted-content-item` div and `BrowserReferenceCard`
 *     in `MessageItem` (when mode='history')
 *
 * Variants:
 *   - `mode='input'`  — shows an X button on each card; clicking calls
 *     `onRemove(id)`. Cards with kind='browser-ref' + screenshot also
 *     couple to the paired image attachment via `metadata.attachmentId`.
 *   - `mode='history'` — hides the X button; cards become clickable to
 *     open the attachment preview via `onPreview(att)`.
 *
 * Plan 472: every kind now shares ONE `flex flex-wrap` row, regardless of
 * whether the underlying card is a FileAttachmentCard, a BrowserScreenshot
 * card, or a ReferenceSquareCard. The old split into a "file" track + a
 * "chip" track (visible as two horizontal rows when a user pasted both an
 * image and some text) is gone — cards sit in input order on a single row.
 * All three card shapes use the same 104×104 rounded-2xl square outline so
 * mixing kinds reads as one composed visual unit.
 *
 * For non-image / non-document kinds (pasted-text, terminal-ref, browser-ref,
 * file-tree-ref) the preview is purely textual inside the square (5-line
 * clamp). For kind='file' or kind='image' the bar delegates to
 * `FileAttachmentCard` for the visual treatment.
 */

'use client';

import React from 'react';
import { DocumentTextIcon, FileIcon, FolderIcon, GlobeIcon, TerminalIcon, XIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import type { FileAttachment } from '@/types/message';
import { FileAttachmentCard } from './FileAttachmentCard';
import { rewriteMediaSrc } from './markdownComponents';

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

function resolveKindLabel(att: FileAttachment): { kindLabel: string; Icon: typeof DocumentTextIcon } {
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
}

function BrowserScreenshotCard({
  att,
  mode,
  previewImage,
  onRemove,
  onPreview,
}: {
  att: FileAttachment;
  mode: 'input' | 'history';
  previewImage: string;
  onRemove?: (id: string) => void;
  onPreview?: (att: FileAttachment) => void;
}) {
  const preview = att.previewText || att.name;
  const { kindLabel, Icon } = resolveKindLabel(att);
  const card = (
    <>
      {mode === 'input' && (
        <IconButton
          type="button"
          variant="danger"
          shape="round"
          size="sm"
          className="browser-screenshot-attachment-remove"
          onClick={(event) => {
            event.stopPropagation();
            onRemove?.(att.id);
          }}
          aria-label="Remove attachment"
        >
          <XIcon size={10} />
        </IconButton>
      )}
      <img
        src={rewriteMediaSrc(previewImage)}
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
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-attachment-id={att.id}
        className="browser-screenshot-attachment-card"
        onClick={() => onPreview?.(att)}
      >
        {card}
      </Button>
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

function ReferenceSquareCard({
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
  const preview = att.previewText || att.name;
  const { kindLabel, Icon } = resolveKindLabel(att);
  const body = (
    <>
      {mode === 'input' && (
        <IconButton
          type="button"
          variant="danger"
          shape="round"
          size="sm"
          className="reference-attachment-remove"
          onClick={(event) => {
            event.stopPropagation();
            onRemove?.(att.id);
          }}
          aria-label="Remove attachment"
        >
          <XIcon size={10} />
        </IconButton>
      )}
      <div className="reference-attachment-preview">{preview}</div>
      <div className="reference-attachment-label">
        <Icon size={10} />
        <span>{kindLabel}</span>
      </div>
    </>
  );

  if (mode === 'history') {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-attachment-id={att.id}
        className="reference-attachment-card reference-attachment-card-clickable"
        onClick={() => onPreview?.(att)}
      >
        {body}
      </Button>
    );
  }

  return (
    <div
      data-attachment-id={att.id}
      className="reference-attachment-card"
    >
      {body}
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

  // Browser screenshot refs render a single card that absorbs their linked
  // PNG — drop the linked image from the main pass so we never paint two
  // cards for one browser-screenshot relationship.
  const linkedBrowserScreenshotImageIds = new Set(
    attachments
      .map((attachment) => resolveLinkedBrowserScreenshotImage(attachment, attachments)?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );

  return (
    <div className="attachment-bar attachment-bar-unified" data-mode={mode}>
      <div className="flex flex-wrap gap-2 mb-2">
        {attachments.map((att) => {
          if (linkedBrowserScreenshotImageIds.has(att.id)) return null;

          if (isBrowserScreenshotRef(att)) {
            const linkedImage = resolveLinkedBrowserScreenshotImage(att, attachments);
            const previewImage =
              linkedImage?.displayUrl ||
              linkedImage?.thumbnail ||
              linkedImage?.url ||
              linkedImage?.path ||
              '';
            return (
              <BrowserScreenshotCard
                key={att.id}
                att={att}
                mode={mode}
                previewImage={previewImage}
                onRemove={onRemove}
                onPreview={onPreview}
              />
            );
          }

          if (att.kind === 'file' || isImageLikeAttachment(att)) {
            return (
              <FileAttachmentCard
                key={att.id}
                id={att.id}
                name={att.name}
                thumbnail={
                  att.displayUrl ||
                  att.thumbnail ||
                  (att.kind === 'image' ? (att.url || att.path) : undefined)
                }
                url={att.url || att.path}
                width={104}
                onRemove={mode === 'input' ? (id) => onRemove?.(id) : undefined}
                onClick={mode === 'history' ? () => onPreview?.(att) : undefined}
              />
            );
          }

          return (
            <ReferenceSquareCard
              key={att.id}
              att={att}
              mode={mode}
              onRemove={onRemove}
              onPreview={onPreview}
            />
          );
        })}
      </div>
    </div>
  );
}
