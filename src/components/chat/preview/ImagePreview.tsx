// ImagePreview.tsx - Unified read-only image / attachment / tool-result
// preview modal. Replaces three legacy components (ImagePreviewModal,
// AttachmentPreviewModal, ToolImagePreviewModal) with one component
// supporting two variants. See docs/exec-plans/active/511-image-preview-modal-unification.md.
//
// Variant shapes:
//   - 'lightbox' — black immersive backdrop, image centered with optional
//     caption underneath, no header chrome. Used for: markdown inline
//     image, widget image, bot-sent image, screenshot tool (image-only).
//   - 'panel'    — centered card with optional title/subtitle header and
//     a scrollable body region. Used for: chat attachment (image/pdf/code/
//     text/doc) and vision tool (image + analysis text).
//
// The chrome (overlay, close button, Escape handling, click-outside) is
// identical across both variants. CSS lives in src/styles/preview.css
// under the unified `image-preview-*` class tree.

'use client';

import React, { useEffect } from 'react';
import { XIcon } from '@/components/icons';
import { IconButton } from '@/components/ui/IconButton';
import { rewriteMediaSrc } from '../markdownComponents';
import {
  ImagePreviewPanel,
  panelTitle,
  panelSubtitle,
} from './ImagePreviewPanel';
import type { FileAttachment } from '@/types/message';

export type ImagePreviewVariant = 'lightbox' | 'panel';

export interface ImagePreviewProps {
  /** Whether the preview is rendered. Component returns null when false. */
  open: boolean;
  onClose: () => void;
  variant: ImagePreviewVariant;
  /** Source for the image content. Passes through rewriteMediaSrc. */
  src?: string;
  alt?: string;
  /** Header title for the panel variant. In lightbox mode this becomes
   *  the caption underneath the image when alt is empty. */
  title?: React.ReactNode;
  /** Header subtitle for the panel variant. Ignored in lightbox mode. */
  subtitle?: React.ReactNode;
  /** Body content rendered inside the panel body region. */
  body?: React.ReactNode;
  /** When true, the panel variant hides the image slot and renders only
   *  the body (e.g. for code/text/doc previews). Default false. */
  bodyOnly?: boolean;
  /** File attachment — when provided together with the panel variant,
   *  dispatches to the matching ImagePreviewPanel sub-renderer
   *  (image/pdf/code/text/doc/unknown). */
  attachment?: FileAttachment | null;
  /** Pasted-content block — when provided together with the panel
   *  variant, renders as a text preview. */
  pastedContent?: { id: string; content: string; preview: string } | null;
}

/** Page-figma convention: hide the alt caption for this exact label. */
const HIDDEN_LIGHTBOX_CAPTION = 'page.png';

export function ImagePreview(props: ImagePreviewProps): React.ReactElement | null {
  const {
    open,
    onClose,
    variant,
    src,
    alt,
    title,
    subtitle,
    body,
    bodyOnly,
    attachment,
    pastedContent,
  } = props;

  // Escape key closes the preview. Only attached while open so a hidden
  // preview doesn't steal keyboard events.
  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const resolvedSrc = src ? rewriteMediaSrc(src) : undefined;

  const closeButton = (
    <IconButton
      variant="ghost"
      size="sm"
      shape="square"
      aria-label="Close preview"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      className="image-preview-close"
    >
      <XIcon size={18} />
    </IconButton>
  );

  if (variant === 'lightbox') {
    // Lightbox: image canvas centered, optional caption under it.
    const showCaption = alt && alt !== HIDDEN_LIGHTBOX_CAPTION;
    return (
      <div
        className="image-preview-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={title ? `Preview: ${title}` : alt ? `Preview: ${alt}` : 'Image preview'}
        onClick={onClose}
      >
        {closeButton}
        <div
          className="image-preview-canvas"
          onClick={(e) => e.stopPropagation()}
        >
          {resolvedSrc && (
            <img
              src={resolvedSrc}
              alt={alt ?? ''}
              className="image-preview-canvas-img"
            />
          )}
          {showCaption && (
            <div className="image-preview-caption">{alt}</div>
          )}
        </div>
      </div>
    );
  }

  // Panel variant: optional header + scrollable body. Body dispatches to
  // the right content shape — either an explicit `body` slot, a file
  // attachment sub-renderer, or nothing.
  // Only resolve title/subtitle from the attachment when one was
  // provided — without that, missing call-site values stay missing
  // (so `hasHeader` is false and the header block is omitted).
  const hasAttachmentContext = Boolean(attachment || pastedContent);
  const resolvedTitle =
    title ?? (hasAttachmentContext ? panelTitle(attachment, pastedContent) : undefined);
  const resolvedSubtitle =
    subtitle ??
    (hasAttachmentContext ? panelSubtitle(attachment, pastedContent) : undefined);
  const hasHeader = resolvedTitle != null || resolvedSubtitle != null;

  const renderBodyContent = (): React.ReactNode => {
    if (body) return body;
    if (attachment || pastedContent) {
      return (
        <ImagePreviewPanel
          attachment={attachment ?? null}
          pastedContent={pastedContent ?? null}
          bodyOnly={bodyOnly}
        />
      );
    }
    // No body provided — render the image at top.
    if (resolvedSrc && !bodyOnly) {
      return (
        <img
          src={resolvedSrc}
          alt={alt ?? ''}
          className="image-preview-panel-img"
        />
      );
    }
    return null;
  };

  const bodyContent = renderBodyContent();
  // Image slot shows whenever we have a src and the caller didn't
  // explicitly opt out via bodyOnly. When a typed body or attachment
  // is provided, the image sits *above* the body in the same scroll
  // area; otherwise the image fills the body region directly.
  const showImageSlot = !bodyOnly && Boolean(resolvedSrc);
  const hasMultipleSiblings = Boolean(bodyContent) && Boolean(showImageSlot);

  return (
    <div
      className="image-preview-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Preview: ${resolvedTitle ?? ''}`}
      onClick={onClose}
    >
      {closeButton}
      <div
        className="image-preview-panel"
        onClick={(e) => e.stopPropagation()}
      >
        {hasHeader && (
          <div className="image-preview-panel-header">
            <div className="image-preview-panel-title-block">
              {resolvedTitle != null && (
                <h3 className="image-preview-panel-title">{resolvedTitle}</h3>
              )}
              {resolvedSubtitle != null && (
                <span className="image-preview-panel-subtitle">{resolvedSubtitle}</span>
              )}
            </div>
          </div>
        )}
        <div className="image-preview-panel-body">
          {hasMultipleSiblings ? (
            <>
              <div className="image-preview-panel-image">
                <img
                  src={resolvedSrc}
                  alt={alt ?? ''}
                  className="image-preview-panel-img"
                />
              </div>
              {bodyContent}
            </>
          ) : (
            bodyContent
          )}
        </div>
      </div>
    </div>
  );
}

export default ImagePreview;