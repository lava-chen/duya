// TaskToolRow — handles the `task` tool (see
// packages/agent/src/tool/TaskTool/TaskTool.ts). The tool takes one of
// six actions (`create` / `get` / `list` / `update` / `output` / `stop`)
// and the chrome summary / verb are dispatched from that action so the
// header reads as natural language instead of dumping the raw JSON.
//
// Two behaviours beyond rendering:
//
// 1. On a successful `create` or `update` with status `completed`, the
//    TaskDrawer auto-opens so the user sees the new state without
//    needing to dig into the result. The trigger is one-shot per row
//    via a ref — subsequent re-renders (e.g. when the same task tool
//    stream updates the input) don't re-fire the drawer.
//
// 2. The expanded card shows the parsed JSON envelope so the user can
//    inspect the resulting `task` payload (id, status, etc.) without
//    expanding into the same mono dump the catch-all renderer used to
//    produce.

'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  CheckCircleIcon,
  SpinnerGapIcon,
  XCircleIcon,
} from '@/components/icons';
import { ActionRowChrome } from '../chrome/ActionRowChrome';
import { getStatus } from '../registry';
import { setTaskDrawerOpen } from '@/components/layout/task-drawer-store';
import type { TranslationKey } from '@/i18n';
import type { ToolAction, ToolStatus } from '../types';

interface TaskToolRowProps {
  tool: ToolAction;
}

type TaskAction = 'create' | 'get' | 'list' | 'update' | 'output' | 'stop';

const TASK_ACTIONS: ReadonlySet<TaskAction> = new Set([
  'create', 'get', 'list', 'update', 'output', 'stop',
]);

function parseTaskInput(input: unknown): {
  action: TaskAction | null;
  subject: string;
  taskId: string;
  status: string;
} {
  const inp = (input || {}) as Record<string, unknown>;
  const rawAction = typeof inp.action === 'string' ? inp.action : '';
  const action = TASK_ACTIONS.has(rawAction as TaskAction) ? (rawAction as TaskAction) : null;
  const subject = typeof inp.subject === 'string' ? inp.subject.trim() : '';
  const taskId = typeof inp.taskId === 'string' ? inp.taskId.trim() : '';
  const status = typeof inp.status === 'string' ? inp.status : '';
  return { action, subject, taskId, status };
}

function verbKeyFor(action: TaskAction | null, status: ToolStatus): TranslationKey {
  if (status === 'running') return 'streaming.toolAction.running.task';
  if (status === 'error') return 'streaming.toolAction.error.task';
  switch (action) {
    case 'create':
      return 'streaming.toolAction.done.task.create';
    case 'update':
      return 'streaming.toolAction.done.task.update';
    case 'list':
      return 'streaming.toolAction.done.task.list';
    case 'get':
      return 'streaming.toolAction.done.task.get';
    case 'output':
      return 'streaming.toolAction.done.task.output';
    case 'stop':
      return 'streaming.toolAction.done.task.stop';
    default:
      return 'streaming.toolAction.done.task.list';
  }
}

/**
 * Pretty-print the JSON result envelope so the user can read the
 * returned task payload directly. Falls back to the raw string for
 * legacy / non-JSON payloads (e.g. the `list` action returns
 * human-readable lines, not a JSON envelope).
 */
function parseResultForDisplay(result: string | undefined): {
  kind: 'json';
  text: string;
} | {
  kind: 'raw';
  text: string;
} {
  if (!result) return { kind: 'raw', text: '' };
  const trimmed = result.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return { kind: 'raw', text: result };
  }
  try {
    const parsed = JSON.parse(trimmed);
    return { kind: 'json', text: JSON.stringify(parsed, null, 2) };
  } catch {
    return { kind: 'raw', text: result };
  }
}

export function TaskToolRow({ tool }: TaskToolRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const status = getStatus(tool);
  const hasResult = tool.result !== undefined && tool.result !== '';
  const { action, subject, taskId, status: inputStatus } = useMemo(
    () => parseTaskInput(tool.input),
    [tool.input],
  );
  const resultView = useMemo(
    () => parseResultForDisplay(tool.result),
    [tool.result],
  );

  // Auto-open the TaskDrawer on a successful `create` or `update`
  // (status: completed) so the user sees the new task without having to
  // find the result manually. The ref ensures we only fire once per row
  // — re-renders from streaming updates won't re-open the drawer if it
  // was already opened, then closed, by the user.
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (autoOpenedRef.current) return;
    if (!hasResult || status === 'error') return;
    const isCreate = action === 'create';
    const isCompleteUpdate = action === 'update' && inputStatus === 'completed';
    if (!isCreate && !isCompleteUpdate) return;
    autoOpenedRef.current = true;
    setTaskDrawerOpen(true);
  }, [hasResult, status, action, inputStatus]);

  // Header summary — reuse the registry's getSummary so the chrome
  // header and the row body stay byte-identical.
  const summary = useMemo(() => {
    const inp = (tool.input || {}) as Record<string, unknown>;
    // Mirror the registry's getSummary verbatim so the chrome header
    // (which uses registry.getSummary) and this row's verb label stay
    // aligned. Keep this lightweight; the registry already handles the
    // longest cases (subject truncation, taskId fallback).
    if (action === 'create') return subject || 'task';
    if (action === 'list') return 'tasks';
    if (action === 'output') return taskId ? `task #${taskId} output` : 'task output';
    if (taskId) return `task #${taskId}`;
    return 'task';
  }, [action, subject, taskId, tool.input]);

  const verbKey = verbKeyFor(action, status);

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
              {/* Result body — pretty JSON for the {task: ...} envelope
               * the create / get / update / output / stop actions all
               * return; raw text for the `list` action which returns
               * one task per line as a plain string. */}
              <div className="font-mono text-[11px] tool-card-muted whitespace-pre-wrap break-all max-h-[200px] overflow-auto leading-relaxed">
                {resultView.kind === 'json' ? resultView.text : resultView.text || '(empty)'}
              </div>

              {/* Status badge - bottom right, matching BashToolRow */}
              <div className="mt-2 flex justify-end">
                <TaskStatusBadge status={status} />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function TaskStatusBadge({ status }: { status: ToolStatus }) {
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