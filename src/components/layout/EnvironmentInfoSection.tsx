// src/components/layout/EnvironmentInfoSection.tsx
// Single git-changes line at the top of the TaskDrawer. The whole
// section returns null when the session's working tree isn't a git
// repository (or git is unavailable) — there is no label, no
// placeholder, no fallback row.
//
// Layout (collapsed by default):
//   [icon] [+additions -removals] [N 个文件]
// Expanded:
//   … above, then per-file rows: [path] [+add] [-rem]

'use client';

import { useState } from 'react';
import { GitBranchIcon, CaretDownIcon } from '@/components/icons';
import { DrawerSection } from './DrawerSection';
import type { UseGitStatusResult } from '@/hooks/useGitStatus';

const MAX_VISIBLE = 4;

export interface EnvironmentInfoSectionProps {
  gitStatus: UseGitStatusResult;
}

export function EnvironmentInfoSection({ gitStatus }: EnvironmentInfoSectionProps) {
  const [expanded, setExpanded] = useState(false);

  if (!gitStatus.isGitRepo) {
    return null;
  }

  const { fileChanges, totals } = gitStatus;
  const visible = expanded ? fileChanges : fileChanges.slice(0, MAX_VISIBLE);
  const overflow = fileChanges.length - visible.length;

  return (
    <DrawerSection label="环境信息">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-xs text-foreground transition-colors hover:bg-surface-hover"
        aria-expanded={expanded}
      >
        <GitBranchIcon size={12} className="shrink-0 text-muted-foreground" />
        <span>变更</span>
        <span className="ml-auto flex items-center gap-2 font-mono">
          <span className="text-green-500">+{totals.additions}</span>
          <span className="text-red-500">-{totals.removals}</span>
        </span>
        <span className="text-muted-foreground">{fileChanges.length} 个文件</span>
        <CaretDownIcon
          size={11}
          className={`shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      {expanded && (
        <ul className="border-t border-border/40">
          {fileChanges.map((change) => (
            <li
              key={change.path}
              className="flex items-center gap-2 px-1 py-1 text-xs"
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
            </li>
          ))}
        </ul>
      )}

      {!expanded && overflow > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex w-full items-center gap-1 px-1 py-0.5 text-left text-[10px] text-muted-foreground transition-colors hover:text-foreground"
        >
          再显示 {overflow} 个文件
          <CaretDownIcon size={10} />
        </button>
      )}
    </DrawerSection>
  );
}