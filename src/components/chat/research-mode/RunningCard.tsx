'use client';

import React, { useMemo } from 'react';
import { BrainIcon, XIcon } from '@/components/icons';
import { useStreamPhase } from '@/hooks/useStreamPhase';
import { useStreamingStatusText } from '@/hooks/useStreamingStatusText';
import { useStreamingTools } from '@/hooks/useStreamingTools';
import { useStreamingAgentProgress } from '@/hooks/useStreamingAgentProgress';
import type { ResearchSessionSnapshot } from '@/types/research';

interface RunningCardProps {
  sessionId: string;
  snapshot: ResearchSessionSnapshot;
  onForceStop?: () => void;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function RunningCard({ sessionId, snapshot, onForceStop }: RunningCardProps) {
  const streamPhase = useStreamPhase(sessionId);
  const statusText = useStreamingStatusText(sessionId);
  const { uses, results } = useStreamingTools(sessionId);
  const agentProgressEvents = useStreamingAgentProgress(sessionId);

  const runningTools = useMemo(
    () => uses.filter((tu) => !results.some((tr) => tr.tool_use_id === tu.id)),
    [uses, results],
  );

  const headline = useMemo(() => {
    if (statusText && statusText.trim()) return statusText;
    const lastProgress = agentProgressEvents[agentProgressEvents.length - 1];
    if (lastProgress?.data?.trim()) return lastProgress.data;
    if (runningTools.length > 0) {
      return `Running: ${runningTools[runningTools.length - 1].name}`;
    }
    return 'Working...';
  }, [statusText, agentProgressEvents, runningTools]);

  const progress = useMemo(() => {
    if (snapshot.coverage > 0) return Math.min(94, snapshot.coverage * 100);
    if (snapshot.maxIterations > 0 && snapshot.currentIteration > 0) {
      return Math.min(92, (snapshot.currentIteration / snapshot.maxIterations) * 92);
    }
    const completedTools = Math.max(0, results.length);
    return Math.min(88, 8 + completedTools * 12);
  }, [snapshot.coverage, snapshot.maxIterations, snapshot.currentIteration, results.length]);

  const activeStep = useMemo(() => {
    return snapshot.planSteps.find((s) => s.status === 'active');
  }, [snapshot.planSteps]);

  const completedCount = useMemo(() => {
    return snapshot.planSteps.filter((s) => s.status === 'completed').length;
  }, [snapshot.planSteps]);

  return (
    <div data-message-id={`research-running-${sessionId}`} className="py-4 px-4">
      <div className="rounded-2xl border" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)' }}>
        <div className="px-4 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <BrainIcon size={16} />
                <h3 className="text-base font-semibold truncate" style={{ color: 'var(--text)' }}>
                  {snapshot.originalQuery || 'Research task'}
                </h3>
              </div>
              <div className="text-sm mt-2" style={{ color: 'var(--text)' }}>
                {headline}
              </div>
              {snapshot.progressSummary && (
                <div className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                  {snapshot.progressSummary}
                </div>
              )}
              <div className="text-xs mt-2" style={{ color: 'var(--muted)' }}>
                {`${formatPercent(snapshot.coverage)} coverage · ${snapshot.currentIteration}/${snapshot.maxIterations} iterations`}
                {snapshot.findingsCount > 0 && ` · ${snapshot.findingsCount} findings`}
                {(snapshot.visitedPagesCount || 0) > 0 && ` · ${snapshot.visitedPagesCount} pages visited`}
              </div>
            </div>
            {onForceStop && (
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border flex-shrink-0"
                style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                onClick={onForceStop}
              >
                <XIcon size={12} />
                Stop
              </button>
            )}
          </div>
          <div className="mt-3 h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--bg-canvas)' }}>
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${progress}%`,
                backgroundColor: 'var(--accent)',
                backgroundImage: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.2) 50%, transparent 100%)',
                backgroundSize: '200% 100%',
                animation: 'shimmer 2s infinite',
              }}
            />
          </div>
        </div>

        {activeStep && (
          <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
            <div className="text-xs font-medium" style={{ color: 'var(--muted)' }}>Current step</div>
            <div className="flex items-center gap-2 mt-1">
              <span
                className="inline-flex items-center justify-center w-5 h-5 rounded-full text-xs flex-shrink-0"
                style={{ backgroundColor: 'var(--accent)', color: 'var(--main-bg)' }}
              >
                {activeStep.order}
              </span>
              <span className="text-sm" style={{ color: 'var(--text)' }}>{activeStep.label}</span>
            </div>
          </div>
        )}

        <div className="px-4 py-3">
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            {completedCount} of {snapshot.planSteps.length || snapshot.planQuestions.length} steps completed
          </div>
          {runningTools.length > 0 && (
            <div className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
              Tools: {runningTools.map((tu) => tu.name).join(', ')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}