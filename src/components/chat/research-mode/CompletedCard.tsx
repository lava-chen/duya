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

function makeSafeFileName(value: string, extension: string): string {
  const base = (value || 'research-report')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .slice(0, 120)
    .trim();
  return `${base || 'research-report'}${extension}`;
}

function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function markdownToPortableHtml(markdown: string, title: string): string {
  const paragraphs = markdown
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('\n');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: Georgia, serif; line-height: 1.55; color: #111827; padding: 32px; }
    p { margin: 0 0 14px; }
  </style>
</head>
<body>
${paragraphs}
</body>
</html>`;
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

  const sourceList = useMemo(() => {
    const sourceMap = new Map<string, { title: string; url: string | null; sourceType?: string }>();

    for (const source of snapshot.persistedSources) {
      sourceMap.set(source.url || source.id, {
        title: source.title || source.url || 'Untitled source',
        url: source.url,
        sourceType: source.source_type,
      });
    }

    for (const finding of snapshot.findings) {
      const key = finding.url || finding.source;
      if (!key || sourceMap.has(key)) continue;
      sourceMap.set(key, {
        title: finding.title || finding.source || finding.url || 'Untitled source',
        url: finding.url || null,
        sourceType: finding.sourceReliability,
      });
    }

    return Array.from(sourceMap.values());
  }, [snapshot.findings, snapshot.persistedSources]);

  const handleCopyReport = async () => {
    if (!snapshot.reportText) return;
    await navigator.clipboard.writeText(snapshot.reportText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  const handleDownloadMarkdown = () => {
    if (!snapshot.reportText) return;
    const blob = new Blob([snapshot.reportText], { type: 'text/markdown;charset=utf-8' });
    downloadBlob(makeSafeFileName(snapshot.originalQuery, '.md'), blob);
  };

  const handleDownloadWord = () => {
    if (!snapshot.reportText) return;
    const html = markdownToPortableHtml(snapshot.reportText, snapshot.originalQuery || 'Research report');
    const blob = new Blob([html], { type: 'application/msword;charset=utf-8' });
    downloadBlob(makeSafeFileName(snapshot.originalQuery, '.doc'), blob);
  };

  const handleDownloadEvidence = () => {
    const evidencePackage = {
      query: snapshot.originalQuery,
      generatedAt: new Date().toISOString(),
      coverage: snapshot.coverage,
      iterations: snapshot.currentIteration,
      sources: snapshot.persistedSources,
      citations: snapshot.persistedCitations,
      findings: snapshot.findings,
      activities: snapshot.activities,
    };
    const blob = new Blob([JSON.stringify(evidencePackage, null, 2)], { type: 'application/json;charset=utf-8' });
    downloadBlob(makeSafeFileName(snapshot.originalQuery, '-evidence.json'), blob);
  };

  return (
    <div data-message-id={`research-complete-${sessionId}`} className="py-4 px-4">
      <div className="rounded-2xl border px-4 py-4 space-y-4" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)' }}>
        <div>
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
            {`${formatPercent(snapshot.coverage)} coverage - ${snapshot.findingsCount} findings - ${snapshot.currentIteration} iterations`}
            {snapshot.questionCount > 0 && ` - ${snapshot.questionCount} questions`}
            {sourceList.length > 0 && ` - ${sourceList.length} sources`}
            {duration ? ` - ${duration}` : ''}
          </div>
          {snapshot.summary && (
            <div className="text-sm mt-2" style={{ color: 'var(--text)' }}>
              {snapshot.summary}
            </div>
          )}
        </div>

        {showReport && (
          <div className="rounded-xl px-3 py-3" style={{ backgroundColor: 'var(--chip)' }}>
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
                <button
                  type="button"
                  className="text-xs px-2 py-1 rounded border"
                  style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                  onClick={handleDownloadWord}
                >
                  Download .doc
                </button>
                <button
                  type="button"
                  className="text-xs px-2 py-1 rounded border"
                  style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                  onClick={() => window.print()}
                >
                  Print/PDF
                </button>
                <button
                  type="button"
                  className="text-xs px-2 py-1 rounded border"
                  style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                  onClick={handleDownloadEvidence}
                >
                  Evidence
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

        {sourceList.length > 0 && (
          <div className="rounded-xl px-3 py-3" style={{ backgroundColor: 'var(--chip)' }}>
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                Sources used
              </div>
              <div className="text-xs" style={{ color: 'var(--muted)' }}>
                {sourceList.length} collected
              </div>
            </div>
            <div className="space-y-2 max-h-[220px] overflow-y-auto">
              {sourceList.slice(0, 12).map((source, index) => (
                <div key={`${source.url || source.title}-${index}`} className="rounded-lg px-3 py-2" style={{ backgroundColor: 'var(--surface)' }}>
                  <div className="text-xs font-medium truncate" style={{ color: 'var(--text)' }}>
                    {source.url ? (
                      <a href={source.url} target="_blank" rel="noreferrer" className="hover:underline">
                        {source.title}
                      </a>
                    ) : source.title}
                  </div>
                  <div className="text-[11px] truncate mt-1" style={{ color: 'var(--muted)' }}>
                    {source.url || source.sourceType || 'source'}
                  </div>
                </div>
              ))}
              {sourceList.length > 12 && (
                <div className="text-xs" style={{ color: 'var(--muted)' }}>
                  {sourceList.length - 12} more sources are included in the evidence export.
                </div>
              )}
            </div>
          </div>
        )}

        <div>
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
                  pending: '-',
                  active: '>',
                  completed: 'done',
                  skipped: 'skip',
                  failed: '!',
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
