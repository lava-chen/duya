import React, { useState } from 'react';
import { useConversationStore } from '@/stores/conversation-store';
import { useUsageData } from '@/hooks/useUsageData';
import { useTranslation } from '@/hooks/useTranslation';
import type { UsageFilters } from '@/types/usage';
import { UsageSummaryGrid } from './UsageSummaryGrid';
import { DailyTokenChart } from './DailyTokenChart';
import { CostBreakdownBar } from './CostBreakdownBar';
import { UsageHeatmap } from './UsageHeatmap';
import { SessionList } from './SessionList';
import { BarChart3, RefreshCw, Download } from 'lucide-react';

export const UsageDashboard: React.FC = () => {
  const { t } = useTranslation();
  const threads = useConversationStore((s) => s.threads);
  const messages = useConversationStore((s) => s.messages);
  const [filters, setFilters] = useState<UsageFilters>({});
  const [isExporting, setIsExporting] = useState(false);

  const metrics = useUsageData({ messages, threads, filters });

  const handleExport = () => {
    setIsExporting(true);
    try {
      const exportData = {
        generatedAt: new Date().toISOString(),
        filters,
        totals: metrics.totals,
        aggregates: metrics.aggregates,
        dailyData: metrics.dailyData,
        sessions: metrics.sessions.map((s) => ({
          id: s.id,
          title: s.title,
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

  const hasData = metrics.aggregates.messages.total > 0;

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
          <button
            onClick={handleExport}
            disabled={isExporting || !hasData}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[var(--border)] text-xs font-medium text-[var(--muted)] hover:text-[var(--text)] hover:border-[var(--accent-soft)] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download className="w-3.5 h-3.5" />
            {t('usage.export')}
          </button>
        </div>
      </div>

      {!hasData ? (
        <div className="rounded-xl border border-[var(--border)] bg-gradient-to-b from-[var(--surface)] to-[var(--bg-canvas)] p-12 text-center">
          <div className="w-16 h-16 rounded-full bg-[var(--surface)] flex items-center justify-center mx-auto mb-4">
            <BarChart3 className="w-8 h-8 text-[var(--muted)]" />
          </div>
          <h3 className="text-lg font-semibold text-[var(--text)] mb-2">{t('usage.noData')}</h3>
          <p className="text-sm text-[var(--muted)] max-w-md mx-auto">
            {t('usage.noDataDesc')}
          </p>
        </div>
      ) : (
        <>
          {/* Summary Stats */}
          <UsageSummaryGrid metrics={metrics} />

          {/* Charts Row */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2">
              <DailyTokenChart data={metrics.dailyData} />
            </div>
            <div>
              <CostBreakdownBar totals={metrics.totals} />
            </div>
          </div>

          {/* Heatmap */}
          <UsageHeatmap data={metrics.heatmapData} />

          {/* Sessions */}
          <SessionList sessions={metrics.sessions} />
        </>
      )}
    </div>
  );
};
