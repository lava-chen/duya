// src/components/layout/FloatingTaskPanel.tsx
// Tasks popover anchored above the composer, mirroring the agent's
// plan/step progress UI in Figure 2. It shows:
//   - collapsed pill: current step + file-change tally
//   - expanded popover: step list with status icons + per-file diff stats
//
// The panel only renders when there are tasks or git file changes that the
// caller has marked as belonging to the current agent turn.

'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Task, TaskStatus } from '@duya/agent';
import {
  CheckIcon,
  CircleIcon,
  SpinnerIcon,
  CaretDownIcon,
  GitBranchIcon,
} from '@/components/icons';
import type { UseGitStatusResult } from '@/hooks/useGitStatus';
import { useOptionalPanel } from '@/hooks/usePanel';

export interface FloatingTaskPanelProps {
  tasks: Task[];
  gitStatus: UseGitStatusResult;
  onToggleStatus: (task: Task) => void;
  workingDirectory?: string | null;
  /**
   * When false the file-change pill is hidden even if git changes exist.
   * Used to show file changes only for the current active agent turn.
   */
  showFileChanges?: boolean;
}

const statusIcons: Record<TaskStatus, React.ReactNode> = {
  pending: <CircleIcon size={12} className="text-muted-foreground/45" />,
  in_progress: <SpinnerIcon size={12} className="text-accent animate-spin" />,
  completed: <CheckIcon size={12} className="text-green-500" />,
};

export function FloatingTaskPanel({
  tasks,
  gitStatus,
  onToggleStatus,
  workingDirectory,
  showFileChanges = true,
}: FloatingTaskPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const panel = useOptionalPanel();
  const fileCount = gitStatus.totals.fileCount;
  const hasTasks = tasks.length > 0;
  const hasFiles = fileCount > 0;
  const hasContent = hasTasks || (hasFiles && showFileChanges);

  // Close when clicking outside.
  useEffect(() => {
    if (!expanded) return;
    const onDocClick = (e: MouseEvent) => {
      if (!panelRef.current) return;
      if (!panelRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [expanded]);

  // Render only when there are tasks or file changes to show.
  if (!hasContent) return null;

  const completed = tasks.filter((t) => t.status === 'completed').length;
  const activeTask = tasks.find((t) => t.status === 'in_progress');
  const currentLabel = activeTask?.subject ?? tasks[0]?.subject ?? '';
  const progressText = `第 ${completed + 1} / ${tasks.length} 步`;

  return (
    <div
      ref={panelRef}
      className="floating-task-panel"
      data-testid="floating-task-panel"
    >
      {/* Collapsed pill */}
      <div className="floating-task-pill">
        {hasTasks && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="floating-task-pill-main"
            aria-expanded={expanded}
          >
            {activeTask ? statusIcons.in_progress : statusIcons.completed}
            <span className="floating-task-pill-text truncate">{currentLabel}</span>
            <span className="floating-task-pill-divider" />
            <span className="floating-task-pill-progress">{progressText}</span>
            <CaretDownIcon
              size={10}
              className={`floating-task-pill-caret${expanded ? ' rotate-180' : ''}`}
            />
          </button>
        )}
        {hasFiles && showFileChanges && (
          <button
            type="button"
            className="floating-task-pill-git"
            title="打开代码审查"
            aria-label="打开代码审查"
            onClick={() => {
              if (workingDirectory) {
                panel?.openOrActivatePage('review', { workingDirectory });
              }
            }}
          >
            {hasTasks && <span className="floating-task-pill-divider" />}
            <GitBranchIcon size={11} className="text-muted-foreground" />
            <span className="floating-task-pill-filecount">
              {fileCount} 个文件已更改
            </span>
            <span className="floating-task-pill-changes">
              <span className="text-green-500">+{gitStatus.totals.additions}</span>
              <span className="text-red-500">-{gitStatus.totals.removals}</span>
            </span>
          </button>
        )}
      </div>

      {/* Expanded popover */}
      <AnimatePresence>
        {expanded && hasTasks && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.97, x: '-50%' }}
            animate={{ opacity: 1, y: 0, scale: 1, x: '-50%' }}
            exit={{ opacity: 0, y: 6, scale: 0.98, x: '-50%' }}
            transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
            className="floating-task-popover"
          >
            <ul className="floating-task-list">
              {tasks.map((task) => (
                <li key={task.id} className="floating-task-item">
                  <button
                    type="button"
                    onClick={() => onToggleStatus(task)}
                    className="floating-task-status"
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
                    className={`floating-task-title${
                      task.status === 'completed'
                        ? ' floating-task-title-done'
                        : ''
                    }`}
                  >
                    {task.subject}
                  </span>
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
