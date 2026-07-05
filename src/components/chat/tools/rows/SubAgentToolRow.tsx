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
import { useStreamingAgentProgress, type AgentProgressEventWithMeta } from '@/hooks/useStreamingAgentProgress';
import type { ToolAction } from '../types';

interface SubAgentToolRowProps {
  tool: ToolAction;
  agentProgressEvents?: AgentProgressEventWithMeta[];
}

const READ_TOOLS = new Set([
  'read',
  'readfile',
  'read_file',
  'read_multiple_files',
]);

const EDIT_TOOLS = new Set([
  'edit',
  'edit_file',
  'str_replace_editor',
  'write',
  'writefile',
  'write_file',
  'create_file',
  'createfile',
]);

const SEARCH_TOOLS = new Set([
  'search',
  'glob',
  'grep',
  'find_files',
  'search_files',
]);

const SHELL_TOOLS = new Set([
  'shell',
  'bash',
  'execute',
  'run',
  'execute_command',
  'run_command',
  'powershell',
]);

interface ToolStats {
  read: number;
  edit: number;
  search: number;
  shell: number;
  browser: number;
  other: number;
  total: number;
}

function computeStats(events: AgentProgressEventWithMeta[]): ToolStats {
  const stats: ToolStats = { read: 0, edit: 0, search: 0, shell: 0, browser: 0, other: 0, total: 0 };
  for (const e of events) {
    if (e.type !== 'tool_result' || !e.toolName) continue;
    const name = e.toolName.toLowerCase();
    stats.total++;
    if (READ_TOOLS.has(name)) stats.read++;
    else if (EDIT_TOOLS.has(name)) stats.edit++;
    else if (SEARCH_TOOLS.has(name)) stats.search++;
    else if (SHELL_TOOLS.has(name)) stats.shell++;
    else if (name.startsWith('browser_') || name.startsWith('browser-') || name === 'browser') stats.browser++;
    else stats.other++;
  }
  return stats;
}

function getPrefixColor(prefix: string): string | undefined {
  const lower = prefix.toLowerCase();
  if (lower.includes('explore')) return '#3b82f6';
  if (lower.includes('code') || lower.includes('coding')) return 'var(--foreground)';
  if (lower.includes('plan')) return '#eab308';
  if (lower.includes('research')) return '#a855f7';
  return undefined;
}

function getToolVerb(toolName?: string): string {
  if (!toolName) return '运行工具';
  const name = toolName.toLowerCase();
  if (READ_TOOLS.has(name)) return '读取文件';
  if (EDIT_TOOLS.has(name)) return '编辑文件';
  if (SEARCH_TOOLS.has(name)) return '搜索';
  if (SHELL_TOOLS.has(name)) return '执行命令';
  if (name.startsWith('browser_') || name.startsWith('browser-') || name === 'browser') return '浏览网页';
  if (name === 'task') return '操作任务';
  if (name === 'memory') return '更新记忆';
  if (name === 'askuserquestion') return '询问用户';
  if (name === 'duya_cli' || name === 'duya-cli' || name === 'duyacli') return '运行 CLI';
  if (name === 'agent' || name === 'subagent' || name === 'sub_agent') return '运行子代理';
  if (name.startsWith('canvas_')) return '操作画布';
  return '运行工具';
}

function getLivePhrase(latest: AgentProgressEventWithMeta | undefined): string | null {
  if (!latest) return null;
  switch (latest.type) {
    case 'started':
      return '启动中...';
    case 'thinking':
      return '思考中...';
    case 'tool_use':
      return `正在${getToolVerb(latest.toolName)}...`;
    case 'tool_result':
      return `完成${getToolVerb(latest.toolName)}`;
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

  const live = getLivePhrase(latest);
  const statsPhrase = buildStatsPhrase(stats);
  if (live && statsPhrase) return `${live} · ${statsPhrase}`;
  if (live) return live;
  if (statsPhrase) return statsPhrase;
  return '初始化中...';
}

export function SubAgentToolRow({ tool, agentProgressEvents }: SubAgentToolRowProps) {
  const renderer = getRenderer(tool.name);
  const summary = renderer.getSummary(tool.input, tool.name);
  const parsedResult = useMemo(() => parseSubAgentToolResult(tool.result), [tool.result]);
  const isError = tool.isError || !!parsedResult?.error;
  const isRunning = tool.result === undefined;

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

  // Filter events for this sub-agent. While running (no parsedResult yet),
  // we cannot filter by sessionId/agentId because the tool result hasn't
  // arrived. Fall back to matching by agentType + description from the
  // tool input so multiple concurrent sub-agents don't cross-wire.
  const toolInput = tool.input as Record<string, unknown> | undefined;
  const inputDescription = typeof toolInput?.description === 'string' ? toolInput.description : '';
  const inputName = typeof toolInput?.name === 'string' ? toolInput.name : '';
  const inputSubagentType = typeof toolInput?.subagent_type === 'string' ? toolInput.subagent_type : '';

  const subAgentEvents = useMemo(() => {
    const events = mergedEvents;
    if (events.length === 0) return events;

    // Once we have the result, filter by sessionId/agentId precisely.
    const sessionId = parsedResult?.sessionId;
    if (sessionId) {
      const filtered = events.filter((event) => event.sessionId === sessionId);
      if (filtered.length > 0) return filtered;
    }
    const agentId = parsedResult?.agentId || parsedResult?.taskId;
    if (agentId) {
      const filtered = events.filter((event) => event.agentId === agentId);
      if (filtered.length > 0) return filtered;
    }

    // Running: match by agentType + description/name so concurrent
    // sub-agents with different types don't get mixed up. If only one
    // sub-agent is running, fall through to all events.
    const desc = inputDescription || inputName;
    if (desc) {
      const byDesc = events.filter((event) => {
        const eventDesc = event.agentDescription || event.agentName || '';
        return eventDesc === desc;
      });
      if (byDesc.length > 0) return byDesc;
    }
    if (inputSubagentType) {
      const byType = events.filter((event) => {
        const eventType = event.agentType || '';
        return eventType.toLowerCase().includes(inputSubagentType.toLowerCase());
      });
      if (byType.length > 0) return byType;
    }

    // Single sub-agent — use all events.
    return events;
  }, [mergedEvents, parsedResult?.sessionId, parsedResult?.agentId, parsedResult?.taskId, inputDescription, inputName, inputSubagentType]);

  const latestEvent = subAgentEvents[subAgentEvents.length - 1];
  const metaEvent = useMemo(
    () => [...subAgentEvents].reverse().find((e) => e.agentType || e.agentName || e.agentDescription),
    [subAgentEvents],
  );

  const targetSessionId = parsedResult?.sessionId
    || subAgentEvents.find((e) => e.sessionId)?.sessionId;

  const stats = useMemo(() => computeStats(subAgentEvents), [subAgentEvents]);

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

  const statusPhrase = buildStatusPhrase(latestEvent, isRunning, isError, stats);
  const prefixColor = getPrefixColor(prefix);

  const handleClick = () => {
    if (!targetSessionId) return;
    useConversationStore.getState().setActiveThread(targetSessionId);
  };

  const status = isRunning ? 'running' : isError ? 'error' : 'success';

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
