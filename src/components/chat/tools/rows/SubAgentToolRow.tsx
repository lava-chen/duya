// SubAgentToolRow — handles `agent` / `subagent` / `sub_agent` and the
// legacy `task` alias. The collapsed chrome shows tool count + pending
// tool count in the right slot; the expanded body renders a step list
// reconstructed from the agent's progress event stream (started →
// thinking → tool_use → tool_result → done). When the result payload
// arrives we synthesize a synthetic "Background agent launched" /
// "Completed" / "Failed" step if no events streamed in.

'use client';

import React, { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import { ActionRowChrome } from '../chrome/ActionRowChrome';
import { getRenderer, getStatus } from '../registry';
import { parseSubAgentToolResult } from '@/lib/subagent-result';
import type { AgentProgressEventWithMeta } from '@/hooks/useStreamingAgentProgress';
import type { ToolAction, ToolStatus } from '../types';

interface SubAgentToolRowProps {
  tool: ToolAction;
  agentProgressEvents?: AgentProgressEventWithMeta[];
}

export function SubAgentToolRow({ tool, agentProgressEvents }: SubAgentToolRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const renderer = getRenderer(tool.name);
  const summary = renderer.getSummary(tool.input, tool.name);
  const parsedResult = useMemo(() => parseSubAgentToolResult(tool.result), [tool.result]);
  const displayResult = parsedResult?.error || parsedResult?.content || tool.result;
  const isError = tool.isError || !!parsedResult?.error;
  const status: ToolStatus = tool.result === undefined ? 'running' : isError ? 'error' : 'success';
  const isRunning = status === 'running';

  // Filter events for this sub-agent
  const subAgentEvents = useMemo(() => {
    const events = agentProgressEvents || [];
    const sessionId = parsedResult?.sessionId;
    if (sessionId) {
      const filteredBySession = events.filter((event) => event.sessionId === sessionId);
      if (filteredBySession.length > 0) return filteredBySession;
    }
    const agentId = parsedResult?.agentId || parsedResult?.taskId;
    if (agentId) {
      const filteredByTask = events.filter((event) => event.agentId === agentId);
      if (filteredByTask.length > 0) return filteredByTask;
    }
    return events;
  }, [agentProgressEvents, parsedResult?.sessionId, parsedResult?.agentId, parsedResult?.taskId]);
  const toolUseCount = subAgentEvents.filter((e) => e.type === 'tool_use').length;
  const toolResultCount = subAgentEvents.filter((e) => e.type === 'tool_result').length;
  const unresolvedTools = Math.max(0, toolUseCount - toolResultCount);
  const latestEvent = subAgentEvents[subAgentEvents.length - 1];
  const liveStatusText = (() => {
    if (!latestEvent) return null;
    if (latestEvent.type === 'started') return 'Started';
    if (latestEvent.type === 'thinking') return latestEvent.data || 'Thinking';
    if (latestEvent.type === 'tool_use') return `Running ${latestEvent.toolName || 'tool'}`;
    if (latestEvent.type === 'tool_result') return `Finished ${latestEvent.toolName || 'tool'}`;
    if (latestEvent.type === 'text') return latestEvent.data || 'Writing';
    if (latestEvent.type === 'done') return 'Completed';
    if (latestEvent.type === 'error') return 'Failed';
    return null;
  })();

  // Build progress steps from events
  const steps = useMemo(() => {
    const result: Array<{ type: string; title: string; status: 'running' | 'done' | 'error' }> = [];
    for (const event of subAgentEvents) {
      if (event.type === 'started') {
        result.push({ type: 'started', title: 'Started', status: 'running' });
      } else if (event.type === 'thinking') {
        const started = result.find((s) => s.type === 'started' && s.status === 'running');
        if (started) started.status = 'done';
        result.push({ type: 'thinking', title: 'Thinking', status: 'done' });
      } else if (event.type === 'tool_use') {
        const started = result.find((s) => s.type === 'started' && s.status === 'running');
        if (started) started.status = 'done';
        result.push({ type: 'tool', title: `Run ${event.toolName || 'Tool'}`, status: 'running' });
      } else if (event.type === 'tool_result') {
        // Mark last running tool as done
        const lastTool = result.filter((s) => s.type === 'tool').pop();
        if (lastTool) lastTool.status = 'done';
      } else if (event.type === 'done') {
        // Mark all running as done
        result.forEach((s) => { if (s.status === 'running') s.status = 'done'; });
      } else if (event.type === 'error') {
        result.push({ type: 'error', title: 'Failed', status: 'error' });
      }
    }
    if (tool.result !== undefined) {
      result.forEach((step) => {
        if (step.status === 'running') step.status = isError ? 'error' : 'done';
      });
      if (result.length === 0) {
        result.push({
          type: isError ? 'error' : 'done',
          title: parsedResult?.background ? 'Background agent launched' : isError ? 'Failed' : 'Completed',
          status: isError ? 'error' : 'done',
        });
      }
    }
    return result;
  }, [isError, parsedResult?.background, subAgentEvents, tool.result]);

  // Right-slot tail: tool count + pending count live between the
  // summary and the duration so the chrome's verb + summary + status
  // dot remain in their expected positions.
  const subagentRightSlot = (
    <>
      {toolUseCount > 0 && (
        <span className="text-muted-foreground/60 text-[10px]">({toolUseCount} tools)</span>
      )}
      {unresolvedTools > 0 && (
        <span className="text-amber-500 text-[10px]">{unresolvedTools} pending</span>
      )}
    </>
  );

  const verbKey =
    status === 'running' ? 'streaming.toolAction.running.agent'
    : status === 'error' ? 'streaming.toolAction.error.agent'
    : 'streaming.toolAction.done.agent';

  return (
    <div>
      <ActionRowChrome
        status={status}
        verbKey={verbKey}
        canExpand
        expanded={expanded}
        hovered={hovered}
        durationMs={tool.durationMs}
        onClick={() => setExpanded((prev) => !prev)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        rightSlot={subagentRightSlot}
      >
        {summary}
      </ActionRowChrome>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div className="ml-4 mt-1 border-l-2 border-border/30 pl-3 py-2">
              {steps.length === 0 ? (
                <div className="text-[11px] text-muted-foreground/60">
                  {liveStatusText || (isRunning ? 'Initializing...' : 'Completed')}
                </div>
              ) : (
                <div className="space-y-1">
                  {steps.map((step, index) => (
                    <div key={index} className="flex items-center gap-2 text-[11px]">
                      <span className="text-muted-foreground/50">#{index + 1}</span>
                      <span
                        className={`inline-block h-1.5 w-1.5 rounded-full ${
                          step.status === 'running'
                            ? 'bg-amber-500 animate-pulse'
                            : step.status === 'error'
                            ? 'bg-red-500'
                            : 'bg-emerald-500'
                        }`}
                      />
                      <span className="text-muted-foreground/80">{step.title}</span>
                    </div>
                  ))}
                </div>
              )}
              {(parsedResult?.resolvedAgentType || parsedResult?.sessionId) && (
                <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] tool-card-faint">
                  {(parsedResult?.resolvedAgentType || parsedResult?.agentType) && (
                    <span className="rounded-full border border-tool-card-divider px-2 py-0.5" style={{ borderColor: 'var(--tool-card-divider)' }}>
                      {parsedResult?.resolvedAgentType || parsedResult?.agentType}
                    </span>
                  )}
                  {parsedResult?.sessionId && (
                    <span className="rounded-full border border-tool-card-divider px-2 py-0.5 font-mono" style={{ borderColor: 'var(--tool-card-divider)' }}>
                      {parsedResult.sessionId.slice(0, 8)}
                    </span>
                  )}
                </div>
              )}
              {displayResult && (
                <div className="mt-2 rounded-md tool-card p-2">
                  <MarkdownRenderer className="prose prose-sm dark:prose-invert max-w-none message-content max-h-[160px] overflow-y-auto pr-1 text-[12px] tool-card-subtle">
                    {displayResult}
                  </MarkdownRenderer>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
