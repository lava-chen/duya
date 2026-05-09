import React from 'react';
import type { UsageSummaryMetrics } from '@/types/usage';
import type { UsageStatCardData } from '@/types/usage';
import { UsageStatCard } from './UsageStatCard';
import { useTranslation } from '@/hooks/useTranslation';
import { formatNumber, formatCurrency, formatPercent } from '@/hooks/useUsageData';

interface UsageSummaryGridProps {
  metrics: UsageSummaryMetrics;
}

export const UsageSummaryGrid: React.FC<UsageSummaryGridProps> = ({ metrics }) => {
  const { t } = useTranslation();
  const { totals, aggregates } = metrics;

  const cacheBase = totals.input + totals.cacheRead + totals.cacheWrite;
  const cacheHitRate = cacheBase > 0 ? totals.cacheRead / cacheBase : 0;

  const errorRate = aggregates.messages.total
    ? aggregates.messages.errors / aggregates.messages.total
    : 0;

  const avgTokens = aggregates.messages.total
    ? Math.round(totals.totalTokens / aggregates.messages.total)
    : 0;

  const throughputTokensPerMin =
    totals.totalTokens && aggregates.durationSumMs > 0
      ? totals.totalTokens / (aggregates.durationSumMs / 60000)
      : 0;

  const cards: UsageStatCardData[] = [
    {
      label: t('usage.totalTokens'),
      value: totals.totalTokens,
      format: 'number',
      subtext: `${formatNumber(totals.input)} ${t('usage.input')} · ${formatNumber(totals.output)} ${t('usage.output')}`,
      status: 'neutral',
    },
    {
      label: t('usage.totalCost'),
      value: totals.totalCost,
      format: 'currency',
      subtext: `${formatCurrency(totals.inputCost)} ${t('usage.input')} · ${formatCurrency(totals.outputCost)} ${t('usage.output')}`,
      status: 'neutral',
    },
    {
      label: t('usage.messages'),
      value: aggregates.messages.total,
      format: 'number',
      subtext: `${aggregates.messages.user} ${t('usage.user')} · ${aggregates.messages.assistant} ${t('usage.assistant')}`,
      status: 'neutral',
    },
    {
      label: t('usage.toolCalls'),
      value: aggregates.tools.totalCalls,
      format: 'number',
      subtext: `${aggregates.tools.uniqueTools} ${t('usage.uniqueTools')}`,
      status: aggregates.tools.totalCalls > 0 ? 'good' : 'neutral',
    },
    {
      label: t('usage.avgTokens'),
      value: avgTokens,
      format: 'number',
      subtext: t('usage.perMessage'),
      status: 'neutral',
    },
    {
      label: t('usage.cacheHitRate'),
      value: cacheHitRate,
      format: 'percent',
      subtext: `${formatNumber(totals.cacheRead)} ${t('usage.cached')} · ${formatNumber(cacheBase)} ${t('usage.total')}`,
      status: cacheHitRate > 0.6 ? 'good' : cacheHitRate > 0.3 ? 'warn' : 'neutral',
    },
    {
      label: t('usage.errorRate'),
      value: errorRate,
      format: 'percent',
      subtext: `${aggregates.messages.errors} ${t('usage.errors')} · ${aggregates.messages.total} ${t('usage.total')}`,
      status: errorRate > 0.05 ? 'bad' : errorRate > 0.01 ? 'warn' : 'good',
    },
    {
      label: t('usage.throughput'),
      value: throughputTokensPerMin,
      format: 'number',
      subtext: t('usage.tokensPerMinute'),
      status: 'neutral',
    },
    {
      label: t('usage.sessions'),
      value: aggregates.sessionCount,
      format: 'number',
      subtext: `${aggregates.activeDays} ${t('usage.activeDays')}`,
      status: 'neutral',
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
      {cards.map((card) => (
        <UsageStatCard key={card.label} data={card} />
      ))}
    </div>
  );
};
