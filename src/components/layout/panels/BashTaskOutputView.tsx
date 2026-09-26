// src/components/layout/panels/BashTaskOutputView.tsx
// Read-only viewer for a background bash task's output, rendered inside the
// terminal panel page when the tab carries a `taskId` param (instead of
// spawning an interactive PTY). Mirrors ZCode's BackgroundBashOutputSidePane:
// status bar + tail preview + follow/pause-on-scroll-up + jump-to-bottom,
// with a link out to the full output file in the preview panel.

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowBendDownRightIcon,
  CheckIcon,
  SpinnerIcon,
  StopIcon,
  TerminalIcon,
  WarningIcon,
} from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import { useBashTaskOutput } from '@/hooks/useBashTaskOutput';
import { useBashTasks } from '@/hooks/useBashTasks';
import type { BashBackgroundTaskSnapshot } from '@/types';
import type { PageTab } from './registry';

const FOLLOW_BOTTOM_EPSILON_PX = 8;

export function bashTaskOutputTabTitle(command: string): string {
  const oneLine = command.replace(/\s+/g, ' ').trim();
  return oneLine.length > 32 ? `${oneLine.slice(0, 32)}…` : oneLine || 'Background command';
}

interface BashTaskOutputViewProps {
  tab: PageTab;
}

export function BashTaskOutputView({ tab }: BashTaskOutputViewProps) {
  const { t } = useTranslation();
  const taskId = typeof tab.params?.taskId === 'string' ? tab.params.taskId : '';
  const sessionId = typeof tab.params?.sessionId === 'string' ? tab.params.sessionId : '';
  const outputFile = typeof tab.params?.outputFile === 'string' ? tab.params.outputFile : '';
  const command = typeof tab.params?.command === 'string' ? tab.params.command : '';

  // Live status comes from the same snapshot stream the TaskDrawer uses.
  // The tab outlives registry cleanup (~5 min after completion), so a
  // vanished task falls back to its params snapshot and polling stops.
  const { tasks } = useBashTasks(sessionId || null);
  const task: BashBackgroundTaskSnapshot | null = useMemo(() => {
    const live = tasks.find((t) => t.id === taskId);
    if (live) return live;
    if (!taskId || !outputFile) return null;
    return {
      id: taskId,
      pid: 0,
      outputFile,
      command,
      status: 'completed',
      startTime: typeof tab.params?.startTime === 'number' ? tab.params.startTime : Date.now(),
    };
  }, [command, outputFile, tab.params, taskId, tasks]);

  const { output, error, following, loading, pause, resume, refresh } = useBashTaskOutput(task);

  const scrollRef = useRef<HTMLDivElement>(null);
  const previousTopRef = useRef(0);

  // Follow: pin to the bottom on every new output while the reader hasn't
  // scrolled away. Pausing is driven by the onScroll handler below.
  useEffect(() => {
    if (!following || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    previousTopRef.current = scrollRef.current.scrollTop;
  }, [following, output]);

  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const el = event.currentTarget;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_BOTTOM_EPSILON_PX;
      if (following && el.scrollTop < previousTopRef.current && !atBottom) {
        pause();
      } else if (!following && atBottom) {
        resume();
      }
      previousTopRef.current = el.scrollTop;
    },
    [following, pause, resume],
  );

  const openFullFile = useCallback(() => {
    if (!outputFile) return;
    window.dispatchEvent(
      new CustomEvent('duya:open-file-preview-panel', {
        detail: { filePath: outputFile, standalone: true },
      }),
    );
  }, [outputFile]);

  const status = task?.status ?? 'completed';
  const isRunning = status === 'running';

  return (
    <div className="terminal-panel bash-task-output" data-status={status} data-following={following}>
      <div className="terminal-panel-toolbar">
        <span className="terminal-panel-status" data-status={status}>
          <span
            aria-label={`Status: ${status}`}
            className="bash-task-output-status-icon"
          >
            {isRunning ? (
              <SpinnerIcon size={12} className="text-accent animate-spin" />
            ) : status === 'completed' ? (
              <CheckIcon size={12} className="text-green-500" />
            ) : (
              <WarningIcon size={12} className="text-red-500" />
            )}
          </span>
          <span>{t(`bashTaskOutput.status.${status}` as never)}</span>
          <span className="terminal-panel-status-sep">·</span>
          <span className="terminal-panel-cwd" title={command}>
            <TerminalIcon size={11} className="inline-block mr-1 opacity-60" />
            {bashTaskOutputTabTitle(command)}
          </span>
        </span>
        {outputFile && (
          <button
            type="button"
            className="bash-task-output-fullfile"
            title={outputFile}
            onClick={openFullFile}
          >
            {t('bashTaskOutput.fullFile')}
          </button>
        )}
      </div>

      {error && (
        <div role="alert" className="bash-task-output-error">
          <StopIcon size={12} className="text-red-500" />
          <span>{t('bashTaskOutput.readError', { error })}</span>
          <button type="button" onClick={refresh}>
            {t('bashTaskOutput.retry')}
          </button>
        </div>
      )}

      <div
        ref={scrollRef}
        className="bash-task-output-scroll"
        data-testid="bash-task-output-scroll"
        tabIndex={0}
        onScroll={handleScroll}
      >
        <pre data-testid="bash-task-output" className="bash-task-output-pre">
          {loading ? '' : output || t('bashTaskOutput.empty')}
        </pre>
      </div>

      {!following && (
        <button
          type="button"
          className="bash-task-output-jump"
          data-testid="bash-task-output-jump"
          aria-label={t('bashTaskOutput.jumpToBottom')}
          title={t('bashTaskOutput.jumpToBottom')}
          onClick={resume}
        >
          <ArrowBendDownRightIcon size={14} />
        </button>
      )}
    </div>
  );
}
