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
  const [showPlanEditor, setShowPlanEditor] = useState(false);
  const [planEdit, setPlanEdit] = useState({
    scope: '',
    question: '',
    sources: '',
    remove: '',
  });

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
  const isRestoredPendingRequest = snapshot.pendingRequest?.requestId.startsWith('restored_plan_') ?? false;

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
    ? 'Research plan ready - review and start'
    : snapshot.stage === 'clarifying'
      ? 'Need some clarification before planning'
      : 'Building research plan';

  return (
    <div data-message-id={`research-plan-${sessionId}`} className="py-4 px-4">
      <div className="rounded-2xl border px-4 py-4 space-y-4" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)' }}>
        <div>
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

        {isRestoredPendingRequest && (
          <div className="rounded-xl px-3 py-2 text-xs" style={{ backgroundColor: 'var(--chip)', color: 'var(--muted)' }}>
            This research plan was restored from saved state, but the original worker is no longer waiting for approval. Start a fresh research run to continue.
          </div>
        )}

        <div className="space-y-3">
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

        {isPlanApproval && !isRestoredPendingRequest && (
          <>
            {showPlanEditor && (
              <div className="space-y-3 rounded-xl px-3 py-3" style={{ backgroundColor: 'var(--chip)' }}>
                <div className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                  Edit before starting
                </div>
                <label className="block">
                  <span className="text-xs" style={{ color: 'var(--muted)' }}>Scope or constraints</span>
                  <textarea
                    className="mt-1 w-full rounded border bg-transparent px-3 py-2 text-sm outline-none"
                    style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                    rows={2}
                    value={planEdit.scope}
                    onChange={(e) => setPlanEdit((current) => ({ ...current, scope: e.target.value }))}
                    placeholder="e.g. focus on peer-reviewed sources after 2023"
                  />
                </label>
                <label className="block">
                  <span className="text-xs" style={{ color: 'var(--muted)' }}>Add a research question</span>
                  <input
                    className="mt-1 w-full rounded border bg-transparent px-3 py-2 text-sm outline-none"
                    style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                    value={planEdit.question}
                    onChange={(e) => setPlanEdit((current) => ({ ...current, question: e.target.value }))}
                    placeholder="A new question the agent should answer"
                  />
                </label>
                <label className="block">
                  <span className="text-xs" style={{ color: 'var(--muted)' }}>Prioritize sources or domains</span>
                  <input
                    className="mt-1 w-full rounded border bg-transparent px-3 py-2 text-sm outline-none"
                    style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                    value={planEdit.sources}
                    onChange={(e) => setPlanEdit((current) => ({ ...current, sources: e.target.value }))}
                    placeholder="arxiv.org, nature.com, official docs..."
                  />
                </label>
                <label className="block">
                  <span className="text-xs" style={{ color: 'var(--muted)' }}>Remove question ids or exact text</span>
                  <input
                    className="mt-1 w-full rounded border bg-transparent px-3 py-2 text-sm outline-none"
                    style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                    value={planEdit.remove}
                    onChange={(e) => setPlanEdit((current) => ({ ...current, remove: e.target.value }))}
                    placeholder="Optional, comma separated"
                  />
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="text-xs px-3 py-1.5 rounded border"
                    style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                    disabled={isSubmitting || !planEdit.scope.trim()}
                    onClick={() => void resolvePendingRequest({ approval: 'edit_scope', scope: planEdit.scope })}
                  >
                    Apply scope
                  </button>
                  <button
                    type="button"
                    className="text-xs px-3 py-1.5 rounded border"
                    style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                    disabled={isSubmitting || !planEdit.question.trim()}
                    onClick={() => void resolvePendingRequest({ approval: 'add_question', question: planEdit.question })}
                  >
                    Add question
                  </button>
                  <button
                    type="button"
                    className="text-xs px-3 py-1.5 rounded border"
                    style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                    disabled={isSubmitting || !planEdit.sources.trim()}
                    onClick={() => void resolvePendingRequest({ approval: 'change_sources', sources: planEdit.sources })}
                  >
                    Update sources
                  </button>
                  <button
                    type="button"
                    className="text-xs px-3 py-1.5 rounded border"
                    style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                    disabled={isSubmitting || !planEdit.remove.trim()}
                    onClick={() => void resolvePendingRequest({ approval: 'remove_question', questionIds: planEdit.remove })}
                  >
                    Remove
                  </button>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded border"
                style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
                onClick={() => setShowPlanEditor((value) => !value)}
              >
                <PencilIcon size={12} />
                {showPlanEditor ? 'Hide edit' : 'Edit plan'}
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
                  className="text-xs px-3 py-1.5 rounded border"
                  style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                  disabled={isSubmitting}
                  onClick={() => void resolvePendingRequest({ approval: 'increase_depth' })}
                >
                  More depth
                </button>
                <button
                  type="button"
                  className="text-xs px-3 py-1.5 rounded border"
                  style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                  disabled={isSubmitting}
                  onClick={() => void resolvePendingRequest({ approval: 'decrease_depth' })}
                >
                  Faster
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
          </>
        )}
      </div>
    </div>
  );
}
