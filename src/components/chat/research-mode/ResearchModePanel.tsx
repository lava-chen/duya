'use client';

import React, { useMemo, useState } from 'react';
import { BrainIcon, CopyIcon, XIcon } from '@/components/icons';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { getAgentServerClient } from '@/lib/agent-http-client';
import { useStreamPhase } from '@/hooks/useStreamPhase';
import { useStreamingAgentProgress } from '@/hooks/useStreamingAgentProgress';
import { useStreamingStatusText } from '@/hooks/useStreamingStatusText';
import { useStreamingTools } from '@/hooks/useStreamingTools';
import type { ResearchActivityItem, ResearchSessionSnapshot } from '@/types/research';

interface ResearchModePanelProps {
  sessionId: string;
  snapshot: ResearchSessionSnapshot;
  onForceStop?: () => void;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatDuration(startedAt: number | null, completedAt: number | null): string | null {
  if (!startedAt) return null;
  const end = completedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function getStageLabel(stage: ResearchSessionSnapshot['stage']): string {
  switch (stage) {
    case 'planning':
      return 'Preparing research plan';
    case 'awaiting_plan_approval':
      return 'Plan ready, waiting for confirmation';
    case 'clarifying':
      return 'Waiting for clarification';
    case 'researching':
      return 'Researching sources';
    case 'synthesizing':
      return 'Synthesizing report';
    case 'complete':
      return 'Research completed';
    case 'error':
      return 'Research failed';
    case 'aborted':
      return 'Research stopped';
    default:
      return 'Initializing';
  }
}

function formatPurpose(purpose?: string): string {
  switch (purpose) {
    case 'definition':
      return 'Concept boundary';
    case 'mechanism':
      return 'Technical mechanism';
    case 'evidence':
      return 'Application evidence';
    case 'comparison':
      return 'Route comparison';
    case 'critique':
      return 'Limitations and controversy';
    case 'trend':
      return 'Trend and trajectory';
    case 'implementation':
      return 'Implementation path';
    case 'decision':
      return 'Decision support';
    default:
      return 'Research question';
  }
}

export function ResearchModePanel({
  sessionId,
  snapshot,
  onForceStop,
}: ResearchModePanelProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [showActivity, setShowActivity] = useState(false);
  const [reportExpanded, setReportExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const streamPhase = useStreamPhase(sessionId);
  const statusText = useStreamingStatusText(sessionId);
  const { uses, results } = useStreamingTools(sessionId);
  const agentProgressEvents = useStreamingAgentProgress(sessionId);

  const isStreamingFallback = streamPhase === 'starting'
    || streamPhase === 'streaming'
    || streamPhase === 'awaiting_permission'
    || streamPhase === 'persisting';

  const runningTools = useMemo(
    () => uses.filter((toolUse) => !results.some((toolResult) => toolResult.tool_use_id === toolUse.id)),
    [uses, results],
  );

  const fallbackHeadline = useMemo(() => {
    if (snapshot.stage === 'awaiting_plan_approval') return 'Pending your confirmation';
    if (statusText && statusText.trim()) return statusText;
    const lastProgress = agentProgressEvents[agentProgressEvents.length - 1];
    if (lastProgress?.data && lastProgress.data.trim()) return lastProgress.data;
    if (runningTools.length > 0) {
      const currentTool = runningTools[runningTools.length - 1];
      return `Running tool: ${currentTool.name}`;
    }
    if (isStreamingFallback) return 'Working...';
    return '';
  }, [statusText, agentProgressEvents, runningTools, isStreamingFallback, snapshot.stage]);

  const effectiveStage = useMemo(() => {
    if (snapshot.stage !== 'idle') return snapshot.stage;
    if (isStreamingFallback) return 'researching' as const;
    return snapshot.stage;
  }, [snapshot.stage, isStreamingFallback]);

  const effectiveProgress = useMemo(() => {
    if (snapshot.stage === 'awaiting_plan_approval') {
      return snapshot.planQuestions.length > 0 ? 10 : 0;
    }
    if (snapshot.coverage > 0) return Math.min(100, snapshot.coverage * 100);
    if (snapshot.maxIterations > 0 && snapshot.currentIteration > 0) {
      return Math.min(100, (snapshot.currentIteration / snapshot.maxIterations) * 100);
    }
    if (isStreamingFallback) {
      const completedTools = Math.max(0, results.length);
      return Math.min(92, 8 + completedTools * 12);
    }
    return 0;
  }, [snapshot.coverage, snapshot.maxIterations, snapshot.currentIteration, isStreamingFallback, results.length]);

  const duration = formatDuration(snapshot.startedAt, snapshot.completedAt);
  const isPlanApproval = snapshot.pendingRequest?.kind === 'plan_approval';
  const isClarification = snapshot.pendingRequest?.kind === 'clarification';
  const plan = snapshot.plan;

  const mergedActivities = useMemo<ResearchActivityItem[]>(() => {
    const base = [...snapshot.activities];
    const fallback = agentProgressEvents.slice(-20).map((event, index) => ({
      id: `fallback-${event.seq}-${index}`,
      title: event.toolName ? `${event.toolName}` : 'Agent progress',
      detail: event.data || event.toolResult || '',
      timestamp: event.receivedAt,
      tone: 'neutral' as const,
    }));

    const merged = [...fallback, ...base];
    merged.sort((a, b) => b.timestamp - a.timestamp);
    return merged.slice(0, 40);
  }, [snapshot.activities, agentProgressEvents]);

  const resolvePendingRequest = async (payload: Record<string, string>) => {
    if (!snapshot.pendingRequest) return;
    setIsSubmitting(true);
    setActionError(null);
    try {
      await getAgentServerClient().resolveResearchClarification(
        sessionId,
        snapshot.pendingRequest.requestId,
        payload,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCopyReport = async () => {
    if (!snapshot.reportText) return;
    await navigator.clipboard.writeText(snapshot.reportText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  const showReport = snapshot.stage === 'complete' || snapshot.stage === 'synthesizing' || !!snapshot.reportText;
  const compactReport = !reportExpanded && snapshot.reportText.length > 1400;
  const reportText = compactReport
    ? `${snapshot.reportText.slice(0, 1400).trimEnd()}\n\n...`
    : snapshot.reportText;

  return (
    <div data-message-id={`research-${sessionId}`} className="py-4 px-4">
      <div className="rounded-2xl border" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)' }}>
        <div className="px-4 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <BrainIcon size={16} />
                <h3 className="text-base font-semibold truncate" style={{ color: 'var(--text)' }}>
                  {snapshot.originalQuery || 'Research task'}
                </h3>
              </div>
              <div className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
                {getStageLabel(effectiveStage)}
              </div>
              {fallbackHeadline && (
                <div className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                  {fallbackHeadline}
                </div>
              )}
              <div className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                {snapshot.stage === 'awaiting_plan_approval'
                  ? 'Coverage starts after you click Start research'
                  : `${formatPercent(snapshot.coverage)} coverage`}
                {snapshot.maxIterations > 0 ? ` · ${snapshot.currentIteration}/${snapshot.maxIterations} iterations` : ''}
                {duration ? ` · ${duration}` : ''}
              </div>
              {snapshot.stage === 'awaiting_plan_approval' && snapshot.maxIterations > 0 && (
                <div className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                  {`Iteration budget: ${snapshot.maxIterations} (complexity: ${snapshot.complexity || 'unknown'})`}
                </div>
              )}
            </div>
            <button
              type="button"
              className="text-xs px-2 py-1 rounded border"
              style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
              onClick={() => setShowActivity((current) => !current)}
            >
              {showActivity ? 'Hide activity' : 'Research activity'}
            </button>
          </div>
          <div className="mt-3 h-1.5 rounded-full" style={{ backgroundColor: 'var(--bg-canvas)' }}>
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{ width: `${effectiveProgress}%`, backgroundColor: 'var(--accent)' }}
            />
          </div>
        </div>

        <div className="px-4 py-4 space-y-3">
          {plan && (
            <div className="space-y-3">
              <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
                <div className="text-xs font-medium mb-1" style={{ color: 'var(--muted)' }}>Research goal</div>
                <div className="text-sm" style={{ color: 'var(--text)' }}>
                  {plan.intent.userGoal}
                </div>
                <div className="text-xs mt-2" style={{ color: 'var(--muted)' }}>
                  {`Type: ${plan.intent.taskType} · Output: ${plan.intent.expectedOutput} · Audience: ${plan.intent.audienceLevel}`}
                </div>
              </div>

              <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
                <div className="text-xs font-medium mb-1" style={{ color: 'var(--muted)' }}>Scope and assumptions</div>
                <div className="text-xs mb-1" style={{ color: 'var(--muted)' }}>
                  {`Time range: ${plan.scope.timeRange || 'Not specified'}${plan.scope.geography ? ` · Geography: ${plan.scope.geography}` : ''}`}
                </div>
                {plan.scope.included.length > 0 && (
                  <div className="text-sm mb-1" style={{ color: 'var(--text)' }}>
                    Included: {plan.scope.included.join('; ')}
                  </div>
                )}
                {plan.scope.assumptions.length > 0 && (
                  <div className="text-sm" style={{ color: 'var(--text)' }}>
                    Assumptions: {plan.scope.assumptions.join('; ')}
                  </div>
                )}
              </div>

              <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
                <div className="text-xs font-medium mb-1" style={{ color: 'var(--muted)' }}>Source strategy</div>
                <div className="text-sm" style={{ color: 'var(--text)' }}>
                  Primary: {plan.evidenceStrategy.sourceTypes.join(', ')}
                </div>
                <div className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                  {`Freshness: ${plan.evidenceStrategy.freshnessRequirement} · Min independent sources: ${plan.evidenceStrategy.minIndependentSources}`}
                </div>
                <div className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                  {`Primary source required: ${plan.evidenceStrategy.mustFindPrimarySources ? 'yes' : 'no'} · Counter evidence required: ${plan.evidenceStrategy.mustFindCounterEvidence ? 'yes' : 'no'}`}
                </div>
              </div>
            </div>
          )}

          {snapshot.planQuestions.length > 0 ? (
            snapshot.planQuestions.map((question) => {
              const index = snapshot.planQuestions.findIndex((item) => item.id === question.id) + 1;
              const statusLabel = question.status === 'active'
                ? 'In progress'
                : question.status === 'done'
                  ? 'Done'
                  : question.status === 'obsolete'
                    ? 'Obsolete'
                    : 'Pending';
              return (
                <div key={question.id} className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--border)' }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="inline-flex items-center gap-2">
                      <span
                        className="inline-flex items-center justify-center w-5 h-5 rounded-full text-xs"
                        style={{ backgroundColor: 'var(--bg-canvas)', color: 'var(--text)' }}
                      >
                        {index}
                      </span>
                      <span style={{ color: 'var(--text)' }}>{question.text}</span>
                    </div>
                    <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: 'var(--bg-canvas)', color: 'var(--muted)' }}>
                      {statusLabel}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2 mt-2">
                    <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: 'var(--bg-canvas)', color: 'var(--muted)' }}>
                      {formatPurpose(question.purpose)}
                    </span>
                    {typeof question.priority === 'number' && (
                      <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: 'var(--bg-canvas)', color: 'var(--muted)' }}>
                        {`P${question.priority}`}
                      </span>
                    )}
                    {question.requiredEvidence && (
                      <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: 'var(--bg-canvas)', color: 'var(--muted)' }}>
                        {`Evidence: ${question.requiredEvidence.minSources}+ sources${question.requiredEvidence.needsCounterEvidence ? ' + counter-evidence' : ''}`}
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="text-sm" style={{ color: 'var(--muted)' }}>
              {fallbackHeadline || 'Research plan is being prepared.'}
            </div>
          )}

          {runningTools.length > 0 && (
            <div className="text-xs" style={{ color: 'var(--muted)' }}>
              Running tools: {runningTools.map((toolUse) => toolUse.name).join(', ')}
            </div>
          )}

          {actionError && (
            <div className="text-xs rounded border px-2 py-1" style={{ color: '#f87171', borderColor: '#7f1d1d' }}>
              {`Action failed: ${actionError}`}
            </div>
          )}

          {isPlanApproval && (
            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                className="text-sm px-3 py-1.5 rounded border"
                style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                disabled={isSubmitting}
                onClick={() => void resolvePendingRequest({ approval: 'cancel' })}
              >
                Cancel
              </button>
              <button
                type="button"
                className="text-sm px-3 py-1.5 rounded"
                style={{ backgroundColor: 'var(--accent)', color: 'var(--main-bg)' }}
                disabled={isSubmitting}
                onClick={() => void resolvePendingRequest({ approval: 'start' })}
              >
                {isSubmitting ? 'Submitting...' : 'Start research'}
              </button>
            </div>
          )}

          {isClarification && snapshot.pendingRequest && (
            <div className="space-y-2 pt-2">
              {snapshot.pendingRequest.questions.map((question) => (
                <div key={question.id}>
                  <div className="text-sm mb-1" style={{ color: 'var(--text)' }}>
                    {question.text}
                  </div>
                  <input
                    type="text"
                    className="w-full rounded border px-3 py-2 text-sm bg-transparent outline-none"
                    style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                    value={answers[question.id] || ''}
                    onChange={(event) =>
                      setAnswers((current) => ({ ...current, [question.id]: event.target.value }))
                    }
                  />
                </div>
              ))}
              <button
                type="button"
                className="text-sm px-3 py-1.5 rounded"
                style={{ backgroundColor: 'var(--accent)', color: 'var(--main-bg)' }}
                disabled={isSubmitting}
                onClick={() => void resolvePendingRequest(answers)}
              >
                {isSubmitting ? 'Submitting...' : 'Continue'}
              </button>
            </div>
          )}
        </div>

        {showReport && (
          <div className="px-4 py-4 border-t" style={{ borderColor: 'var(--border)' }}>
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                Report
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="text-xs px-2 py-1 rounded border"
                  style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                  onClick={() => setReportExpanded((current) => !current)}
                >
                  {reportExpanded ? 'Collapse' : 'Expand'}
                </button>
                <button
                  type="button"
                  className="text-xs px-2 py-1 rounded border inline-flex items-center gap-1"
                  style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                  onClick={() => void handleCopyReport()}
                >
                  <CopyIcon size={12} />
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
            {snapshot.reportText ? (
              <MarkdownRenderer className="prose prose-sm max-w-none message-content">
                {reportText}
              </MarkdownRenderer>
            ) : (
              <div className="text-sm" style={{ color: 'var(--muted)' }}>
                Report is being generated...
              </div>
            )}
          </div>
        )}

        {showActivity && (
          <div className="px-4 py-4 border-t" style={{ borderColor: 'var(--border)' }}>
            <div className="text-sm font-medium mb-2" style={{ color: 'var(--text)' }}>
              Activity
            </div>
            <div className="max-h-[260px] overflow-y-auto space-y-2">
              {mergedActivities.length === 0 ? (
                <div className="text-sm" style={{ color: 'var(--muted)' }}>
                  No activity yet.
                </div>
              ) : (
                mergedActivities.map((activity) => (
                  <div key={activity.id} className="text-sm">
                    <div style={{ color: 'var(--text)' }}>{activity.title}</div>
                    {activity.detail && (
                      <div className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
                        {activity.detail}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {(snapshot.stage === 'researching' || snapshot.stage === 'synthesizing') && onForceStop && (
          <div className="px-4 py-3 border-t flex justify-end" style={{ borderColor: 'var(--border)' }}>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border"
              style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
              onClick={onForceStop}
            >
              <XIcon size={12} />
              Stop
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
