// ToolImagePreviewModal.tsx - Two-pane preview (image + side text).
//
// Used by ScreenshotToolRow (text panel hidden when no content) and
// VisionToolRow (always shows the question + analysis). Single component
// keeps the open/close lifecycle, escape-to-close, and overlay click
// behavior consistent across the two rows.

'use client';

import React, { useEffect } from 'react';
import { XIcon } from '@/components/icons';

export interface ToolImagePreviewModalProps {
  open: boolean;
  onClose: () => void;
  /** Image source (data URL, http(s), or file path that the renderer can
   *  display via <img>). */
  src: string;
  /** Required: short title shown in the right pane header. */
  title: string;
  /** Required: subtitle shown under the title (e.g. "image/png · 12 KB"). */
  subtitle?: string;
  /** Optional: shown as a "QUESTION" block above the body. */
  question?: string;
  /** Required: the multi-line body text rendered in the right pane. */
  body: string;
  /** When true, render image-only (the right pane is hidden). Used by
   *  ScreenshotToolRow where there's no extra text. */
  hideTextPane?: boolean;
}

export function ToolImagePreviewModal({
  open,
  onClose,
  src,
  title,
  subtitle,
  question,
  body,
  hideTextPane,
}: ToolImagePreviewModalProps) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="attachment-preview-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Preview: ${title}`}
    >
      <button
        onClick={onClose}
        className="attachment-preview-close"
        aria-label="Close preview"
      >
        <XIcon size={20} />
      </button>
      <div
        className="attachment-preview-sidebar-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="attachment-preview-sidebar-image">
          <img src={src} alt={title} />
        </div>
        {!hideTextPane && (
          <div className="attachment-preview-sidebar-text">
            <div className="attachment-preview-sidebar-header">
              <span className="attachment-preview-sidebar-title">{title}</span>
              {subtitle && (
                <span className="attachment-preview-sidebar-subtitle">{subtitle}</span>
              )}
            </div>
            {question && (
              <>
                <div className="attachment-preview-sidebar-section">Question</div>
                <div className="attachment-preview-sidebar-question">{question}</div>
              </>
            )}
            <div className="attachment-preview-sidebar-section">Answer</div>
            <div className="attachment-preview-sidebar-body">{body}</div>
          </div>
        )}
      </div>
    </div>
  );
}