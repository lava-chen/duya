import React from 'react';
import type { UsageTotals } from '@/types/usage';
import { useTranslation } from '@/hooks/useTranslation';
import { formatCurrency, formatNumber } from '@/hooks/useUsageData';

interface CostBreakdownBarProps {
  totals: UsageTotals;
}

interface Segment {
  key: string;
  label: string;
  value: number;
  color: string;
}

export const CostBreakdownBar: React.FC<CostBreakdownBarProps> = ({ totals }) => {
  const { t } = useTranslation();
  const segments: Segment[] = [
    {
      key: 'output',
      label: t('usage.outputTokens'),
      value: totals.outputCost,
      color: 'var(--accent)',
    },
    {
      key: 'input',
      label: t('usage.inputTokens'),
      value: totals.inputCost,
      color: 'var(--success)',
    },
    {
      key: 'cacheWrite',
      label: t('usage.cacheWrite'),
      value: totals.cacheWriteCost,
      color: 'var(--warning)',
    },
    {
      key: 'cacheRead',
      label: t('usage.cacheRead'),
      value: totals.cacheReadCost,
      color: '#3b82f6',
    },
  ];

  const totalCost = segments.reduce((sum, s) => sum + s.value, 0);

  if (totalCost === 0) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-gradient-to-b from-[var(--surface)] to-[var(--bg-canvas)] p-4">
        <h3 className="text-sm font-semibold text-[var(--text)] mb-3">{t('usage.costBreakdown')}</h3>
        <div className="h-8 w-full rounded-full bg-[var(--surface)]" />
        <div className="flex justify-center mt-4 text-sm text-[var(--muted)]">{t('usage.noCostData')}</div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-gradient-to-b from-[var(--surface)] to-[var(--bg-canvas)] p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-[var(--text)]">{t('usage.costBreakdown')}</h3>
        <span className="text-xs text-[var(--muted)]">{formatCurrency(totalCost)} {t('usage.totalBtn')}</span>
      </div>

      <div className="h-6 w-full rounded-full overflow-hidden flex bg-[var(--surface)]">
        {segments.map((segment) => {
          const percentage = totalCost > 0 ? (segment.value / totalCost) * 100 : 0;
          if (percentage < 0.1) return null;
          return (
            <div
              key={segment.key}
              className="h-full transition-all duration-300 hover:opacity-80"
              style={{
                width: `${percentage}%`,
                backgroundColor: segment.color,
                minWidth: '2px',
              }}
              title={`${segment.label}: ${formatCurrency(segment.value)} (${percentage.toFixed(1)}%)`}
            />
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-2 mt-3">
        {segments.map((segment) => {
          const percentage = totalCost > 0 ? (segment.value / totalCost) * 100 : 0;
          return (
            <div key={segment.key} className="flex items-center gap-2">
              <div
                className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: segment.color }}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-[var(--muted)] truncate">{segment.label}</span>
                  <span className="text-[11px] font-medium text-[var(--text)] ml-1">
                    {formatCurrency(segment.value)}
                  </span>
                </div>
                <div className="text-[10px] text-[var(--muted)]">{percentage.toFixed(1)}%</div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 pt-3 border-t border-[var(--border)]">
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div className="flex justify-between">
            <span className="text-[var(--muted)]">{t('usage.outputTokens')}:</span>
            <span className="text-[var(--text)] font-medium">{formatNumber(totals.output)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--muted)]">{t('usage.inputTokens')}:</span>
            <span className="text-[var(--text)] font-medium">{formatNumber(totals.input)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--muted)]">{t('usage.cacheReadTokens')}:</span>
            <span className="text-[var(--text)] font-medium">{formatNumber(totals.cacheRead)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--muted)]">{t('usage.cacheWriteTokens')}:</span>
            <span className="text-[var(--text)] font-medium">{formatNumber(totals.cacheWrite)}</span>
          </div>
        </div>
      </div>
    </div>
  );
};
