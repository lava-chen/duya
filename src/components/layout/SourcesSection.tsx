// src/components/layout/SourcesSection.tsx
// Card-style "Sources" list in the TaskDrawer. Each source is rendered as
// a compact card with an icon and a label, matching the clipboard-style
// source UI in Figure 2.
//
// Sources are flattened into a single list (no category sub-sections) and
// capped at MAX_VISIBLE cards; the rest are revealed by "查看全部".

'use client';

import { useState } from 'react';
import {
  FileIcon,
  ImageIcon,
  GlobeIcon,
  TerminalIcon,
  PlusIcon,
} from '@/components/icons';
import { DrawerSection } from './DrawerSection';
import type { FileAttachment } from '@/types/message';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';

const MAX_VISIBLE = 4;

export interface SourcesSectionProps {
  userAttachments: FileAttachment[];
  browserUrls: FileAttachment[];
  others: FileAttachment[];
}

function openBrowserUrl(url: string): void {
  window.dispatchEvent(
    new CustomEvent('duya:open-browser-panel', { detail: { url } })
  );
}

function openAttachmentPreview(attachment: FileAttachment): void {
  window.dispatchEvent(
    new CustomEvent('duya:open-attachment', { detail: { attachment } })
  );
}

function labelForAttachment(att: FileAttachment): string {
  if (att.previewText) return att.previewText;
  if (att.kind === 'browser-ref') {
    const meta = att.metadata as { url?: string } | undefined;
    return meta?.url ?? att.name;
  }
  return att.name;
}

function iconForAttachment(att: FileAttachment) {
  if (att.kind === 'image') {
    return <ImageIcon size={16} className="shrink-0 text-muted-foreground" />;
  }
  if (att.kind === 'browser-ref') {
    return <GlobeIcon size={16} className="shrink-0 text-muted-foreground" />;
  }
  if (att.kind === 'terminal-ref') {
    return <TerminalIcon size={16} className="shrink-0 text-muted-foreground" />;
  }
  return <FileIcon size={16} className="shrink-0 text-muted-foreground" />;
}

export function SourcesSection({
  userAttachments,
  browserUrls,
  others,
}: SourcesSectionProps) {
  const [expanded, setExpanded] = useState(false);

  const allSources: FileAttachment[] = [
    ...userAttachments,
    ...browserUrls,
    ...others,
  ];

  if (allSources.length === 0) return null;

  const visible = expanded ? allSources : allSources.slice(0, MAX_VISIBLE);
  const overflow = allSources.length - visible.length;

  return (
    <DrawerSection
      label="来源"
      rightAction={
        <IconButton
          type="button"
          variant="default"
          shape="square"
          size="sm"
          className="p-1 rounded text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
          title="Add source"
          aria-label="Add source"
          onClick={() => {
            // Reserved for future "add source" flow (e.g. attach file / paste).
          }}
        >
          <PlusIcon size={14} />
        </IconButton>
      }
    >
      <div className="grid grid-cols-1 gap-2 mt-1">
        {visible.map((att) => {
          const label = labelForAttachment(att);
          return (
            <Button
              key={att.id}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                if (att.kind === 'browser-ref') {
                  const meta = att.metadata as { url?: string } | undefined;
                  if (meta?.url) openBrowserUrl(meta.url);
                } else {
                  openAttachmentPreview(att);
                }
              }}
              title={label}
              className="flex items-center gap-2.5 w-full rounded-lg border px-3 py-2 text-left transition-colors hover:bg-surface-hover"
              style={{
                backgroundColor: 'var(--surface)',
                borderColor: 'var(--border)',
              }}
            >
              <div className="shrink-0">{iconForAttachment(att)}</div>
              <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                {label}
              </span>
            </Button>
          );
        })}
      </div>
      {overflow > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setExpanded(true)}
          className="mt-2 flex w-full items-center justify-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          查看全部 ({allSources.length})
        </Button>
      )}
    </DrawerSection>
  );
}
