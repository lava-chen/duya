import React, { useState } from 'react';
import { useUsageData } from '@/hooks/useUsageData';
import { useTranslation } from '@/hooks/useTranslation';
import { UsageSummaryGrid } from './UsageSummaryGrid';
import { DailyTokenChart } from './DailyTokenChart';
import { UsageHeatmap } from './UsageHeatmap';
import { ModelUsageDonut } from './ModelUsageDonut';
import { SessionList } from './SessionList';
import { ProviderQuotaView } from './ProviderQuotaView';
import { ChartBarIcon, ArrowUpRightIcon, DownloadSimpleIcon, ArrowClockwiseIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';

export const UsageDashboard: React.FC = () => {
  const { t } = useTranslation();
  const { data, loading, refreshing, error, refresh } = useUsageData();
  const [isExporting, setIsExporting] = useState(false);
  const [view, setView] = useState<'stats' | 'quota'>('stats');

  const handleExport = () => {
    if (!data) return;
    setIsExporting(true);
    try {
      const exportData = {
        generatedAt: data.generatedAt,
        totals: data.totals,
        aggregates: data.aggregates,
        dailyData: data.dailyData,
        sessions: data.sessions.map((s) => ({
          id: s.id,
          title: s.title,
          model: s.model,
          totalTokens: s.totalTokens,
          totalCost: s.totalCost,
          messageCount: s.messageCount,
          toolCallCount: s.toolCallCount,
          errorCount: s.errorCount,
          createdAt: s.createdAt,
        })),
      };

      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `duya-usage-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } finally {
      setIsExporting(false);
    }
  };

  if (view === 'quota') {
    return <ProviderQuotaView onBack={() => setView('stats')} />;
  }

  const hasData = !!data && data.aggregates.messages.total > 0;

  return (
    <div className="w-full max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-[var(--text)] font-[family-name:--font-copernicus]">
            {t('usage.title')}
          </h2>
          <p className="text-sm text-[var(--muted)]">{t('usage.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading || refreshing}
          >
            <ArrowClockwiseIcon size={14} className={refreshing ? 'animate-spin' : undefined} />
            {refreshing ? t('usage.refreshing') : t('usage.refresh')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleExport}
            disabled={isExporting || !hasData}
          >
            <DownloadSimpleIcon size={14} />
            {t('usage.export')}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-[var(--error)]/40 bg-[var(--error)]/5 p-4 text-sm text-[var(--error)]">
          {t('usage.loadFailed')}: {error}
        </div>
      )}

      {loading ? (
        <div className="rounded-xl border border-[var(--border)] bg-gradient-to-b from-[var(--surface)] to-[var(--bg-canvas)] p-12 text-center text-sm text-[var(--muted)]">
          {t('common.loading')}
        </div>
      ) : !hasData ? (
        <div className="rounded-xl border border-[var(--border)] bg-gradient-to-b from-[var(--surface)] to-[var(--bg-canvas)] p-12 text-center">
          <div className="w-16 h-16 rounded-full bg-[var(--surface)] flex items-center justify-center mx-auto mb-4">
            <ChartBarIcon size={32} className="text-[var(--muted)]" />
          </div>
          <h3 className="text-lg font-semibold text-[var(--text)] mb-2">{t('usage.noData')}</h3>
          <p className="text-sm text-[var(--muted)] max-w-md mx-auto">
            {t('usage.noDataDesc')}
          </p>
        </div>
      ) : data ? (
        <>
          {/* Summary Stats */}
          <UsageSummaryGrid summary={data} />

          {/* Provider Quota Entry */}
          <button
            type="button"
            onClick={() => setView('quota')}
            className="w-full group flex items-center gap-4 p-4 rounded-xl border border-dashed border-[var(--border)] bg-gradient-to-r from-[var(--surface)] to-[var(--bg-canvas)] hover:border-[var(--accent-soft)] hover:from-[var(--accent)]/5 transition-all duration-200 text-left"
          >
            <div className="shrink-0 w-10 h-10 rounded-lg bg-[var(--accent)]/10 text-[var(--accent)] flex items-center justify-center group-hover:scale-105 transition-transform">
              <ChartBarIcon size={20} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-[var(--text)]">{t('usage.providerQuota')}</div>
              <div className="text-xs text-[var(--muted)] mt-0.5">
                {t('usage.providerQuotaDesc')}
              </div>
            </div>
            <ArrowUpRightIcon size={16} className="text-[var(--muted)] group-hover:text-[var(--accent)] transition-colors" />
          </button>

          {/* Charts Row */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2">
              <DailyTokenChart dailyData={data.dailyData} modelUsage={data.modelUsage} />
            </div>
            <div>
              <ModelUsageDonut modelUsage={data.modelUsage} totalTokens={data.totals.totalTokens} />
            </div>
          </div>

          {/* Heatmap */}
          <UsageHeatmap data={data.dailyData.map((d) => ({ date: d.date, value: d.tokens }))} />

          {/* Sessions */}
          <SessionList sessions={data.sessions} />
        </>
      ) : null}
    </div>
  );
};
