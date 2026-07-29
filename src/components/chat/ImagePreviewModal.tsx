// ImagePreviewModal.tsx - Full-screen image preview modal (Lightbox)

'use client';

import React, { useEffect } from 'react';
import { XIcon } from '@/components/icons';
import { IconButton } from '@/components/ui/IconButton';

interface ImagePreviewModalProps {
  src: string;
  alt: string;
  onClose: () => void;
}

export function ImagePreviewModal({ src, alt, onClose }: ImagePreviewModalProps) {
  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="image-preview-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Preview: ${alt}`}
    >
      {/* Close button */}
      <IconButton
        variant="ghost"
        size="md"
        shape="square"
        aria-label="Close preview"
        onClick={onClose}
        className="image-preview-close"
      >
        <XIcon size={20} />
      </IconButton>

      {/* Image container */}
      <div
        className="image-preview-content"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={src}
          alt={alt}
          className="image-preview-image"
        />
        {alt && alt !== 'page.png' && (
          <div className="image-preview-filename">{alt}</div>
        )}
      </div>
    </div>
  );
}