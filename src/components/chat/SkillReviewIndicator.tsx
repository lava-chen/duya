/**
 * SkillReviewIndicator - Small non-blocking UI element that shows
 * when the SelfImprover is reviewing the conversation for skill
 * candidates, and surfaces the result when the review completes.
 *
 * The component is intentionally minimal — just a badge that
 * appears below the input box. We don't interrupt the user's
 * current task; the review runs in the background and the badge
 * is a courtesy notification.
 */

import { useContext, useEffect, useState } from 'react';
import { useSkillReview } from '@/hooks/useSkillReview';
import { I18nContext } from '@/components/layout/I18nProvider';

export interface SkillReviewIndicatorProps {
  sessionId: string | null | undefined;
  /** Auto-hide the success/failure toast after this many ms. Default 6000. */
  autoHideMs?: number;
}

export function SkillReviewIndicator({
  sessionId,
  autoHideMs = 6000,
}: SkillReviewIndicatorProps) {
  const review = useSkillReview(sessionId);
  const { t } = useContext(I18nContext);
  const [dismissed, setDismissed] = useState(false);

  // Reset the dismissed flag when a new review starts.
  useEffect(() => {
    if (review.status === 'running') {
      setDismissed(false);
    }
  }, [review.status, review.startedAt]);

  // Auto-hide completed reviews after a delay.
  useEffect(() => {
    if (review.status !== 'completed' && review.status !== 'failed') return;
    const handle = setTimeout(() => setDismissed(true), autoHideMs);
    return () => clearTimeout(handle);
  }, [review.status, review.completedAt, autoHideMs]);

  if (review.status === 'idle' || dismissed) return null;

  if (review.status === 'running') {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mb-2 flex items-center gap-2 rounded-md border border-blue-300/40 bg-blue-50/60 px-3 py-1.5 text-xs text-blue-700 dark:border-blue-700/40 dark:bg-blue-950/30 dark:text-blue-200"
      >
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500" />
        <span>{t('skillReview.running')}</span>
      </div>
    );
  }

  if (review.status === 'completed' && review.passed) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mb-2 flex items-center gap-2 rounded-md border border-emerald-300/40 bg-emerald-50/60 px-3 py-1.5 text-xs text-emerald-700 dark:border-emerald-700/40 dark:bg-emerald-950/30 dark:text-emerald-200"
      >
        <span aria-hidden>✓</span>
        <span>
          {review.skillName
            ? t('skillReview.completedNamed', { name: review.skillName })
            : t('skillReview.completed')}
        </span>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="ml-auto rounded p-0.5 text-emerald-700/60 hover:text-emerald-700 dark:text-emerald-200/60 dark:hover:text-emerald-200"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    );
  }

  // status === 'failed' OR completed && !passed
  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-2 flex items-center gap-2 rounded-md border border-amber-300/40 bg-amber-50/60 px-3 py-1.5 text-xs text-amber-700 dark:border-amber-700/40 dark:bg-amber-950/30 dark:text-amber-200"
    >
      <span aria-hidden>!</span>
      <span>
        {review.error
          ? t('skillReview.failed', { error: review.error })
          : t('skillReview.noImprovement')}
      </span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="ml-auto rounded p-0.5 text-amber-700/60 hover:text-amber-700 dark:text-amber-200/60 dark:hover:text-amber-200"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
