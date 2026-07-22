// src/components/layout/ArtifactsSection.tsx
// Renders the "Artifacts" section in the TaskDrawer. Migrated from
// MessageItem.tsx (formerly MessageSummaryCards). Each artifact is
// a file that the agent created during the session (write/create
// tool on a deliverable file type). Click invokes the same
// openLocalArtifactTarget helper used by the message-bound summary.

'use client';

import { ExternalLinkIcon, FileTextIcon } from '@/components/icons';
import { DrawerSection } from './DrawerSection';
import { openLocalArtifactTarget } from '@/lib/chat-file-links';
import type { ArtifactSummary } from '@/lib/tool-file-changes';

export interface ArtifactsSectionProps {
  artifacts: ArtifactSummary[];
  cwd?: string | null;
}

export function ArtifactsSection({ artifacts, cwd }: ArtifactsSectionProps) {
  return (
    <DrawerSection label="产物">
      {artifacts.length === 0 && (
        <div className="task-card-empty">No artifacts yet.</div>
      )}
      {artifacts.map((artifact) => (
        <ArtifactCard
          key={artifact.path}
          artifact={artifact}
          cwd={cwd}
        />
      ))}
    </DrawerSection>
  );
}

function ArtifactCard({
  artifact,
  cwd,
}: {
  artifact: ArtifactSummary;
  cwd?: string | null;
}) {
  return (
    <button
      type="button"
      className="group flex w-full items-center gap-3 rounded-md border border-border/60 px-3 py-2 text-left transition-colors hover:border-accent/40 hover:bg-surface-hover"
      onClick={() => openLocalArtifactTarget(artifact.path, cwd)}
      title={artifact.path}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
        <FileTextIcon size={14} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-foreground">
          {artifact.name}
        </span>
        <span className="block truncate text-[10px] text-muted-foreground">
          {artifact.kindLabel}
        </span>
      </span>
      <ExternalLinkIcon
        size={12}
        className="shrink-0 text-muted-foreground/50 transition-colors group-hover:text-accent"
      />
    </button>
  );
}