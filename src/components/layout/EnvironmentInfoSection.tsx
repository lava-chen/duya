// src/components/layout/EnvironmentInfoSection.tsx
// Two-line summary at the top of the TaskDrawer:
//   1. Session basic info (title + workingDirectory short name + model)
//   2. Git-style file-change totals aggregated from the session's
//      tool-call history (provided by useSessionArtifacts).
//
// The change line collapses into "+N / -M" when more than MAX_VISIBLE
// files are present; click toggles between collapsed and expanded.

'use client';

import { useState } from 'react';
import { FolderIcon, FileTextIcon, CaretDownIcon } from '@/components/icons';
import { DrawerSection } from './DrawerSection';
import { openLocalFileTarget } from '@/lib/chat-file-links';
import type { FileChangeSummary } from '@/lib/tool-file-changes';

const MAX_VISIBLE = 4;

export interface EnvironmentInfoSectionProps {
  title: string;
  workingDirectory?: string | null;
  model?: string | null;
  fileChanges: FileChangeSummary[];
}

function shortPath(path: string | null | undefined): string {
  if (!path) return '';
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function EnvironmentInfoSection({
  title,
  workingDirectory,
  model,
  fileChanges,
}: EnvironmentInfoSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const totals = fileChanges.reduce(
    (acc, change) => ({
      additions: acc.additions + change.additions,
      removals: acc.removals + change.removals,
    }),
    { additions: 0, removals: 0 }
  );
  const cwd = workingDirectory ?? null;
  const visible = expanded ? fileChanges : fileChanges.slice(0, MAX_VISIBLE);
  const overflow = fileChanges.length - visible.length;

  return (
    <DrawerSection label="环境信息">
      <div className="flex items-center gap-2 px-1 py-1 text-xs">
        <FileTextIcon size={12} className="shrink-0 text-muted-foreground" />
        <span className="truncate text-foreground">{title || '未命名会话'}</span>
        {model && (
          <span className="ml-auto shrink-0 rounded bg-surface px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {model}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 px-1 py-1 text-xs text-muted-foreground">
        <FolderIcon size={12} className="shrink-0" />
        <span className="truncate" title={workingDirectory ?? undefined}>
          {shortPath(workingDirectory) || '未指定目录'}
        </span>
      </div>

      {fileChanges.length > 0 && (
        <div className="mt-2 rounded border border-border/60 bg-surface/40">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors hover:bg-surface-hover"
          >
            <span className="font-mono text-green-500">+{totals.additions}</span>
            <span className="font-mono text-red-500">-{totals.removals}</span>
            <span className="text-muted-foreground">
              {fileChanges.length} 个文件
            </span>
            <CaretDownIcon
              size={11}
              className={`ml-auto shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`}
            />
          </button>
          {expanded && (
            <ul className="border-t border-border/60">
              {fileChanges.map((change) => (
                <li key={change.path}>
                  <button
                    type="button"
                    onClick={() => openLocalFileTarget(change.path, cwd ?? undefined)}
                    className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs transition-colors hover:bg-surface-hover"
                    title={change.path}
                  >
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {change.path}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-green-500">
                      +{change.additions}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-red-500">
                      -{change.removals}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!expanded && overflow > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="flex w-full items-center gap-1 border-t border-border/60 px-2 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
            >
              再显示 {overflow} 个文件
              <CaretDownIcon size={10} />
            </button>
          )}
        </div>
      )}
    </DrawerSection>
  );
}