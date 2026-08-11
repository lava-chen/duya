// src/components/chat/InlineTaskRow.tsx
// In-input task progress row. Plan 416.
//
// Renders a single row inside the composer (between <AttachmentBar>
// and <RichTextInput>) that surfaces the agent's current todo list.
// Click the row to expand a popover with the full task list — popover
// shares the visual style of the slash-command settings popover
// (`--command-menu-*` tokens, no framer-motion).
//
// When both `tasks` and `gitStatus.totals.fileCount` are empty, the
// component returns `null` and the input box stays compact.

'use client';

import { useEffect, useRef, useState } from 'react';
import type { Task, TaskStatus } from '@duya/agent';
import {
  CheckIcon,
  CircleIcon,
  SpinnerIcon,
  ListChecksIcon,
  GitBranchIcon,
} from '@/components/icons';
import type { UseGitStatusResult } from '@/hooks/useGitStatus';
import { useOptionalPanel } from '@/hooks/usePanel';

export interface InlineTaskRowProps {
  tasks: Task[];
  gitStatus: UseGitStatusResult;
  onToggleStatus: (task: Task) => void;
  workingDirectory?: string | null;
  /**
   * When false the file-change segment is hidden even if git changes
   * exist. Used to show file changes only for the current active agent
   * turn.
   */
  showFileChanges?: boolean;
}

const statusIcons: Record<TaskStatus, React.ReactNode> = {
  pending: <CircleIcon size={11} />,
  in_progress: <SpinnerIcon size={11} className="animate-spin" />,
  completed: <CheckIcon size={11} />,
};

export function InlineTaskRow({
  tasks,
  gitStatus,
  onToggleStatus,
  workingDirectory,
  showFileChanges = true,
}: InlineTaskRowProps) {
  const [expanded, setExpanded] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const panel = useOptionalPanel();
  const fileCount = gitStatus.totals.fileCount;
  const hasTasks = tasks.length > 0;
  const hasFiles = fileCount > 0 && showFileChanges;
  const hasContent = hasTasks || hasFiles;

  // Close popover on outside mousedown or Escape.
  useEffect(() => {
    if (!expanded) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (wrapRef.current?.contains(target)) return;
      setExpanded(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setExpanded(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [expanded]);

  if (!hasContent) return null;

  const completed = tasks.filter((t) => t.status === 'completed').length;
  const activeTask = tasks.find((t) => t.status === 'in_progress');
  const subject =
    activeTask?.activeForm ??
    activeTask?.subject ??
    tasks[0]?.activeForm ??
    tasks[0]?.subject ??
    '';
  const progressText = `(${completed}/${tasks.length})`;

  const handleGitClick = () => {
    if (workingDirectory) {
      panel?.openOrActivatePage('review', { workingDirectory });
    }
  };

  return (
    <div
      ref={wrapRef}
      className="inline-task-row-wrap"
      data-testid="inline-task-row"
    >
      <div className="inline-task-row">
        {hasTasks && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-task-row-main"
            aria-expanded={expanded}
            aria-label={
              expanded
                ? '折叠任务列表'
                : `展开任务列表，${progressText}`
            }
          >
            <ListChecksIcon size={14} className="inline-task-row-icon" />
            <span className="inline-task-row-prefix">进行中:</span>
            <span className="inline-task-row-subject truncate">
              {subject} {progressText}
            </span>
          </button>
        )}
        {hasFiles && (
          <>
            {hasTasks && <span className="inline-task-row-divider" />}
            <button
              type="button"
              className="inline-task-row-git"
              title="打开代码审查"
              aria-label="打开代码审查"
              onClick={handleGitClick}
            >
              <GitBranchIcon size={11} />
              <span className="inline-task-row-git-count">
                {fileCount} 个文件已更改
              </span>
              <span className="inline-task-row-git-changes">
                <span className="text-green-500">
                  +{gitStatus.totals.additions}
                </span>
                <span className="text-red-500">
                  -{gitStatus.totals.removals}
                </span>
              </span>
            </button>
          </>
        )}
      </div>

      <div className="inline-task-row-bottom-line" />

      {expanded && hasTasks && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="任务列表"
          className="inline-task-popover"
        >
          <ul className="inline-task-popover-list">
            {tasks.map((task) => (
              <li key={task.id} className="inline-task-popover-item">
                <button
                  type="button"
                  onClick={() => onToggleStatus(task)}
                  className="inline-task-popover-status"
                  title={
                    task.status === 'completed'
                      ? 'Reopen task'
                      : 'Mark task done'
                  }
                  aria-label={
                    task.status === 'completed'
                      ? 'Reopen task'
                      : 'Mark task done'
                  }
                >
                  {statusIcons[task.status]}
                </button>
                <span
                  className={
                    task.status === 'completed'
                      ? 'inline-task-popover-title inline-task-popover-title-done'
                      : 'inline-task-popover-title'
                  }
                >
                  {task.status === 'in_progress' && task.activeForm
                    ? task.activeForm
                    : task.subject}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}