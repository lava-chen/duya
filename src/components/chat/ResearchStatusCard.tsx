/**
 * ResearchStatusCard — plan 423 Phase 3.
 *
 * Compact chip shown above the chat composer while a deep-research run is
 * active. Driven by `research_updated` SSE events; on cold session load it
 * seeds from the persisted research snapshot via `modeState.get(sessionId,
 * 'research')`. Clicking the chip opens a detail panel with the query,
 * sub-questions, sources gathered and coverage gaps.
 */

import { useEffect, useState } from 'react';
import { subscribeToResearchUpdated } from '@/lib/stream-session-manager';
import type { ResearchUpdatedEvent } from '@/types/stream';

interface ResearchStatusCardProps {
  sessionId?: string;
}

const STATE_LABELS: Record<string, string> = {
  idle: 'Idle',
  clarifying: 'Clarifying',
  planning: 'Planning',
  gathering: 'Gathering',
  evaluating: 'Evaluating',
  synthesizing: 'Synthesizing',
  awaiting_input: 'Awaiting input',
  blocked: 'Blocked',
  complete: 'Complete',
};

function humanizeResearchEvent(event: string, detail?: string): string {
  const phrase = (d?: string) => (d ? d.replace(/_/g, ' ') : '');
  switch (event) {
    case 'start':
      return 'Started';
    case 'clarify':
      return 'Clarifying';
    case 'plan':
      return 'Planned';
    case 'search':
      return detail ? `Searched: ${phrase(detail)}` : 'Searched';
    case 'sub_question_start':
      return `Fan-out: ${phrase(detail)}`;
    case 'sub_question_done':
      return `Fan-out done: ${phrase(detail)}`;
    case 'evaluate':
      return detail ? `Evaluated: ${phrase(detail)}` : 'Evaluated';
    case 'continue':
      return 'Continuing';
    case 'synthesize':
      return 'Synthesizing';
    case 'report_done':
      return 'Report done';
    case 'ask_user':
      return 'Asked user';
    case 'user_input':
      return 'User provided input';
    case 'block':
      return 'Blocked';
    case 'clear':
      return 'Cleared';
    default: {
      const s = event.replace(/_/g, ' ');
      return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
    }
  }
}

function formatTimeAgo(at: number): string {
  const diffSeconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (diffSeconds < 60) return 'just now';
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function ResearchStatusCard({ sessionId }: ResearchStatusCardProps) {
  const [research, setResearch] = useState<ResearchUpdatedEvent | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest('[data-research-chip],[data-research-panel]')) return;
      setOpen(false);
    };
    const timer = window.setTimeout(() => {
      document.addEventListener('mousedown', handlePointerDown, true);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mousedown', handlePointerDown, true);
    };
  }, [open]);

  useEffect(() => {
    setResearch(null);
    setOpen(false);
    if (!sessionId) return;

    const unsubscribe = subscribeToResearchUpdated(sessionId, setResearch);

    // Cold-load seed: restore a persisted research snapshot so the chip
    // survives a session reload before the next SSE event arrives.
    window.electronAPI?.modeState?.get?.(sessionId, 'research')
      .then((row) => {
        if (!row?.snapshotJson) return;
        const parsed = JSON.parse(row.snapshotJson) as {
          data?: {
            state?: string;
            phase?: string;
            query?: string;
            subQuestions?: string[];
            sourcesGathered?: string[];
            coverageGaps?: string[];
            rounds?: number;
            stallRounds?: number;
            history?: ReadonlyArray<{ at: number; event: string; detail?: string }>;
          };
        };
        const snap = parsed?.data;
        if (!snap?.state || snap.state === 'idle') return;
        setResearch({
          state: snap.state,
          phase: snap.phase ?? '',
          query: snap.query ?? '',
          subQuestions: snap.subQuestions ?? [],
          sourcesGathered: snap.sourcesGathered ?? [],
          coverageGaps: snap.coverageGaps ?? [],
          rounds: snap.rounds ?? 0,
          stallRounds: snap.stallRounds ?? 0,
          history: snap.history ?? [],
        });
      })
      .catch(() => {});

    return () => {
      unsubscribe();
    };
  }, [sessionId]);

  if (!research || !sessionId) return null;
  if (research.state === 'idle') return null;

  const label = STATE_LABELS[research.state] ?? research.state;
  const busy =
    research.state === 'gathering' ||
    research.state === 'evaluating' ||
    research.state === 'synthesizing' ||
    research.state === 'planning';

  return (
    <>
      <button
        type="button"
        className="research-chip"
        data-state={research.state}
        data-research-chip
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Toggle research details"
      >
        <span className="goal-chip-dot" data-state={research.state} />
        <span className="research-chip-label">{label}</span>
        {research.rounds > 0 && <span className="research-chip-rounds">{research.rounds} rounds</span>}
      </button>
      {open && (
        <div className="research-panel" data-research-panel role="dialog" aria-label="Research details">
          <div className="research-panel-header">
            <span className="research-panel-query">{research.query || 'No query'}</span>
            <button
              type="button"
              className="goal-panel-close"
              onClick={() => setOpen(false)}
              aria-label="Close research details"
            >
              ×
            </button>
          </div>

          <div className="research-panel-body">
            <div className="research-panel-status">
              {busy && <span className="goal-panel-spinner" />}
              <span className="goal-chip-dot" data-state={research.state} />
              <span>{label}</span>
              {research.stallRounds > 0 && (
                <span className="research-panel-stall">stalled {research.stallRounds}</span>
              )}
            </div>

            {research.subQuestions.length > 0 && (
              <div className="research-panel-section">
                <div className="goal-panel-section-title">Sub-questions</div>
                <ul className="research-panel-list">
                  {research.subQuestions.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ul>
              </div>
            )}

            {research.sourcesGathered.length > 0 && (
              <div className="research-panel-section">
                <div className="goal-panel-section-title">
                  Sources ({research.sourcesGathered.length})
                </div>
                <ul className="research-panel-list research-panel-list-scroll">
                  {research.sourcesGathered.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            )}

            {research.coverageGaps.length > 0 && (
              <div className="research-panel-section">
                <div className="goal-panel-section-title">Coverage gaps</div>
                <ul className="research-panel-list">
                  {research.coverageGaps.map((g, i) => (
                    <li key={i}>{g}</li>
                  ))}
                </ul>
              </div>
            )}

            {research.history && research.history.length > 0 && (
              <div className="research-panel-section">
                <div className="goal-panel-section-title">History</div>
                <div className="goal-panel-history">
                  {research.history.map((h, i) => (
                    <div key={i} className="goal-panel-history-row">
                      <span className="goal-panel-history-time">{formatTimeAgo(h.at)}</span>
                      <span>{humanizeResearchEvent(h.event, h.detail)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}