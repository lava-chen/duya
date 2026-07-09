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
import { useTranslation } from '@/hooks/useTranslation';
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
 * Parse the result envelope into a structured view so the expanded body
 * can render natural-language lines instead of a JSON dump. The `list`
 * action returns plain text (one task per line) and is forwarded as-is.
 */
type TaskResultView =
  | { kind: 'create'; taskId: string; subject: string }
  | { kind: 'update'; taskId: string; subject: string; status: string; notification?: string }
  | { kind: 'stop'; taskId: string }
  | { kind: 'output'; taskId: string; status: string; output: string; notCompleted?: boolean }
  | { kind: 'get'; task: Record<string, unknown> }
  | { kind: 'raw'; text: string }
  | { kind: 'error'; message: string };

function parseResultForDisplay(
  result: string | undefined,
  inputAction: TaskAction | null,
): TaskResultView {
  if (!result) return { kind: 'raw', text: '' };
  const trimmed = result.trim();
  // `list` returns human-readable text, one task per line — forward as-is.
  if (inputAction === 'list' || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    return { kind: 'raw', text: result };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: 'raw', text: result };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.error === 'string') {
    return { kind: 'error', message: obj.error };
  }
  const task = (obj.task ?? {}) as Record<string, unknown>;
  const taskId = String(task.id ?? obj.taskId ?? '');
  const subject = typeof task.subject === 'string' ? task.subject : '';
  const status = typeof task.status === 'string' ? task.status : (typeof obj.status === 'string' ? obj.status : '');

  if (inputAction === 'create') {
    return { kind: 'create', taskId, subject };
  }
  if (inputAction === 'update') {
    const notification = typeof obj.notification === 'string' ? obj.notification : undefined;
    return { kind: 'update', taskId, subject, status, notification };
  }
  if (inputAction === 'stop') {
    return { kind: 'stop', taskId };
  }
  if (inputAction === 'output') {
    const output = typeof obj.output === 'string' ? obj.output : '';
    const notCompleted = output === '' && typeof obj.message === 'string';
    return { kind: 'output', taskId, status, output, notCompleted };
  }
  if (inputAction === 'get') {
    return { kind: 'get', task };
  }
  return { kind: 'raw', text: result };
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
    () => parseResultForDisplay(tool.result, action),
    [tool.result, action],
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
              {/* Result body — natural-language summary keyed off the
               * action, so the user reads "已创建任务 #5：..." instead
               * of {"task":{"id":5,...}}. The `list` action already
               * returns one task per line as plain text and is shown
               * verbatim. */}
              <TaskResultBody view={resultView} />

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

function TaskResultBody({ view }: { view: TaskResultView }) {
  const { t } = useTranslation();
  switch (view.kind) {
    case 'create':
      return (
        <div className="text-[12px] leading-relaxed">
          {t('streaming.toolAction.body.task.created', { id: view.taskId, subject: view.subject })}
        </div>
      );
    case 'update': {
      // Prefer the explicit completion notification when present;
      // otherwise pick a line based on the new status.
      if (view.notification) {
        return <div className="text-[12px] leading-relaxed">{view.notification}</div>;
      }
      const key =
        view.status === 'completed'
          ? 'streaming.toolAction.body.task.completed'
          : view.status === 'in_progress'
            ? 'streaming.toolAction.body.task.started'
            : 'streaming.toolAction.body.task.updated';
      return (
        <div className="text-[12px] leading-relaxed">
          {t(key, { id: view.taskId, subject: view.subject })}
        </div>
      );
    }
    case 'stop':
      return (
        <div className="text-[12px] leading-relaxed">
          {t('streaming.toolAction.body.task.stopped', { id: view.taskId })}
        </div>
      );
    case 'output':
      return (
        <div className="text-[12px] leading-relaxed space-y-1">
          <div className="font-medium">
            {t('streaming.toolAction.body.task.outputHeader', { id: view.taskId })}
          </div>
          <div className="font-mono text-[11px] whitespace-pre-wrap break-all max-h-[160px] overflow-auto tool-card-muted rounded p-2">
            {view.notCompleted
              ? t('streaming.toolAction.body.task.emptyOutput')
              : (view.output || t('streaming.toolAction.body.task.emptyOutput'))}
          </div>
        </div>
      );
    case 'get': {
      const task = view.task;
      const id = String(task.id ?? '');
      const subject = typeof task.subject === 'string' ? task.subject : '';
      const status = typeof task.status === 'string' ? task.status : '';
      const desc = typeof task.description === 'string' ? task.description : '';
      const owner = typeof task.owner === 'string' ? task.owner : '';
      const blockedBy = Array.isArray(task.blockedBy) ? task.blockedBy : [];
      return (
        <div className="text-[12px] leading-relaxed space-y-1">
          <div>
            <span className="font-medium">#{id}</span>{' '}{subject}
          </div>
          <div className="text-muted-foreground">
            {t('streaming.toolAction.body.task.statusLabel', { status })}
          </div>
          {owner && (
            <div className="text-muted-foreground">
              {t('streaming.toolAction.body.task.ownerLabel', { owner })}
            </div>
          )}
          {blockedBy.length > 0 && (
            <div className="text-muted-foreground">
              {t('streaming.toolAction.body.task.descLabel', {
                desc: `blocked by #${(blockedBy as string[]).join(', #')}`,
              })}
            </div>
          )}
          <div className="text-muted-foreground">
            {t('streaming.toolAction.body.task.descLabel', {
              desc: desc || t('streaming.toolAction.body.task.noDesc'),
            })}
          </div>
        </div>
      );
    }
    case 'error':
      return (
        <div className="text-[12px] leading-relaxed text-red-500">
          {t('streaming.toolAction.body.task.errorPrefix', { message: view.message })}
        </div>
      );
    case 'raw':
    default:
      return (
        <div className="font-mono text-[11px] tool-card-muted whitespace-pre-wrap break-all max-h-[200px] overflow-auto leading-relaxed">
          {view.text || t('streaming.toolAction.body.task.emptyOutput')}
        </div>
      );
  }
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