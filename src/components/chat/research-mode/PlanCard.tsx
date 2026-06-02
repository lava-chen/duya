'use client';

import React, { useState } from 'react';
import { BrainIcon, PencilIcon } from '@/components/icons';
import { getAgentServerClient } from '@/lib/agent-http-client';
import type { ResearchSessionSnapshot } from '@/types/research';

interface PlanCardProps {
  sessionId: string;
  snapshot: ResearchSessionSnapshot;
}

export function PlanCard({ sessionId, snapshot }: PlanCardProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  const steps = snapshot.planSteps.length > 0
    ? snapshot.planSteps.slice(0, 5)
    : snapshot.planQuestions.slice(0, 5).map((q, i) => ({
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

  const isPlanApproval = snapshot.pendingRequest?.kind === 'plan_approval';
  const isClarification = snapshot.pendingRequest?.kind === 'clarification';

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

  const statusText = snapshot.stage === 'awaiting_plan_approval'
    ? 'Research plan ready — review and start'
    : snapshot.stage === 'clarifying'
      ? 'Need some clarification before planning'
      : 'Building research plan';

  return (
    <div data-message-id={`research-plan-${sessionId}`} className="py-4 px-4">
      <div className="rounded-2xl border" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)' }}>
        <div className="px-4 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-2">
            <BrainIcon size={16} />
            <h3 className="text-base font-semibold truncate" style={{ color: 'var(--text)' }}>
              {snapshot.originalQuery || 'Research task'}
            </h3>
          </div>
          <div className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
            {statusText}
          </div>
        </div>

        <div className="px-4 py-4 space-y-3">
          {steps.map((step) => {
            const statusColors: Record<string, string> = {
              pending: 'var(--muted)',
              active: 'var(--accent)',
              completed: '#16a34a',
              skipped: 'var(--muted)',
              failed: '#f87171',
            };
            const statusLabels: Record<string, string> = {
              pending: 'Pending',
              active: 'In progress',
              completed: 'Done',
              skipped: 'Skipped',
              failed: 'Failed',
            };
            return (
              <div key={step.id} className="flex items-center gap-3 px-3 py-2 rounded-lg border" style={{ borderColor: 'var(--border)' }}>
                <span
                  className="inline-flex items-center justify-center w-5 h-5 rounded-full text-xs flex-shrink-0"
                  style={{
                    backgroundColor: step.status === 'active' ? 'var(--accent)' : 'var(--bg-canvas)',
                    color: step.status === 'active' ? 'var(--main-bg)' : 'var(--text)',
                  }}
                >
                  {step.order}
                </span>
                <span className="text-sm flex-1" style={{ color: 'var(--text)' }}>{step.label}</span>
                <span className="text-xs" style={{ color: statusColors[step.status] }}>
                  {statusLabels[step.status]}
                </span>
              </div>
            );
          })}

          {actionError && (
            <div className="text-xs rounded border px-2 py-1" style={{ color: '#f87171', borderColor: '#7f1d1d' }}>
              {actionError}
            </div>
          )}

          {isClarification && snapshot.pendingRequest && (
            <div className="space-y-2 pt-2">
              {snapshot.pendingRequest.questions.map((q) => (
                <div key={q.id}>
                  <div className="text-sm mb-1" style={{ color: 'var(--text)' }}>{q.text}</div>
                  <input
                    type="text"
                    className="w-full rounded border px-3 py-2 text-sm bg-transparent outline-none"
                    style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                    value={answers[q.id] || ''}
                    onChange={(e) => setAnswers((c) => ({ ...c, [q.id]: e.target.value }))}
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

        {isPlanApproval && (
          <div className="px-4 py-3 border-t flex items-center justify-between gap-2" style={{ borderColor: 'var(--border)' }}>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded border"
              style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
            >
              <PencilIcon size={12} />
              Edit plan
            </button>
            <div className="flex items-center gap-2">
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
                className="text-sm px-4 py-1.5 rounded font-medium"
                style={{ backgroundColor: 'var(--accent)', color: 'var(--main-bg)' }}
                disabled={isSubmitting}
                onClick={() => void resolvePendingRequest({ approval: 'start' })}
              >
                {isSubmitting ? 'Starting...' : 'Start research'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
