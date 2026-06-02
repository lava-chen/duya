'use client';

import React, { useState, useMemo } from 'react';
import { BrainIcon, CopyIcon } from '@/components/icons';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import type { ResearchSessionSnapshot } from '@/types/research';

interface CompletedCardProps {
  sessionId: string;
  snapshot: ResearchSessionSnapshot;
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

export function CompletedCard({ sessionId, snapshot }: CompletedCardProps) {
  const [reportExpanded, setReportExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showSteps, setShowSteps] = useState(false);

  const duration = formatDuration(snapshot.startedAt, snapshot.completedAt);
  const showReport = snapshot.stage === 'complete' || snapshot.stage === 'synthesizing' || !!snapshot.reportText;
  const compactReport = !reportExpanded && snapshot.reportText.length > 1400;
  const reportText = compactReport
    ? `${snapshot.reportText.slice(0, 1400).trimEnd()}\n\n...`
    : snapshot.reportText;

  const steps = snapshot.planSteps.length > 0
    ? snapshot.planSteps
    : snapshot.planQuestions.map((q, i) => ({
        id: q.id,
        order: i + 1,
        label: q.text,
        status: q.status === 'done' ? 'completed' as const
          : q.status === 'active' ? 'active' as const
          : q.status === 'obsolete' ? 'skipped' as const
          : 'pending' as const,
        startedAt: null,
        completedAt: null,
      }));

  const stepStats = useMemo(() => {
    const total = steps.length;
    const completed = steps.filter((s) => s.status === 'completed').length;
    const active = steps.filter((s) => s.status === 'active').length;
    const skipped = steps.filter((s) => s.status === 'skipped').length;
    const failed = steps.filter((s) => s.status === 'failed').length;
    return { total, completed, active, skipped, failed };
  }, [steps]);

  const handleCopyReport = async () => {
    if (!snapshot.reportText) return;
    await navigator.clipboard.writeText(snapshot.reportText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  const handleDownloadMarkdown = () => {
    if (!snapshot.reportText) return;
    const blob = new Blob([snapshot.reportText], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${snapshot.originalQuery || 'research-report'}.md`
      .replace(/[\\/:*?"<>|]+/g, '-')
      .slice(0, 120);
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div data-message-id={`research-complete-${sessionId}`} className="py-4 px-4">
      <div className="rounded-2xl border" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)' }}>
        <div className="px-4 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-2">
            <BrainIcon size={16} />
            <h3 className="text-base font-semibold truncate" style={{ color: 'var(--text)' }}>
              {snapshot.originalQuery || 'Research task'}
            </h3>
          </div>
          <div className="text-sm mt-1" style={{ color: '#16a34a' }}>
            Research completed
          </div>
          <div className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
            {`${formatPercent(snapshot.coverage)} coverage · ${snapshot.findingsCount} findings · ${snapshot.currentIteration} iterations`}
            {snapshot.questionCount > 0 && ` · ${snapshot.questionCount} questions`}
            {duration ? ` · ${duration}` : ''}
          </div>
          {snapshot.summary && (
            <div className="text-sm mt-2" style={{ color: 'var(--text)' }}>
              {snapshot.summary}
            </div>
          )}
        </div>

        {showReport && (
          <div className="px-4 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                Report
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="text-xs px-2 py-1 rounded border"
                  style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                  onClick={() => setReportExpanded((v) => !v)}
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
                <button
                  type="button"
                  className="text-xs px-2 py-1 rounded border"
                  style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                  onClick={handleDownloadMarkdown}
                >
                  Download .md
                </button>
              </div>
            </div>
            {snapshot.reportText ? (
              <MarkdownRenderer className="prose prose-sm max-w-none message-content">
                {reportText}
              </MarkdownRenderer>
            ) : (
              <div className="text-sm" style={{ color: 'var(--muted)' }}>
                Generating report...
              </div>
            )}
          </div>
        )}

        <div className="px-4 py-3">
          <button
            type="button"
            className="w-full flex items-center justify-between text-xs"
            style={{ color: 'var(--muted)' }}
            onClick={() => setShowSteps((v) => !v)}
          >
            <span>
              Steps: {stepStats.completed}/{stepStats.total} completed
              {stepStats.skipped > 0 && ` (${stepStats.skipped} skipped)`}
              {stepStats.failed > 0 && ` (${stepStats.failed} failed)`}
            </span>
            <span className="text-xs">{showSteps ? 'Hide' : 'Show'}</span>
          </button>
          {showSteps && (
            <div className="mt-2 space-y-1 max-h-[200px] overflow-y-auto">
              {steps.map((step) => {
                const statusColors: Record<string, string> = {
                  pending: 'var(--muted)',
                  active: 'var(--accent)',
                  completed: '#16a34a',
                  skipped: 'var(--muted)',
                  failed: '#f87171',
                };
                const statusMarkers: Record<string, string> = {
                  pending: '○',
                  active: '●',
                  completed: '✓',
                  skipped: '—',
                  failed: '✗',
                };
                return (
                  <div key={step.id} className="flex items-center gap-2 text-xs px-2 py-1">
                    <span style={{ color: statusColors[step.status] }}>
                      {statusMarkers[step.status]}
                    </span>
                    <span style={{ color: 'var(--text)' }} className="flex-1">
                      {step.label}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
