// TodoToolRow — handles the `todo` / `todowrite` tool (see
// packages/agent/src/tool/TodoTool/TodoTool.ts). The tool takes a
// `todos[] + merge` interface and returns `summary_for_prompt + todos`.
// The chrome summary reads as natural language ("Created 3 todos",
// "Updated 5 todos, 2 completed") instead of the raw JSON dump.
//
// The expanded card renders a styled todolist matching the input-box
// aesthetic so the user sees a familiar checkbox list.

'use client';

import React, { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  CheckCircleIcon,
  SpinnerGapIcon,
  XCircleIcon,
} from '@/components/icons';
import { ActionRowChrome } from '../chrome/ActionRowChrome';
import { getStatus } from '../registry';
import type { ToolAction, ToolStatus } from '../types';

interface TodoToolRowProps {
  tool: ToolAction;
}

type TodoStatus = 'pending' | 'in_progress' | 'completed';

interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

interface TodoWriteResult {
  summary_for_prompt: string;
  todos: TodoItem[];
}

interface TodoUpdate {
  id: string;
  content?: string;
  status?: TodoStatus;
}

function parseTodoInput(input: unknown): {
  todos: TodoUpdate[];
  merge: boolean;
} {
  const inp = (input || {}) as Record<string, unknown>;
  const todosRaw = inp.todos;
  const todos: TodoUpdate[] = Array.isArray(todosRaw) ? todosRaw as TodoUpdate[] : [];
  const merge = inp.merge !== false; // default true
  return { todos, merge };
}

function parseTodoResult(result: string | undefined): TodoWriteResult | null {
  if (!result) return null;
  try {
    const parsed = JSON.parse(result);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.todos)) {
      return parsed as TodoWriteResult;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Build a natural-language summary for the chrome header.
 * - merge=false (replace): "Created N todo(s)"
 * - merge=true: "Updated todo list: N total, X completed"
 */
function buildSummary(input: unknown, result: TodoWriteResult | null): string {
  const { todos: inputTodos, merge } = parseTodoInput(input);
  const total = result?.todos?.length ?? inputTodos.length;
  const completed = result?.todos?.filter(t => t.status === 'completed').length ?? 0;

  if (!merge) {
    return total === 1 ? 'Created 1 todo' : `Created ${total} todos`;
  }

  if (total === 0) {
    return 'Cleared all todos';
  }

  if (completed === 0) {
    return total === 1 ? 'Updated 1 todo' : `Updated ${total} todos`;
  }

  return `${total} todos, ${completed} completed`;
}

function verbKeyFor(status: ToolStatus): string {
  if (status === 'running') return 'streaming.toolAction.running.todo';
  if (status === 'error') return 'streaming.toolAction.error.todo';
  return 'streaming.toolAction.done.todo';
}

export function TodoToolRow({ tool }: TodoToolRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const status = getStatus(tool);
  const hasResult = tool.result !== undefined && tool.result !== '';
  const resultData = useMemo(() => parseTodoResult(tool.result), [tool.result]);
  const summary = useMemo(() => buildSummary(tool.input, resultData), [tool.input, resultData]);
  const verbKey = verbKeyFor(status);

  return (
    <div>
      <ActionRowChrome
        status={status}
        verbKey={verbKey}
        canExpand={hasResult}
        expanded={expanded}
        hovered={hovered}
        durationMs={tool.durationMs}
        onClick={() => hasResult && setExpanded((prev) => !prev)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        buttonClassName={hasResult ? 'cursor-pointer' : 'cursor-default'}
      >
        {summary}
      </ActionRowChrome>

      <AnimatePresence initial={false}>
        {expanded && hasResult && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div className="mx-1 my-1 rounded-lg tool-card p-3 relative">
              {resultData ? (
                <TodoListBody todos={resultData.todos} />
              ) : (
                <div className="font-mono text-[11px] tool-card-muted whitespace-pre-wrap break-all max-h-[200px] overflow-auto leading-relaxed">
                  {tool.result || '(empty)'}
                </div>
              )}

              {/* Status badge - bottom right */}
              <div className="mt-2 flex justify-end">
                <TodoStatusBadge status={status} />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function TodoListBody({ todos }: { todos: TodoItem[] }) {
  if (todos.length === 0) {
    return (
      <div className="text-[12px] text-muted-foreground italic">
        No todos tracked yet.
      </div>
    );
  }

  return (
    <ul className="space-y-1.5">
      {todos.map((todo) => (
        <li key={todo.id} className="flex items-start gap-2">
          <TodoCheckbox todo={todo} />
          <span className={todo.status === 'completed'
            ? 'text-muted-foreground line-through text-[12px] leading-relaxed flex-1'
            : 'text-[12px] leading-relaxed flex-1'
          }>
            {todo.content || <span className="italic text-muted-foreground">(no content)</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function TodoCheckbox({ todo }: { todo: TodoItem }) {
  const isCompleted = todo.status === 'completed';
  const isInProgress = todo.status === 'in_progress';

  if (isCompleted) {
    return (
      <CheckCircleIcon
        size={14}
        className="flex-shrink-0 mt-0.5 text-green-500"
      />
    );
  }

  if (isInProgress) {
    return (
      <div className="flex-shrink-0 mt-0.5 w-[14px] h-[14px] rounded-full border-2 border-amber-400 bg-amber-400/20" />
    );
  }

  // pending — empty circle
  return (
    <div className="flex-shrink-0 mt-0.5 w-[14px] h-[14px] rounded-full border-2 border-[var(--border)]" />
  );
}

function TodoStatusBadge({ status }: { status: ToolStatus }) {
  if (status === 'success') {
    return (
      <div className="flex items-center gap-1 text-[11px] text-green-500">
        <CheckCircleIcon size={12} />
        <span>Success</span>
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="flex items-center gap-1 text-[11px] text-red-500">
        <XCircleIcon size={12} />
        <span>Failed</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1 text-[11px] text-amber-500">
      <SpinnerGapIcon size={12} className="animate-spin" />
      <span>Running</span>
    </div>
  );
}
