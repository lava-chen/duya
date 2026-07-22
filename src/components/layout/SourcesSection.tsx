// src/components/layout/SourcesSection.tsx
// Three-column "Sources" aggregation in the TaskDrawer:
//   1. User attachments  (file / image)
//   2. Browser URLs      (browser-ref attachments → web pages the
//                          user or agent visited during this session)
//   3. Other references  (pasted text, terminal excerpts, file-tree
//                          picks — read-only text snippets)
//
// Each column caps at MAX_VISIBLE rows; the rest roll up into a
// single "+N more" line that the user can expand. Click targets:
//   - user attachment → dispatch `duya:open-attachment` (handled in
//     a follow-up by AttachmentPreviewModal)
//   - browser URL    → dispatch `duya:open-browser-panel` (the
//     existing side-panel listener opens BrowserPanel)

'use client';

import { useState } from 'react';
import {
  FileIcon,
  ImageIcon,
  GlobeIcon,
  TerminalIcon,
  CaretDownIcon,
} from '@/components/icons';
import { DrawerSection } from './DrawerSection';
import type { FileAttachment } from '@/types/message';

const MAX_VISIBLE = 3;

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

export function SourcesSection({
  userAttachments,
  browserUrls,
  others,
}: SourcesSectionProps) {
  const [expanded, setExpanded] = useState<{
    user: boolean;
    browser: boolean;
    other: boolean;
  }>({ user: false, browser: false, other: false });

  const totalEmpty =
    userAttachments.length === 0 &&
    browserUrls.length === 0 &&
    others.length === 0;

  return (
    <DrawerSection label="来源">
      {totalEmpty && (
        <div className="task-card-empty">No sources yet.</div>
      )}

      {userAttachments.length > 0 && (
        <SourceColumn
          title="附件"
          icon={<FileIcon size={12} className="text-muted-foreground" />}
          items={userAttachments}
          expanded={expanded.user}
          onToggle={() =>
            setExpanded((prev) => ({ ...prev, user: !prev.user }))
          }
          onItemClick={openAttachmentPreview}
        />
      )}

      {browserUrls.length > 0 && (
        <SourceColumn
          title="网页"
          icon={<GlobeIcon size={12} className="text-muted-foreground" />}
          items={browserUrls}
          expanded={expanded.browser}
          onToggle={() =>
            setExpanded((prev) => ({ ...prev, browser: !prev.browser }))
          }
          onItemClick={(att) => {
            const meta = att.metadata as { url?: string } | undefined;
            if (meta?.url) openBrowserUrl(meta.url);
          }}
        />
      )}

      {others.length > 0 && (
        <SourceColumn
          title="其他"
          icon={<FileIcon size={12} className="text-muted-foreground" />}
          items={others}
          expanded={expanded.other}
          onToggle={() =>
            setExpanded((prev) => ({ ...prev, other: !prev.other }))
          }
          onItemClick={openAttachmentPreview}
        />
      )}
    </DrawerSection>
  );
}

function SourceColumn({
  title,
  icon,
  items,
  expanded,
  onToggle,
  onItemClick,
}: {
  title: string;
  icon: React.ReactNode;
  items: FileAttachment[];
  expanded: boolean;
  onToggle: () => void;
  onItemClick: (att: FileAttachment) => void;
}) {
  const visible = expanded ? items : items.slice(0, MAX_VISIBLE);
  const overflow = items.length - visible.length;

  return (
    <div className="mt-1 first:mt-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1 px-1 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        {icon}
        <span className="font-medium">{title}</span>
        <span className="ml-1 rounded bg-surface px-1 text-[10px]">
          {items.length}
        </span>
        <CaretDownIcon
          size={10}
          className={`ml-auto shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>
      <ul className="space-y-0.5">
        {visible.map((att) => {
          const label = labelForAttachment(att);
          const ItemIcon = att.kind === 'image'
            ? <ImageIcon size={11} className="shrink-0 text-muted-foreground" />
            : att.kind === 'terminal-ref'
              ? <TerminalIcon size={11} className="shrink-0 text-muted-foreground" />
              : <FileIcon size={11} className="shrink-0 text-muted-foreground" />;
          return (
            <li key={att.id}>
              <button
                type="button"
                onClick={() => onItemClick(att)}
                title={label}
                className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] text-foreground transition-colors hover:bg-surface-hover"
              >
                {ItemIcon}
                <span className="min-w-0 flex-1 truncate">{label}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {!expanded && overflow > 0 && (
        <button
          type="button"
          onClick={onToggle}
          className="flex w-full items-center gap-1 px-1 py-0.5 text-left text-[10px] text-muted-foreground transition-colors hover:text-foreground"
        >
          +{overflow} more
        </button>
      )}
    </div>
  );
}