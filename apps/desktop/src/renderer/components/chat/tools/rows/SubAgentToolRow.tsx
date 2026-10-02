// SubAgentToolRow — one-line, non-expandable row for sub-agent tool calls.
// Shows agent type (colored) + live tool-usage stats with a fade-out tail
// when the line overflows. Clicking switches to the sub-agent's session.

'use client';

import React, { useMemo } from 'react';
import { RobotIcon } from '@/components/icons';
import { ActionRowChrome } from '../chrome/ActionRowChrome';
import { getRenderer } from '../registry';
import { parseSubAgentToolResult } from '@/lib/subagent-result';
import { useConversationStore } from '@/stores/conversation-store';
import { dispatchOpenSessionPanel } from '@/lib/open-session-panel-event';
import { useStreamingAgentProgress, type AgentProgressEventWithMeta } from '@/hooks/useStreamingAgentProgress';
import {
  SUBAGENT_EDIT_TOOLS,
  SUBAGENT_READ_TOOLS,
  SUBAGENT_SEARCH_TOOLS,
  SUBAGENT_SHELL_TOOLS,
  computeSubagentToolUseCounts,
  type SubagentToolUseCounts,
} from '@/lib/subagent-live-transcript';
import type { ToolAction } from '../types';

interface SubAgentToolRowProps {
  tool: ToolAction;
  agentProgressEvents?: AgentProgressEventWithMeta[];
}

type ToolStats = SubagentToolUseCounts;

function getPrefixColor(prefix: string): string | undefined {
  // Match whole words only so names like "QRCode scanner" don't pick up
  // the code color; hyphenated agent types ("code-reviewer") still match.
  const lower = prefix.toLowerCase();
  if (/\bexplore\b/.test(lower)) return '#3b82f6';
  if (/\bcod(e|ing)\b/.test(lower)) return 'var(--foreground)';
  if (/\bplan(ning)?\b/.test(lower)) return '#eab308';
  if (/\bresearch\b/.test(lower)) return '#a855f7';
  return undefined;
}

function getToolVerb(toolName?: string): string {
  if (!toolName) return '运行工具';
  const name = toolName.toLowerCase();
  if (SUBAGENT_READ_TOOLS.has(name)) return '读取文件';
  if (SUBAGENT_EDIT_TOOLS.has(name)) return '编辑文件';
  if (SUBAGENT_SEARCH_TOOLS.has(name)) return '搜索';
  if (SUBAGENT_SHELL_TOOLS.has(name)) return '执行命令';
  if (name.startsWith('browser_') || name.startsWith('browser-') || name === 'browser') return '浏览网页';
  if (name === 'todo' || name === 'todowrite') return '操作任务';
  if (name === 'askuserquestion') return '询问用户';
  if (name === 'duya_cli' || name === 'duya-cli' || name === 'duyacli') return '运行 CLI';
  if (name === 'task' || name === 'agent' || name === 'subagent' || name === 'sub_agent') return '运行子代理';
  if (name.startsWith('canvas_')) return '操作画布';
  return '运行工具';
}

function getStringInput(
  input: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function compactActivityTarget(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

function getToolTarget(event: AgentProgressEventWithMeta): string | undefined {
  const name = event.toolName?.toLowerCase() ?? '';
  const input = event.toolInput;

  if (SUBAGENT_SHELL_TOOLS.has(name) || name === 'duya_cli' || name === 'duya-cli' || name === 'duyacli') {
    return getStringInput(input, ['command', 'cmd', 'script', 'commandLine']);
  }
  if (SUBAGENT_READ_TOOLS.has(name) || SUBAGENT_EDIT_TOOLS.has(name)) {
    return getStringInput(input, ['file_path', 'filePath', 'path', 'file', 'filename']);
  }
  if (SUBAGENT_SEARCH_TOOLS.has(name)) {
    return getStringInput(input, ['query', 'pattern', 'glob', 'path']);
  }
  if (name.startsWith('browser_') || name.startsWith('browser-') || name === 'browser') {
    return getStringInput(input, ['url', 'query', 'selector']);
  }
  return undefined;
}

function getToolActivityPhrase(event: AgentProgressEventWithMeta, isActive: boolean): string {
  const verb = getToolVerb(event.toolName);
  const target = getToolTarget(event);
  return `${isActive ? '正在' : '刚完成'}${verb}${target ? `：${compactActivityTarget(target)}` : ''}`;
}

function getLivePhrase(latest: AgentProgressEventWithMeta | undefined): string | null {
  if (!latest) return null;
  switch (latest.type) {
    case 'started':
      return '启动中...';
    case 'thinking':
      return '思考中...';
    case 'tool_use':
      return getToolActivityPhrase(latest, true);
    case 'tool_result':
      return getToolActivityPhrase(latest, false);
    case 'text':
      return '输出结果中...';
    case 'done':
      return '已完成';
    case 'error':
      return '失败';
    default:
      return null;
  }
}

function buildStatsPhrase(stats: ToolStats): string {
  const parts: string[] = [];
  if (stats.read > 0) parts.push(`读${stats.read}`);
  if (stats.edit > 0) parts.push(`写${stats.edit}`);
  if (stats.search > 0) parts.push(`搜${stats.search}`);
  if (stats.shell > 0) parts.push(`命令${stats.shell}`);
  if (stats.browser > 0) parts.push(`浏览${stats.browser}`);
  if (stats.other > 0) parts.push(`其他${stats.other}`);
  if (parts.length === 0) return '';
  return `${parts.join('·')} (${stats.total})`;
}

function buildStatusPhrase(
  latest: AgentProgressEventWithMeta | undefined,
  lastToolEvent: AgentProgressEventWithMeta | undefined,
  isRunning: boolean,
  isError: boolean,
  stats: ToolStats,
): string {
  if (isError) return '失败';

  if (!isRunning) {
    const statsPhrase = buildStatsPhrase(stats);
    if (statsPhrase) return `已完成 · ${statsPhrase}`;
    return '已完成';
  }

  const activity = lastToolEvent
    ? getToolActivityPhrase(lastToolEvent, lastToolEvent.type === 'tool_use')
    : null;
  const live = activity ?? getLivePhrase(latest);
  const statsPhrase = buildStatsPhrase(stats);
  if (live && statsPhrase) return `${live} · ${statsPhrase}`;
  if (live) return live;
  if (statsPhrase) return statsPhrase;
  return '初始化中...';
}

export interface SubagentEventSelection {
  /** The sub-agent's own session id, once the launch receipt arrived. */
  sessionId?: string;
  /** The run's task id, from the receipt or from the `started` event. */
  taskId?: string;
  description?: string;
  name?: string;
  subagentType?: string;
}

/**
 * Pick the progress events belonging to ONE sub-agent run out of the merged
 * parent-channel log.
 *
 * Exported for unit testing: the cross-wiring bug this fixes (two concurrent
 * same-type sub-agents sharing one row's status) lives entirely in here.
 *
 * Resolution order, strongest identity first:
 *  1. child `sessionId` — the child session id is carried on every event.
 *  2. `agentId` === the run's task id — the id the `started` event carries at
 *     spawn, which is what makes a still-running run addressable.
 *  3. the `started` group whose description/name matches the tool input
 *     (pre-571 fallback; also how a row binds its task id on first sight).
 *  4. agent type substring.
 *  5. All events — ONLY when exactly one run is present in the log. With
 *     several distinct `agentId`s, returning everything is precisely the
 *     cross-wiring bug, so an unmatchable row renders nothing instead.
 */
export function selectSubagentEvents(
  events: AgentProgressEventWithMeta[],
  selector: SubagentEventSelection,
): AgentProgressEventWithMeta[] {
  if (events.length === 0) return events;

  const { sessionId, taskId } = selector;
  if (sessionId) {
    const filtered = events.filter((event) => event.sessionId === sessionId);
    if (filtered.length > 0) return filtered;
  }
  if (taskId) {
    const filtered = events.filter((event) => event.agentId === taskId);
    if (filtered.length > 0) return filtered;
  }

  // Runs present in the log, keyed by task id. One entry means the row is the
  // only sub-agent in flight, which makes the "everything" fallback safe.
  const runIds = new Set(events.map((event) => event.agentId).filter((id): id is string => !!id));
  const desc = selector.description || selector.name || '';
  if (desc) {
    const byDesc = events.filter((event) => {
      const eventDesc = event.agentDescription || event.agentName || '';
      return eventDesc === desc;
    });
    if (byDesc.length > 0) return byDesc;
  }
  if (selector.subagentType) {
    const type = selector.subagentType.toLowerCase();
    const byType = events.filter((event) => (event.agentType || '').toLowerCase().includes(type));
    if (byType.length > 0) return byType;
  }

  if (runIds.size <= 1) return events;
  return [];
}

export function SubAgentToolRow({ tool, agentProgressEvents }: SubAgentToolRowProps) {
  const renderer = getRenderer(tool.name);
  const summary = renderer.getSummary(tool.input, tool.name);
  const parsedResult = useMemo(() => parseSubAgentToolResult(tool.result), [tool.result]);

  // The prop-based event stream is only populated when the parent renders
  // via StreamingMessage. History-rendered messages (MessageItem) do not
  // forward agentProgressEvents, so a background sub-agent that outlives
  // the parent turn would lose its live status + click target. Subscribe
  // directly to the active session's progress channel as a fallback so
  // the row keeps updating regardless of which renderer mounted it.
  const activeThreadId = useConversationStore((s) => s.activeThreadId);
  const ownEvents = useStreamingAgentProgress(activeThreadId || '');
  const mergedEvents = useMemo(() => {
    const seen = new Set<string>();
    const out: AgentProgressEventWithMeta[] = [];
    for (const e of agentProgressEvents ?? []) {
      const key = `${e.agentId ?? ''}-${e.type}-${e.receivedAt ?? 0}-${e.toolName ?? ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(e);
      }
    }
    for (const e of ownEvents) {
      const key = `${e.agentId ?? ''}-${e.type}-${e.receivedAt ?? 0}-${e.toolName ?? ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(e);
      }
    }
    return out;
  }, [agentProgressEvents, ownEvents]);

  // Filter events for THIS sub-agent.
  //
  // Plan 571: the correlation key is the run's task id, carried on every
  // progress event as `agentId` (`buildChatAgentProgressPayload`) and stamped
  // onto the `started` event synchronously at spawn — so the row can bind to
  // it while the run is still in flight. The previous implementation matched
  // running runs by `description` / `name` string equality and finally by
  // "all events", which cross-wired two concurrent sub-agents of the same
  // type. String matching survives only as a last-resort fallback for
  // sessions recorded before the `started` event existed.
  const toolInput = tool.input as Record<string, unknown> | undefined;
  const inputDescription = typeof toolInput?.description === 'string' ? toolInput.description : '';
  const inputName = typeof toolInput?.name === 'string' ? toolInput.name : '';
  const inputSubagentType = typeof toolInput?.subagent_type === 'string' ? toolInput.subagent_type : '';

  const subAgentEvents = useMemo(
    () => selectSubagentEvents(mergedEvents, {
      sessionId: parsedResult?.sessionId,
      taskId: parsedResult?.taskId || parsedResult?.agentId,
      description: inputDescription,
      name: inputName,
      subagentType: inputSubagentType,
    }),
    [mergedEvents, parsedResult?.sessionId, parsedResult?.agentId, parsedResult?.taskId, inputDescription, inputName, inputSubagentType],
  );

  const latestEvent = subAgentEvents[subAgentEvents.length - 1];
  const lastToolEvent = useMemo(
    () => [...subAgentEvents].reverse().find((event) => event.type === 'tool_use' || event.type === 'tool_result'),
    [subAgentEvents],
  );
  const isBackground = parsedResult?.background === true;
  const isError = tool.isError || !!parsedResult?.error || latestEvent?.type === 'error';
  const hasTerminalEvent = latestEvent?.type === 'done' || latestEvent?.type === 'error';
  // A background Agent tool returns a successful launch receipt immediately.
  // That receipt is not the sub-agent's completion signal; only a terminal
  // agent_progress event can move the row out of its running state.
  const isRunning = !isError && (
    tool.result === undefined ||
    (isBackground && !hasTerminalEvent)
  );
  const metaEvent = useMemo(
    () => [...subAgentEvents].reverse().find((e) => e.agentType || e.agentName || e.agentDescription),
    [subAgentEvents],
  );

  const targetSessionId = parsedResult?.sessionId
    || subAgentEvents.find((e) => e.sessionId)?.sessionId;

  const stats = useMemo(() => computeSubagentToolUseCounts(subAgentEvents), [subAgentEvents]);

  // The run's task id, for the panel's stop control. The parsed result is the
  // authoritative source; while a foreground run is still executing the row
  // binds to the id the `started` event carries.
  const runTaskId = parsedResult?.taskId
    || parsedResult?.agentId
    || subAgentEvents.find((e) => e.type === 'started' && e.agentId)?.agentId
    || subAgentEvents[0]?.agentId;

  const prefix = parsedResult?.resolvedAgentType
    || parsedResult?.agentType
    || metaEvent?.agentName
    || metaEvent?.agentType
    || inputSubagentType
    || 'SubAgent';

  const description = summary
    || parsedResult?.description
    || metaEvent?.agentDescription
    || inputDescription
    || '';

  const statusPhrase = buildStatusPhrase(latestEvent, lastToolEvent, isRunning, isError, stats);
  const prefixColor = getPrefixColor(prefix);

  const handleClick = () => {
    if (!targetSessionId) return;
    // ZCode-parity: a subagent row opens the sub-agent's session as a
    // read-only view in the sidebar panel instead of yanking the main
    // column away from the parent transcript. The panel's header offers
    // "open in main view" for the old jump-into behavior, plus a stop
    // control that needs the parent thread id and this run's task id.
    dispatchOpenSessionPanel(
      targetSessionId,
      `${prefix}${description ? ` · ${description}` : ''}`,
      {
        parentSessionId: activeThreadId || undefined,
        taskId: runTaskId || undefined,
      },
    );
  };

  const status = isError ? 'error' : isRunning ? 'running' : 'success';

  return (
    <ActionRowChrome
      status={status}
      verbKey={undefined}
      canExpand={false}
      expanded={false}
      hovered={false}
      durationMs={tool.durationMs}
      onClick={targetSessionId ? handleClick : undefined}
      buttonClassName={targetSessionId ? 'cursor-pointer' : 'cursor-default'}
    >
      <div className="group relative flex items-center gap-1.5 min-w-0 w-full">
        <RobotIcon size={14} className="shrink-0 text-muted-foreground" />
        <div className="relative min-w-0 flex-1 overflow-hidden">
          <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
            <span
              className="transition-all group-hover:brightness-75 font-medium"
              style={prefixColor ? { color: prefixColor } : undefined}
            >
              {prefix}
            </span>
            {description && (
              <span className="text-muted-foreground/80">{description}</span>
            )}
            <span className="text-muted-foreground/50">·</span>
            <span className="text-muted-foreground/80">{statusPhrase}</span>
          </span>
          {/* Fade-out mask when content overflows the row width */}
          <span
            className="pointer-events-none absolute inset-y-0 right-0 w-8"
            style={{
              background: 'linear-gradient(to right, transparent, var(--bg-canvas, var(--background)))',
            }}
          />
        </div>
      </div>
    </ActionRowChrome>
  );
}
