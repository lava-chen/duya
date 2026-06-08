import { useEffect, useRef, useState } from 'react';
import type { ResearchSessionSnapshot } from '@/types/research';
import { getResearchSnapshot, subscribeToResearch, restoreResearchStateFromDB } from '@/lib/stream-session-manager';

const EMPTY_RESEARCH_SNAPSHOT: ResearchSessionSnapshot = {
  sessionId: '',
  mode: null,
  active: false,
  stage: 'idle',
  originalQuery: '',
  complexity: undefined,
  complexityDescription: undefined,
  phase: undefined,
  maxIterations: 0,
  currentIteration: 0,
  coverage: 0,
  findingsCount: 0,
  questionCount: 0,
  planQuestions: [],
  plan: null,
  findings: [],
  reportText: '',
  summary: undefined,
  error: null,
  pendingRequest: null,
  activities: [],
  startedAt: null,
  completedAt: null,
  runId: null,
  runStatus: null,
  planSteps: [],
  progressSummary: null,
  visitedPagesCount: 0,
  persistedEvents: [],
  persistedSources: [],
  persistedCitations: [],
  reportArtifact: null,
  lastEvidenceChain: null,
};

export function useResearchSession(sessionId: string): ResearchSessionSnapshot {
  const [snapshot, setSnapshot] = useState<ResearchSessionSnapshot>(() => {
    return getResearchSnapshot(sessionId) ?? { ...EMPTY_RESEARCH_SNAPSHOT, sessionId };
  });
  const restoredSessionIds = useRef(new Set<string>());

  useEffect(() => {
    setSnapshot(getResearchSnapshot(sessionId) ?? { ...EMPTY_RESEARCH_SNAPSHOT, sessionId });
    return subscribeToResearch(sessionId, setSnapshot);
  }, [sessionId]);

  // Restore research state from DB on mount if not already restored
  useEffect(() => {
    if (!sessionId) return;
    if (restoredSessionIds.current.has(sessionId)) return;

    const currentSnapshot = getResearchSnapshot(sessionId);
    if (currentSnapshot?.active || currentSnapshot?.planQuestions?.length) {
      restoredSessionIds.current.add(sessionId);
      return;
    }

    let cancelled = false;
    restoreResearchStateFromDB(sessionId).then((success) => {
      if (!cancelled && success) {
        restoredSessionIds.current.add(sessionId);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return snapshot;
}
