// Top-level chrome helpers — the small live-duration + summary pieces
// the ToolActionsGroup header renders. Hoisted out so the parent
// component doesn't carry React.memo wrappers and the 1s interval.

'use client';

import React, { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';

export function formatDuration(ms: number): string {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds.toFixed(0)}s`;
  }
  return `${seconds.toFixed(1)}s`;
}

export const LiveDurationText = React.memo(function LiveDurationText({
  startedAt,
}: {
  startedAt: number;
}) {
  const [durationMs, setDurationMs] = useState(() => Math.max(0, Date.now() - startedAt));

  React.useEffect(() => {
    const tick = () => setDurationMs(Math.max(0, Date.now() - startedAt));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  return <>{formatDuration(durationMs)}</>;
});

export const DurationSummaryText = React.memo(function DurationSummaryText({
  totalDurationMs,
  liveStartedAt,
}: {
  totalDurationMs: number;
  liveStartedAt?: number | null;
}) {
  const { t } = useTranslation();

  if (liveStartedAt) {
    return (
      <>
        {', '}
        {t('streaming.actions.workedFor', { duration: '' }).trimEnd()}
        {' '}
        <LiveDurationText startedAt={liveStartedAt} />
      </>
    );
  }

  if (totalDurationMs <= 0) return null;
  return <>{`, ${t('streaming.actions.workedFor', { duration: formatDuration(totalDurationMs) })}`}</>;
});
