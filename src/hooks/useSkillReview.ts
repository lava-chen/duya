/**
 * useSkillReview - Subscribe to skill-review lifecycle events for a
 * given session.
 *
 * The SelfImprover spawns a background sub-agent after a configurable
 * number of turns (default 10). When that happens, the agent emits
 * `skill_review_started` / `skill_review_completed` SSE events; this
 * hook turns those into a tiny state machine the UI can render.
 *
 * Usage:
 *   const review = useSkillReview(sessionId);
 *   if (review.status === 'running') { // show "Self-improving..." }
 *   if (review.status === 'completed' && review.passed) { // toast }
 */

import { useEffect, useState } from 'react';
import { subscribeToSkillReview, type SkillReviewEvent } from '@/lib/stream-session-manager';

export type SkillReviewStatus = 'idle' | 'running' | 'completed' | 'failed';

export interface SkillReviewState {
  status: SkillReviewStatus;
  /** Wall-clock ms when the review started. */
  startedAt: number | null;
  /** Wall-clock ms when the review ended. */
  completedAt: number | null;
  passed?: boolean;
  score?: number;
  skillName?: string;
  feedback?: string;
  error?: string;
}

const INITIAL: SkillReviewState = {
  status: 'idle',
  startedAt: null,
  completedAt: null,
};

/**
 * Subscribe to skill-review events for `sessionId`. The hook returns
 * the latest state and resets to `idle` when a new review starts.
 *
 * The state survives navigation (kept in the session manager, not
 * in component-local React state), so a user who switches chats
 * mid-review will see the indicator on the other chat too — which
 * is the correct UX (the review is session-scoped, not view-scoped).
 */
export function useSkillReview(sessionId: string | null | undefined): SkillReviewState {
  const [state, setState] = useState<SkillReviewState>(INITIAL);

  useEffect(() => {
    if (!sessionId) {
      setState(INITIAL);
      return;
    }
    const unsubscribe = subscribeToSkillReview(sessionId, (event: SkillReviewEvent) => {
      if (event.phase === 'started') {
        setState({
          status: 'running',
          startedAt: Date.now(),
          completedAt: null,
        });
      } else {
        setState((prev) => ({
          status: event.passed ? 'completed' : event.error ? 'failed' : prev.status === 'running' ? 'completed' : prev.status,
          startedAt: prev.startedAt,
          completedAt: Date.now(),
          passed: event.passed,
          score: event.score,
          skillName: event.skillName,
          feedback: event.feedback,
          error: event.error,
        }));
      }
    });
    return unsubscribe;
  }, [sessionId]);

  return state;
}
