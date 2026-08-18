import React from 'react';
import type { UsageSummary, UsageStatCardData } from '@/types/usage';
import { UsageStatCard } from './UsageStatCard';
import { useTranslation } from '@/hooks/useTranslation';
import { formatNumber, formatCurrency, formatPercent } from '@/hooks/useUsageData';

interface UsageSummaryGridProps {
  summary: UsageSummary;
}

export const UsageSummaryGrid: React.FC<UsageSummaryGridProps> = ({ summary }) => {
  const { t } = useTranslation();
  const { totals, aggregates, modelUsage } = summary;

  const topModel = (modelUsage ?? [])[0];
  const inputOutputText = `${formatNumber(totals.input)} ${t('usage.input')} · ${formatNumber(totals.output)} ${t('usage.output')}`;
  const costSuffix = totals.costEstimated ? ` · ${t('usage.costEstimated')}` : '';

  const cards: UsageStatCardData[] = [
    {
      label: t('usage.tokenUsage'),
      value: totals.totalTokens,
      format: 'number',
      subtext: inputOutputText,
      status: 'neutral',
    },
    {
      label: t('usage.totalCost'),
      value: totals.totalCost,
      format: 'currency',
      subtext: `${formatCurrency(totals.inputCost)} ${t('usage.input')} · ${formatCurrency(totals.outputCost)} ${t('usage.output')}${costSuffix}`,
      status: 'neutral',
    },
    {
      label: t('usage.sessionCount'),
      value: aggregates.sessionCount,
      format: 'number',
      subtext: `${aggregates.activeDays} ${t('usage.activeDays')}`,
      status: 'neutral',
    },
    {
      label: t('usage.messageCount'),
      value: aggregates.messages.total,
      format: 'number',
      subtext: `${aggregates.messages.user} ${t('usage.user')} · ${aggregates.messages.assistant} ${t('usage.assistant')}`,
      status: 'neutral',
    },
    {
      label: t('usage.activeDaysLabel'),
      value: aggregates.activeDays,
      format: 'number',
      subtext: `${aggregates.currentStreak} ${t('usage.currentStreak')}`,
      status: aggregates.currentStreak > 0 ? 'good' : 'neutral',
    },
    {
      label: t('usage.throughput'),
      value:
        totals.totalTokens && aggregates.durationSumMs > 0
          ? totals.totalTokens / (aggregates.durationSumMs / 60000)
          : 0,
      format: 'number',
      subtext: t('usage.tokensPerMinute'),
      status: 'neutral',
    },
    {
      label: t('usage.topModel'),
      value: topModel?.model ?? t('usage.unknownModel'),
      format: 'text',
      subtext: topModel ? t('usage.topModelShare', { percent: formatPercent(topModel.percentage) }) : undefined,
      status: topModel ? 'good' : 'neutral',
    },
    {
      label: t('usage.toolCalls'),
      value: aggregates.tools.totalCalls,
      format: 'number',
      subtext: `${aggregates.tools.uniqueTools} ${t('usage.uniqueTools')}`,
      status: aggregates.tools.totalCalls > 0 ? 'good' : 'neutral',
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
      {cards.map((card) => (
        <UsageStatCard key={card.label} data={card} />
      ))}
    </div>
  );
};