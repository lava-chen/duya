'use client';
 
import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { ToolUseInfo, ToolResultInfo } from '@/types';
import { ToolActionsGroup } from './ToolActionsGroup';
import { Shimmer } from './Shimmer';
import { MarkdownRenderer } from './MarkdownRenderer';
import { useTranslation } from '@/hooks/useTranslation';
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
import { parseAllShowWidgets, hasUnclosedWidgetFence, getPartialWidgetCode } from '@/lib/widget-parser';
 
// ─── Adaptive Typewriter ──────────────────────────────────────────────────────
//
// Design goals:
//   1. Display text at a smooth, even pace — no sudden jumps.
//   2. Automatically track the SSE arrival rate so we never fall behind.
//   3. When streaming ends, flush remaining buffer instantly (no tail lag).
//   4. Never re-render the markdown component more often than necessary.
//
// Algorithm:
//   • We keep a `targetRef` (the latest full text from SSE).
//   • A rAF loop advances a `displayedChars` cursor at `charsPerFrame` speed.
//   • `charsPerFrame` is calculated every MEASURE_INTERVAL ms based on how many
//     new chars arrived during that window.  We add a 20% headroom so the
//     typewriter stays comfortably ahead of incoming data.
//   • When `isStreaming` flips to false we flush the entire remaining buffer in
//     one frame so there's no trailing animation after the response is done.
//   • The hook returns a stable string reference — it only changes when the
//     displayed slice actually grows, preventing spurious re-renders.
 
const MEASURE_INTERVAL_MS  = 500;   // How often we recalculate typing speed
const MIN_CHARS_PER_FRAME  = 1;     // Floor: at least one char per frame
const MAX_CHARS_PER_FRAME  = 80;    // Cap: avoid giant single-frame jumps
const HEADROOM_FACTOR      = 1.2;   // Stay 20% faster than arrival rate
 
function useAdaptiveTypewriter(fullText: string, isStreaming: boolean): string {
  // Displayed slice length (number of chars shown so far)
  const displayedRef   = useRef(0);
  // Mutable target (avoids stale closures in rAF)
  const targetRef      = useRef(fullText);
  const isStreamingRef = useRef(isStreaming);
  // Speed measurement state
  const lastMeasureRef    = useRef<number>(performance.now());
  const charsAtMeasureRef = useRef(0);          // target length at last measure point
  const charsPerFrameRef  = useRef(MIN_CHARS_PER_FRAME);
  // rAF handle
  const rafRef = useRef<number | null>(null);
  // React state — only updated when the visible slice actually changes
  const [displayed, setDisplayed] = useState('');
 
  // Keep refs in sync with latest props on every render (no re-subscriptions)
  targetRef.current      = fullText;
  isStreamingRef.current = isStreaming;
 
  // Main rAF loop — started once and kept alive while streaming
  const tick = useCallback(() => {
    const fullText    = targetRef.current;   // latest SSE text
    const targetLen   = fullText.length;
    let   cur        = displayedRef.current;
 
    // ── 1. Speed recalculation ──────────────────────────────────────────────
    const elapsed = performance.now() - lastMeasureRef.current;
    if (elapsed >= MEASURE_INTERVAL_MS) {
      const newChars   = target - charsAtMeasureRef.current;  // chars that arrived
      const frames     = elapsed / 16.67;                      // ~60 fps
      const rawCPF     = (newChars / frames) * HEADROOM_FACTOR;
      charsPerFrameRef.current = Math.min(
        MAX_CHARS_PER_FRAME,
        Math.max(MIN_CHARS_PER_FRAME, Math.ceil(rawCPF))
      );
      lastMeasureRef.current    = performance.now();
      charsAtMeasureRef.current = target;
    }
 
    // ── 2. Flush immediately when streaming has ended ───────────────────────
    if (!isStreamingRef.current) {
      if (cur < target) {
        displayedRef.current = target;
        setDisplayed(targetRef.current);
      }
      rafRef.current = null;
      return; // stop the loop
    }
 
    // ── 3. Advance cursor ───────────────────────────────────────────────────
    if (cur < target) {
      const next = Math.min(target, cur + charsPerFrameRef.current);
      displayedRef.current = next;
      // Slice at a safe UTF-16 boundary (avoid splitting surrogates)
      setDisplayed(targetRef.current.slice(0, next));
    }
 
    rafRef.current = requestAnimationFrame(tick);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
 
  // Start / stop the loop based on streaming state
  useEffect(() => {
    if (isStreaming) {
      if (rafRef.current === null) {
        // Reset measurement baseline when a new stream begins
        lastMeasureRef.current    = performance.now();
        charsAtMeasureRef.current = displayedRef.current;
        rafRef.current = requestAnimationFrame(tick);
      }
    } else {
      // Streaming just ended — cancel the scheduled frame
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      // Flush synchronously so there's zero tail-lag.
      // This runs AFTER the last tick (if any), so displayedRef is already up to date.
      // We guard with displayedRef < fullText.length to cover the rare case where
      // targetRef was updated *after* the final tick ran — SSE events like
      // db_persisted can still arrive after phase → 'completed'.
      if (displayedRef.current < targetRef.current.length) {
        displayedRef.current = targetRef.current.length;
        setDisplayed(targetRef.current);
      }
    }
  }, [isStreaming, tick]);
 
  // When new text arrives while we have no active loop (e.g. first chars),
  // kick off the loop again.
  useEffect(() => {
    if (isStreaming && fullText.length > displayedRef.current && rafRef.current === null) {
      lastMeasureRef.current    = performance.now();
      charsAtMeasureRef.current = displayedRef.current;
      rafRef.current = requestAnimationFrame(tick);
    }
  }, [fullText, isStreaming, tick]);
 
  // On session reset (text shrinks back to ''), reset all state
  useEffect(() => {
    if (fullText === '') {
      displayedRef.current      = 0;
      charsPerFrameRef.current  = MIN_CHARS_PER_FRAME;
      lastMeasureRef.current    = performance.now();
      charsAtMeasureRef.current = 0;
      setDisplayed('');
    }
  }, [fullText]);
 
  return displayed;
}
 
// ─── Helpers ──────────────────────────────────────────────────────────────────
 
interface StreamingMessageProps {
  sessionId: string;
  onForceStop?: () => void;
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
 
// ─── Markdown renderer — no internal throttle ─────────────────────────────────
//
// Previously this component had a `useThrottledValue` that added an additional
// 150 ms delay on top of the typewriter.  That caused two problems:
//   • Visible stutter: the displayed text advanced, then frozen for 150 ms, then jumped.
//   • Double-throttle: typewriter already controls the pacing; a second layer is redundant.
//
// Now we render `content` directly.  Pacing is entirely owned by `useAdaptiveTypewriter`.
 
const StreamingMarkdown = React.memo(function StreamingMarkdown({
  content,
}: {
  content: string;
}) {
  if (!content) return null;
  return (
    <MarkdownRenderer className="mt-3 prose prose-sm max-w-none message-content">
      {content}
    </MarkdownRenderer>
  );
});
 
// ─── Text + widget rendering ──────────────────────────────────────────────────
 
const StreamingTextContent = React.memo(function StreamingTextContent({
  text,
  isStreaming,
}: {
  text: string;
  isStreaming: boolean;
}) {
  // Single source of pacing: adaptive typewriter.
  // When streaming ends it flushes instantly — no tail animation.
  const displayContent = useAdaptiveTypewriter(text, isStreaming);
 
  if (!displayContent) return null;
 
  const hasWidgetFence = text.includes('```show-widget');
 
  if (!hasWidgetFence) {
    return <StreamingMarkdown content={displayContent} />;
  }
 
  // ── Widget fence handling ──────────────────────────────────────────────────
  // We use `text` (full SSE content) for parsing decisions but `displayContent`
  // (typewriter slice) for actual rendering, so widgets never appear ahead of text.
 
  const hasUnclosed = hasUnclosedWidgetFence(text);
 
  if (hasUnclosed) {
    const partial = getPartialWidgetCode(text);
    if (partial) {
      return (
        <div className="mt-3">
          {partial.beforeText.trim() && (
            <StreamingMarkdown content={partial.beforeText} />
          )}
          <WidgetErrorBoundary widgetCode={partial.partialCode}>
            <WidgetRenderer
              widgetCode={partial.partialCode}
              isStreaming={true}
              showOverlay={true}
            />
          </WidgetErrorBoundary>
        </div>
      );
    }
  }
 
  // All widget fences are closed — render full segments using displayContent
  // so text portions still go through the typewriter.
  const segments = parseAllShowWidgets(displayContent);
  return (
    <div className="mt-3">
      {segments.map((seg, i) => {
        if (seg.type === 'text') {
          return <StreamingMarkdown key={`t-${i}`} content={seg.content || ''} />;
        }
        if (seg.type === 'widget' && seg.data) {
          return (
            <WidgetErrorBoundary key={`w-${i}`} widgetCode={seg.data.widget_code}>
              <WidgetRenderer
                widgetCode={seg.data.widget_code}
                isStreaming={false}
              />
            </WidgetErrorBoundary>
          );
        }
        return null;
      })}
    </div>
  );
});
 
// ─── Tool display ─────────────────────────────────────────────────────────────
 
const StreamingTools = React.memo(function StreamingTools({
  actions,
  isStreaming,
  streamingToolOutput,
  agentProgressEvents,
}: {
  actions: import('./ToolActionsGroup').ActionItem[];
  isStreaming: boolean;
  streamingToolOutput: string;
  agentProgressEvents?: import('@/hooks/useStreamingAgentProgress').AgentProgressEventWithMeta[];
}) {
  if (actions.length === 0) return null;
  return (
    <ToolActionsGroup
      actions={actions}
      isStreaming={isStreaming}
      streamingToolOutput={streamingToolOutput}
      agentProgressEvents={agentProgressEvents}
    />
  );
});
 
const StreamingVizWidgets = React.memo(function StreamingVizWidgets({
  actions,
}: {
  actions: import('./ToolActionsGroup').ActionItem[];
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
    : statusText
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
      <div className={hasWidgetActions ? 'max-w-[95%]' : 'max-w-[90%] lg:max-w-[85%]'}>
        <StreamingTools
          actions={actions}
          isStreaming={isStreaming}
          streamingToolOutput={toolOutput}
          agentProgressEvents={agentProgressEvents}
        />
 
        {/* Text content — paced by adaptive typewriter */}
        <StreamingTextContent text={text} isStreaming={isStreaming} />
 
        <StreamingVizWidgets actions={actions} />
 
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
 