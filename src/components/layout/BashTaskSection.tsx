// src/components/layout/BashTaskSection.tsx
// Renders the Background commands section inside the TaskDrawer: a list
// of bash commands that the agent has detached to the background. Each
// row shows status icon + command preview + PID/elapsed/exit metadata.
// Snapshots arrive via the `bash_task:update` IPC channel (see
// useBashTasks); this component is presentational only.

'use client';

import React from 'react';
import {
  CheckIcon,
  SpinnerIcon,
  StopIcon,
  TerminalIcon,
  WarningIcon,
} from '@/components/icons';
import type { BashBackgroundTaskSnapshot, BashTaskStatus } from '@/types';
import { DrawerSection } from './DrawerSection';

const statusIcons: Record<BashTaskStatus, React.ReactNode> = {
  running: <SpinnerIcon size={12} className="text-accent animate-spin" />,
  completed: <CheckIcon size={12} className="text-green-500" />,
  killed: <StopIcon size={12} className="text-red-500" />,
  error: <WarningIcon size={12} className="text-red-500" />,
  disk_limit: <WarningIcon size={12} className="text-orange-500" />,
};

const statusColors: Record<BashTaskStatus, string> = {
  running: 'text-foreground font-medium',
  completed: 'text-muted-foreground/45',
  killed: 'text-red-500/80',
  error: 'text-red-500/80',
  disk_limit: 'text-orange-500/80',
};

export interface BashTaskSectionProps {
  tasks: BashBackgroundTaskSnapshot[];
}

export function BashTaskSection({ tasks }: BashTaskSectionProps) {
  if (tasks.length === 0) return null;

  const runningCount = tasks.filter((t) => t.status === 'running').length;

  return (
    <DrawerSection label={runningCount > 0 ? `Background commands (${runningCount} running)` : 'Background commands'}>
      {tasks.map((task) => (
        <BashTaskRow key={task.id} task={task} />
      ))}
    </DrawerSection>
  );
}

function BashTaskRow({ task }: { task: BashBackgroundTaskSnapshot }) {
  const commandPreview = task.command.length > 80
    ? `${task.command.slice(0, 80)}...`
    : task.command;

  const meta = (() => {
    if (task.status === 'running') {
      const elapsedMs = task.lastProgress?.elapsed ?? (Date.now() - task.startTime);
      return `PID ${task.pid} · ${formatElapsed(elapsedMs)}`;
    }
    if (task.status === 'completed') {
      return `exit ${task.exitCode ?? 0} · ${formatElapsed(elapsed(task))}`;
    }
    if (task.status === 'killed') {
      return `killed · ${formatElapsed(elapsed(task))}`;
    }
    if (task.status === 'error') {
      return `exit ${task.exitCode ?? -1} · ${formatElapsed(elapsed(task))}`;
    }
    return `disk limit · ${formatElapsed(elapsed(task))}`;
  })();

  return (
    <div className="task-card-row group" title={task.command}>
      <span className="task-card-status" aria-label={`Status: ${task.status}`}>
        {statusIcons[task.status]}
      </span>
      <span className="task-card-row-title task-card-row-title-mono">
        <TerminalIcon size={11} className="inline-block mr-1 opacity-60" />
        <span className={statusColors[task.status]}>{commandPreview}</span>
      </span>
      <span className="task-card-row-meta">{meta}</span>
    </div>
  );
}

function elapsed(task: BashBackgroundTaskSnapshot): number {
  const end = task.endTime ?? Date.now();
  return end - task.startTime;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}
