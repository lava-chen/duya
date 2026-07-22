// src/components/layout/TaskListSection.tsx
// Renders the Tasks section inside the TaskDrawer: a list of TaskRow
// items with an empty state, plus the status icons / colors that map
// each task status to a visual style. Mutation is delegated to the
// container via onToggleStatus / onDelete callbacks.

'use client';

import React from 'react';
import {
  ArrowCounterClockwiseIcon,
  CheckIcon,
  CircleIcon,
  SpinnerIcon,
  TrashIcon,
} from '@/components/icons';
import type { Task, TaskStatus } from '@duya/agent';
import { DrawerSection } from './DrawerSection';

const statusIcons: Record<TaskStatus, React.ReactNode> = {
  pending: <CircleIcon size={12} className="text-muted-foreground/45" />,
  in_progress: <SpinnerIcon size={12} className="text-accent animate-spin" />,
  completed: <CheckIcon size={12} className="text-green-500" />,
};

const statusColors: Record<TaskStatus, string> = {
  pending: "text-muted-foreground/85",
  in_progress: "text-foreground font-medium",
  completed: "text-muted-foreground/45 line-through",
};

export interface TaskListSectionProps {
  tasks: Task[];
  loading: boolean;
  onToggleStatus: (task: Task) => void;
  onDelete: (task: Task) => void;
}

export function TaskListSection({
  tasks,
  loading,
  onToggleStatus,
  onDelete,
}: TaskListSectionProps) {
  return (
    <DrawerSection label="Tasks">
      {tasks.length === 0 && !loading && (
        <div className="task-card-empty">No tasks yet.</div>
      )}
      {tasks.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          onToggleStatus={() => onToggleStatus(task)}
          onDelete={() => onDelete(task)}
        />
      ))}
    </DrawerSection>
  );
}

function TaskRow({
  task,
  onToggleStatus,
  onDelete,
}: {
  task: Task;
  onToggleStatus: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="task-card-row group" title={task.description}>
      <button
        type="button"
        onClick={onToggleStatus}
        className="task-card-status"
        title={task.status === "completed" ? "Reopen" : "Mark done"}
        aria-label={task.status === "completed" ? "Reopen task" : "Mark task done"}
      >
        {statusIcons[task.status]}
      </button>
      <span className={`task-card-row-title ${statusColors[task.status]}`}>
        {task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject}
      </span>
      {task.owner && task.status !== "completed" && (
        <span className="task-card-row-meta">{task.owner}</span>
      )}
      {task.blockedBy.length > 0 && (
        <span className="task-card-row-blocked">blocked</span>
      )}
      <div className="task-card-row-actions">
        {task.status === "completed" ? (
          <button
            type="button"
            onClick={onToggleStatus}
            className="task-card-row-action"
            title="Reopen"
            aria-label="Reopen task"
          >
            <ArrowCounterClockwiseIcon size={11} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onDelete}
          className="task-card-row-action danger"
          title="Delete"
          aria-label="Delete task"
        >
          <TrashIcon size={11} />
        </button>
      </div>
    </div>
  );
}