'use client';

import React from 'react';
import { usePanel } from '@/hooks/usePanel';
import type { ResearchSessionSnapshot } from '@/types/research';
import { PlanCard } from './PlanCard';
import { RunningCard } from './RunningCard';
import { CompletedCard } from './CompletedCard';

export interface ResearchModePanelProps {
  sessionId: string;
  snapshot: ResearchSessionSnapshot;
  onForceStop?: () => void;
}

export function ResearchModePanel({
  sessionId,
  snapshot,
  onForceStop,
}: ResearchModePanelProps) {
  const { panelOpen, tabs, activeTabId, openOrActivatePage, setPanelOpen } = usePanel();

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const isResearchActive = panelOpen && activeTab?.pageId === 'research';

  const toggleResearchPanel = () => {
    if (isResearchActive) {
      setPanelOpen(false);
      return;
    }
    openOrActivatePage('research');
  };

  if (!snapshot.mode || snapshot.mode !== 'research') return null;

  const isPlanStage = snapshot.stage === 'planning'
    || snapshot.stage === 'awaiting_plan_approval'
    || snapshot.stage === 'clarifying';

  const isRunningStage = snapshot.stage === 'researching';

  const isCompletedStage = snapshot.stage === 'complete'
    || snapshot.stage === 'synthesizing'
    || snapshot.stage === 'error'
    || snapshot.stage === 'aborted';

  const showStopButton = (snapshot.stage === 'researching' || snapshot.stage === 'synthesizing') && onForceStop;

  return (
    <>
      {isPlanStage && (
        <PlanCard sessionId={sessionId} snapshot={snapshot} />
      )}
      {isRunningStage && (
        <RunningCard sessionId={sessionId} snapshot={snapshot} onForceStop={showStopButton ? onForceStop : undefined} />
      )}
      {isCompletedStage && (
        <CompletedCard sessionId={sessionId} snapshot={snapshot} />
      )}
      {snapshot.activities.length > 0 && (
        <div className="px-4 pb-2">
          <button
            type="button"
            className="text-xs px-2 py-1 rounded border"
            style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
            onClick={toggleResearchPanel}
          >
            {snapshot.active ? 'View activity' : 'Research log'} ({snapshot.activities.length})
          </button>
        </div>
      )}
    </>
  );
}
