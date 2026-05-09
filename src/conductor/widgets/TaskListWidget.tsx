"use client";

import type { WidgetComponentProps } from "./registry";
import { Plus, Trash, Check, Circle, Flag } from "@phosphor-icons/react";

interface Task {
  id: string;
  title: string;
  completed: boolean;
  priority?: "high" | "medium" | "low";
}

const PRIORITY_COLORS: Record<string, string> = {
  high: "var(--error)",
  medium: "var(--accent)",
  low: "var(--muted)",
};

export function TaskListWidget({ data, onChange, readOnly }: WidgetComponentProps) {
  const tasks = (data.tasks as Task[]) || [];
  const newTaskText = (data._newTaskText as string) || "";

  const completedCount = tasks.filter((t) => t.completed).length;
  const progress = tasks.length > 0 ? Math.round((completedCount / tasks.length) * 100) : 0;

  const addTask = () => {
    if (!newTaskText.trim() || readOnly) return;
    const task: Task = {
      id: crypto.randomUUID(),
      title: newTaskText.trim(),
      completed: false,
      priority: "medium",
    };
    onChange({ ...data, tasks: [...tasks, task], _newTaskText: "" });
  };

  const toggleTask = (id: string) => {
    onChange({
      ...data,
      tasks: tasks.map((t) =>
        t.id === id ? { ...t, completed: !t.completed } : t
      ),
    });
  };

  const deleteTask = (id: string) => {
    onChange({
      ...data,
      tasks: tasks.filter((t) => t.id !== id),
    });
  };

  const setNewText = (text: string) => {
    onChange({ ...data, _newTaskText: text });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") addTask();
  };

  return (
    <div className="flex flex-col gap-2 h-full">
      {tasks.length > 0 && (
        <div className="flex items-center gap-2 mb-1">
          <div className="flex-1 h-1.5 rounded-full bg-[var(--surface-hover)] overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${progress}%`,
                backgroundColor:
                  progress === 100
                    ? "var(--success)"
                    : progress > 50
                    ? "var(--accent)"
                    : "var(--muted)",
              }}
            />
          </div>
          <span className="text-[10px] text-[var(--muted)] flex-shrink-0">
            {completedCount}/{tasks.length}
          </span>
        </div>
      )}

      <div className="flex flex-col gap-1.5 flex-1 min-h-0 overflow-y-auto">
        {tasks.map((task) => (
          <div
            key={task.id}
            className="flex items-center gap-2 group rounded-md px-1.5 py-1 -mx-1.5 hover:bg-[var(--surface-hover)] transition-colors"
          >
            <button
              type="button"
              onClick={() => toggleTask(task.id)}
              disabled={readOnly}
              className={`flex items-center justify-center w-4 h-4 rounded-full border flex-shrink-0 transition-all ${
                task.completed
                  ? "border-[var(--success)] bg-[var(--success)] text-white"
                  : "border-[var(--border)] text-transparent hover:border-[var(--accent)]"
              } disabled:opacity-50`}
            >
              {task.completed && <Check size={9} weight="bold" />}
            </button>

            <span
              className={`flex-1 text-xs leading-snug ${
                task.completed
                  ? "line-through text-[var(--muted)] opacity-50"
                  : "text-[var(--text)]"
              }`}
            >
              {task.title}
            </span>

            {task.priority && !task.completed && (
              <Flag
                size={10}
                className="flex-shrink-0 opacity-60"
                style={{ color: PRIORITY_COLORS[task.priority] || "var(--muted)" }}
              />
            )}

            {!readOnly && (
              <button
                type="button"
                onClick={() => deleteTask(task.id)}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--muted)] hover:text-[var(--error)] transition-all flex-shrink-0"
              >
                <Trash size={11} />
              </button>
            )}
          </div>
        ))}
      </div>

      {!readOnly && (
        <div className="flex items-center gap-2 mt-1 pt-1.5 border-t border-[var(--border)]">
          <span className="flex items-center justify-center w-4 h-4 flex-shrink-0">
            <Circle size={11} className="text-[var(--muted)] opacity-40" />
          </span>
          <input
            type="text"
            value={newTaskText}
            onChange={(e) => setNewText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Add a task..."
            className="flex-1 bg-transparent border-none outline-none text-xs text-[var(--text)] placeholder:text-[var(--muted)] placeholder:opacity-40 py-0.5"
          />
          <button
            type="button"
            onClick={addTask}
            disabled={!newTaskText.trim()}
            className="flex items-center justify-center w-5 h-5 rounded-md text-[var(--muted)] hover:text-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:opacity-30 transition-all flex-shrink-0"
          >
            <Plus size={12} />
          </button>
        </div>
      )}

      {tasks.length === 0 && readOnly && (
        <div className="flex items-center justify-center flex-1 text-[11px] text-[var(--muted)] opacity-50">
          No tasks yet
        </div>
      )}
    </div>
  );
}

export const TaskListDefinition = {
  kind: "builtin" as const,
  type: "task-list",
  label: "Task List",
  component: TaskListWidget,
  defaultData: { tasks: [], _newTaskText: "" },
  defaultConfig: { title: "✅ 任务列表" },
  defaultSize: { w: 4, h: 4 },
  minSize: { w: 2, h: 2 },
};
