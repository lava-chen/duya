'use client';
 
import React, { useState, useEffect } from 'react';
import type { ToolUseInfo, ToolResultInfo } from '@/types';
import { ToolActionsGroup } from './ToolActionsGroup';
import { Shimmer } from './Shimmer';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import { useStreamingText } from '@/hooks/useStreamingText';
import { useStreamingThinking } from '@/hooks/useStreamingThinking';
import { useStreamingTools } from '@/hooks/useStreamingTools';
import { useStreamingStatusText } from '@/hooks/useStreamingStatusText';
import { useStreamingToolOutput } from '@/hooks/useStreamingToolOutput';
import { useStreamingRetry } from '@/hooks/useStreamingRetry';
import { useStreamingActions } from '@/hooks/useStreamingActions';
import { useStreamPhase } from '@/hooks/useStreamPhase';
import { useStreamStartedAt } from '@/hooks/useStreamStartedAt';
import { useStreamingAgentProgress } from '@/hooks/useStreamingAgentProgress';
import { WidgetRenderer } from './WidgetRenderer';
import { WidgetErrorBoundary } from './WidgetErrorBoundary';
 
// ─── Adaptive Typewriter — moved to src/hooks/useAdaptiveTypewriter.ts ──────
//
// The hook is reused by TextRow in ToolActionsGroup so per-block text
// segments can pace themselves in step with the SSE arrival rate. The
// original implementation in this file was extracted verbatim to keep
// the streaming feel consistent with the previous cumulative-text view.
//
// Design goals:
//   1. Display text at a smooth, even pace — no sudden jumps.
//   2. Automatically track the SSE arrival rate so we never fall behind.
//   3. When streaming ends, flush remaining buffer instantly (no tail lag).
//   4. Never re-render the markdown component more often than necessary.
//
// (See the hook file for the full algorithm and comments.)
 
// ─── Helpers ──────────────────────────────────────────────────────────────────
 
interface StreamingMessageProps {
  sessionId: string;
  onForceStop?: () => void;
}

function resolveI18nStatusText(
  raw: string | undefined,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string | undefined {
  if (!raw) return raw;
  if (!raw.startsWith('@i18n:')) return raw;

  const payload = raw.slice('@i18n:'.length);
  const [key, ...paramParts] = payload.split('|');
  if (!key) return raw;

  const params: Record<string, string | number> = {};
  for (const part of paramParts) {
    const [k, ...rest] = part.split('=');
    if (!k || rest.length === 0) continue;
    const val = decodeURIComponent(rest.join('='));
    const num = Number(val);
    params[k] = Number.isFinite(num) && val.trim() !== '' ? num : val;
  }

  return t(key as TranslationKey, Object.keys(params).length > 0 ? params : undefined);
}
 
function ThinkingPhaseLabel() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState(0);
 
  useEffect(() => {
    const t1 = setTimeout(() => setPhase(1), 5000);
    const t2 = setTimeout(() => setPhase(2), 15000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);
 
  const text = phase === 0
    ? t('streaming.thinking')
    : phase === 1
      ? t('streaming.thinkingDeep')
      : t('streaming.preparing');
 
  return <Shimmer>{text}</Shimmer>;
}
 
function ElapsedTimer({ startedAt }: { startedAt: number | null }) {
  const [elapsed, setElapsed] = useState(0);
 
  useEffect(() => {
    if (!startedAt) return;
    const update = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [startedAt]);
 
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return (
    <span className="tabular-nums">
      {mins > 0 ? `${mins}m ${secs}s` : `${secs}s`}
    </span>
  );
}
 
function StreamingStatusBar({
  statusText,
  startedAt,
  onForceStop,
}: {
  statusText?: string;
  startedAt: number | null;
  onForceStop?: () => void;
}) {
  const { t } = useTranslation();
 
  const elapsedMatch = statusText?.match(/\((\d+)s\)/);
  const toolElapsed  = elapsedMatch ? parseInt(elapsedMatch[1], 10) : 0;
  const isWarning    = toolElapsed >= 60;
  const isCritical   = toolElapsed >= 90;
  const displayText  = statusText || 'Thinking';
 
  return (
    <div className="flex items-center gap-3 py-2 px-1 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <span className={isCritical ? 'text-red-500' : isWarning ? 'text-amber-500' : undefined}>
          {displayText}
        </span>
        <span className="inline-block w-2.5 h-2.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
        {isWarning && !isCritical && (
          <span className="text-amber-500 text-[10px]">{t('streaming.runningLonger')}</span>
        )}
        {isCritical && (
          <span className="text-red-500 text-[10px]">{t('streaming.toolMayStuck')}</span>
        )}
      </div>
      <span className="text-muted-foreground/50">|</span>
      <ElapsedTimer startedAt={startedAt} />
      {isCritical && onForceStop && (
        <button
          onClick={onForceStop}
          className="ml-auto px-2 py-0.5 text-[10px] font-medium rounded bg-red-500/10 text-red-500 border border-red-500/20 hover:bg-red-500/20 transition-colors"
        >
          {t('streaming.forceStop')}
        </button>
      )}
    </div>
  );
}
 
// ─── Markdown renderer for streaming messages ──────────────────────────────
//
// Text content used to be rendered by a dedicated StreamingTextContent
// block backed by useStreamingText. Now text events are interleaved with
// tool calls in the actions list, so TextRow inside ToolActionsGroup
// handles the streaming markdown rendering directly. This file no
// longer needs the standalone StreamingMarkdown / StreamingTextContent
// components — keeping the import surface small.
 
// ─── Tool display ─────────────────────────────────────────────────────────────
 
const StreamingTools = React.memo(function StreamingTools({
  actions,
  isStreaming,
  streamingToolOutput,
  agentProgressEvents,
  totalDurationMs,
  liveStartedAt,
}: {
  actions: import('./ToolActionsGroup').ActionItem[];
  isStreaming: boolean;
  streamingToolOutput: string;
  agentProgressEvents?: import('@/hooks/useStreamingAgentProgress').AgentProgressEventWithMeta[];
  /** Live elapsed ms from stream start; lets the summary show the real
   *  response time ticking up instead of summed tool durations. */
  totalDurationMs?: number | null;
  liveStartedAt?: number | null;
}) {
  if (actions.length === 0) return null;
  return (
    <ToolActionsGroup
      actions={actions}
      isStreaming={isStreaming}
      streamingToolOutput={streamingToolOutput}
      agentProgressEvents={agentProgressEvents}
      totalDurationMs={totalDurationMs}
      liveStartedAt={liveStartedAt}
    />
  );
});

const StreamingVizWidgets = React.memo(function StreamingVizWidgets({
  actions,
  sourceMessageId,
}: {
  actions: import('./ToolActionsGroup').ActionItem[];
  sourceMessageId?: string;
}) {
  const widgetActions = actions.filter(a => a.kind === 'widget');
  if (widgetActions.length === 0) return null;
  return (
    <div className="mt-3">
      {widgetActions.map((action, i) => (
        <WidgetErrorBoundary key={`sv-${i}`} widgetCode={action.content}>
          <WidgetRenderer
            widgetCode={action.content}
            isStreaming={true}
            showOverlay={true}
            sourceMessageId={action.sourceMessageId ?? sourceMessageId}
            sourceLabel={action.sourceLabel ?? 'Streaming visualization'}
          />
        </WidgetErrorBoundary>
      ))}
    </div>
  );
});
 
// ─── Status bar ───────────────────────────────────────────────────────────────
 
const StreamingStatus = React.memo(function StreamingStatus({
  statusText,
  startedAt,
  toolUses,
  toolResults,
  content,
  onForceStop,
  retryInfo,
}: {
  statusText?: string;
  startedAt: number | null;
  toolUses: ToolUseInfo[];
  toolResults: ToolResultInfo[];
  content: string;
  onForceStop?: () => void;
  retryInfo?: { attempt: number; maxAttempts: number; delayMs: number; message: string } | null;
}) {
  const { t } = useTranslation();
 
  const getRunningCommandSummary = (): string | undefined => {
    const running = toolUses.filter(
      tool => !toolResults.some(r => r.tool_use_id === tool.id)
    );
    if (running.length === 0) {
      return toolUses.length > 0 ? 'Generating response...' : undefined;
    }
    const tool  = running[running.length - 1];
    const input = tool.input as Record<string, unknown>;
    if (tool.name === 'Bash' && input.command) {
      const cmd = String(input.command);
      return cmd.length > 80 ? cmd.slice(0, 80) + '...' : cmd;
    }
    if (input.file_path) return `${tool.name}: ${String(input.file_path)}`;
    if (input.path)      return `${tool.name}: ${String(input.path)}`;
    return `Running ${tool.name}...`;
  };
 
  const displayStatus = retryInfo
    ? `Retrying... (${retryInfo.attempt}/${retryInfo.maxAttempts})`
    : resolveI18nStatusText(statusText, t)
      || getRunningCommandSummary()
      || (content.length > 0 ? t('streaming.generating') : undefined);
 
  return (
    <StreamingStatusBar
      statusText={displayStatus}
      startedAt={startedAt}
      onForceStop={onForceStop}
    />
  );
});
 
// ─── Main export ──────────────────────────────────────────────────────────────
 
export const StreamingMessage = React.memo(function StreamingMessage({
  sessionId,
  onForceStop,
}: StreamingMessageProps) {
  const phase       = useStreamPhase(sessionId);
  const isStreaming = phase === 'starting' || phase === 'streaming'
    || phase === 'awaiting_permission' || phase === 'persisting';
 
  const text               = useStreamingText(sessionId);
  const thinking           = useStreamingThinking(sessionId);
  const { uses, results }  = useStreamingTools(sessionId);
  const actions            = useStreamingActions(sessionId);
  const statusText         = useStreamingStatusText(sessionId);
  const toolOutput         = useStreamingToolOutput(sessionId);
  const retryInfo          = useStreamingRetry(sessionId);
  const startedAt          = useStreamStartedAt(sessionId);
  const agentProgressEvents = useStreamingAgentProgress(sessionId);

  const hasWidgetActions = actions.some(a => a.kind === 'widget');
 
  return (
    <div data-message-id="streaming" className="py-4 px-4">
      {/* Streaming prose / tool rows track the message-list width so they
          align with the input box and with already-finished messages.
          Widgets get a slightly wider ceiling because viz components
          (charts, tables) are often wider than prose and benefit from
          using more of the chat area. */}
      <div className={hasWidgetActions ? 'max-w-[95%]' : 'w-full'}>
        <StreamingTools
          actions={actions}
          isStreaming={isStreaming}
          streamingToolOutput={toolOutput}
          agentProgressEvents={agentProgressEvents}
          liveStartedAt={startedAt}
        />

        {/* Text is now part of the actions list above (each text event
            becomes a `kind: 'text'` action interleaved with tools). The
            cumulative `text` value from useStreamingText is still kept
            alive so StreamingStatus can show "Generating...". The
            previous separate StreamingTextContent render is removed to
            avoid duplicating the agent's prose below the tool rows. */}

        <StreamingVizWidgets actions={actions} sourceMessageId={sessionId} />
 
        {/* Initial "thinking" shimmer — shown until first tool or text arrives */}
        {isStreaming && !text && uses.length === 0 && !thinking && (
          <div className="py-2">
            <ThinkingPhaseLabel />
          </div>
        )}
 
        {isStreaming && (
          <StreamingStatus
            statusText={statusText}
            startedAt={startedAt}
            toolUses={uses}
            toolResults={results}
            content={text}
            onForceStop={onForceStop}
            retryInfo={retryInfo}
          />
        )}
      </div>
    </div>
  );
});
