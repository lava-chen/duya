// PastedContentAttachment.tsx - Component for displaying pasted text as attachment cards

'use client';

import React from 'react';
import { XIcon } from '@/components/icons';
import type { PastedContent } from '@/hooks/usePastedContent';

interface PastedContentAttachmentProps {
  content: PastedContent;
  onRemove: (id: string) => void;
}

export function PastedContentAttachment({ content, onRemove }: PastedContentAttachmentProps) {
  return (
    <div className="pasted-content-attachment">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove(content.id);
        }}
        className="pasted-content-remove"
        title="Remove pasted content"
        tabIndex={0}
        aria-label={`Remove pasted content: ${content.preview}`}
      >
        <XIcon size={12} />
      </button>
      <div className="pasted-content-preview">
        {content.preview}
      </div>
      <div className="pasted-content-label">
        PASTED
      </div>
    </div>
  );
}

interface PastedContentListProps {
  contents: PastedContent[];
  onRemove: (id: string) => void;
}

export function PastedContentList({ contents, onRemove }: PastedContentListProps) {
  if (contents.length === 0) return null;

  return (
    <div className="pasted-content-list">
      {contents.map((content) => (
        <PastedContentAttachment
          key={content.id}
          content={content}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}
