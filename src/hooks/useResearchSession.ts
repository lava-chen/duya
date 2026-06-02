import { useEffect, useState } from 'react';
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
};

export function useResearchSession(sessionId: string): ResearchSessionSnapshot {
  const [snapshot, setSnapshot] = useState<ResearchSessionSnapshot>(() => {
    return getResearchSnapshot(sessionId) ?? { ...EMPTY_RESEARCH_SNAPSHOT, sessionId };
  });
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    setSnapshot(getResearchSnapshot(sessionId) ?? { ...EMPTY_RESEARCH_SNAPSHOT, sessionId });
    return subscribeToResearch(sessionId, setSnapshot);
  }, [sessionId]);

  // Restore research state from DB on mount if not already restored
  useEffect(() => {
    if (restored) return;
    if (!sessionId) return;

    const currentSnapshot = getResearchSnapshot(sessionId);
    if (currentSnapshot?.active || currentSnapshot?.planQuestions?.length) {
      setRestored(true);
      return;
    }

    restoreResearchStateFromDB(sessionId).then((success) => {
      if (success) {
        setRestored(true);
      }
    });
  }, [sessionId, restored]);

  return snapshot;
}
