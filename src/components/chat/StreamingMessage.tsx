'use client';

import React, { useState, useEffect, useRef } from 'react';
import type { ToolUseInfo, ToolResultInfo } from '@/types';
import { ToolActionsGroup, pairTools } from './ToolActionsGroup';
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
import { WidgetRenderer } from './WidgetRenderer';
import { WidgetErrorBoundary } from './WidgetErrorBoundary';
import { parseAllShowWidgets, hasUnclosedWidgetFence, getPartialWidgetCode } from '@/lib/widget-parser';

interface StreamingMessageProps {
  sessionId: string;
  onForceStop?: () => void;
}

const BUFFER_WORD_THRESHOLD = 40;
const BUFFER_MAX_MS = 2500;

function useBufferedContent(rawContent: string, isStreaming: boolean): string {
  const [bypassed, setBypassed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const shouldBypass = !isStreaming || bypassed ||
    (rawContent.split(/\s+/).filter(Boolean).length >= BUFFER_WORD_THRESHOLD);

  useEffect(() => {
    if (shouldBypass && !bypassed && isStreaming && rawContent) {
      setBypassed(true);
    }
  }, [shouldBypass, bypassed, isStreaming, rawContent]);

  useEffect(() => {
    if (!rawContent && !isStreaming) {
      setBypassed(false);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }
  }, [rawContent, isStreaming]);

  const hasContent = !!rawContent;
  useEffect(() => {
    if (!isStreaming || bypassed || !hasContent) return;
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      setBypassed(true);
      timerRef.current = null;
    }, BUFFER_MAX_MS);
  }, [isStreaming, bypassed, hasContent]);

  if (!isStreaming) return rawContent;
  if (shouldBypass) return rawContent;
  return '';
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

    const updateElapsed = () => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    };

    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);
    return () => clearInterval(interval);
  }, [startedAt]);

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;

  return (
    <span className="tabular-nums">
      {mins > 0 ? `${mins}m ${secs}s` : `${secs}s`}
    </span>
  );
}

function StreamingStatusBar({ statusText, startedAt, onForceStop }: { statusText?: string; startedAt: number | null; onForceStop?: () => void }) {
  const { t } = useTranslation();
  const displayText = statusText || 'Thinking';

  const elapsedMatch = statusText?.match(/\((\d+)s\)/);
  const toolElapsed = elapsedMatch ? parseInt(elapsedMatch[1], 10) : 0;
  const isWarning = toolElapsed >= 60;
  const isCritical = toolElapsed >= 90;

  return (
    <div className="flex items-center gap-3 py-2 px-1 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <span className={isCritical ? 'text-red-500' : isWarning ? 'text-amber-500' : undefined}>
          <Shimmer duration={1.5}>{displayText}</Shimmer>
        </span>
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

const StreamingTextContent = React.memo(function StreamingTextContent({
  text,
  isStreaming,
}: {
  text: string;
  isStreaming: boolean;
}) {
  const bufferedContent = useBufferedContent(text, isStreaming);

  if (!bufferedContent) return null;

  const hasWidgetFence = bufferedContent.includes('```show-widget');
  if (!hasWidgetFence) {
    return (
      <MarkdownRenderer className="mt-3 prose prose-sm max-w-none message-content">
        {bufferedContent}
      </MarkdownRenderer>
    );
  }

  const hasUnclosed = hasUnclosedWidgetFence(bufferedContent);

  if (hasUnclosed) {
    const partial = getPartialWidgetCode(bufferedContent);
    if (partial) {
      return (
        <div className="mt-3">
          {partial.beforeText.trim() && (
            <MarkdownRenderer className="prose prose-sm max-w-none message-content">
              {partial.beforeText}
            </MarkdownRenderer>
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

  const segments = parseAllShowWidgets(bufferedContent);
  return (
    <div className="mt-3">
      {segments.map((seg, i) => {
        if (seg.type === 'text') {
          return (
            <MarkdownRenderer
              key={`t-${i}`}
              className="prose prose-sm max-w-none message-content"
            >
              {seg.content || ''}
            </MarkdownRenderer>
          );
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

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}



const StreamingTools = React.memo(function StreamingTools({
  actions,
  isStreaming,
  streamingToolOutput,
}: {
  actions: import('./ToolActionsGroup').ActionItem[];
  isStreaming: boolean;
  streamingToolOutput: string;
}) {
  const hasActions = actions.length > 0;

  if (!hasActions) return null;

  return (
    <ToolActionsGroup
      actions={actions}
      isStreaming={isStreaming}
      streamingToolOutput={streamingToolOutput}
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
    const runningTools = toolUses.filter(
      (tool) => !toolResults.some((r) => r.tool_use_id === tool.id)
    );
    if (runningTools.length === 0) {
      if (toolUses.length > 0) return 'Generating response...';
      return undefined;
    }
    const tool = runningTools[runningTools.length - 1];
    const input = tool.input as Record<string, unknown>;
    if (tool.name === 'Bash' && input.command) {
      const cmd = String(input.command);
      return cmd.length > 80 ? cmd.slice(0, 80) + '...' : cmd;
    }
    if (input.file_path) return `${tool.name}: ${String(input.file_path)}`;
    if (input.path) return `${tool.name}: ${String(input.path)}`;
    return `Running ${tool.name}...`;
  };

  // Show retry status if retry is in progress
  const displayStatus = retryInfo
    ? `Retrying... (${retryInfo.attempt}/${retryInfo.maxAttempts})`
    : statusText
      || getRunningCommandSummary()
      || (content && content.length > 0 ? t('streaming.generating') : undefined);

  return (
    <StreamingStatusBar
      statusText={displayStatus}
      startedAt={startedAt}
      onForceStop={onForceStop}
    />
  );
});

export const StreamingMessage = React.memo(function StreamingMessage({
  sessionId,
  onForceStop,
}: StreamingMessageProps) {
  const phase = useStreamPhase(sessionId);
  const isStreaming = phase === 'starting' || phase === 'streaming' || phase === 'awaiting_permission' || phase === 'persisting';

  const text = useStreamingText(sessionId);
  const thinking = useStreamingThinking(sessionId);
  const { uses, results } = useStreamingTools(sessionId);
  const actions = useStreamingActions(sessionId);
  const statusText = useStreamingStatusText(sessionId);
  const toolOutput = useStreamingToolOutput(sessionId);
  const retryInfo = useStreamingRetry(sessionId);
  const startedAt = useStreamStartedAt(sessionId);

  const hasWidgetActions = actions.some(a => a.kind === 'widget');

  return (
    <div className="py-4 px-4">
      <div className={hasWidgetActions ? 'max-w-[95%]' : 'max-w-[90%] lg:max-w-[85%]'}>
        <StreamingTools
          actions={actions}
          isStreaming={isStreaming}
          streamingToolOutput={toolOutput}
        />

        {isStreaming && <StreamingTextContent text={text} isStreaming={isStreaming} />}

        {isStreaming && <StreamingVizWidgets actions={actions} />}

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
