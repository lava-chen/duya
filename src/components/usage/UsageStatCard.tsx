import React from 'react';
import type { UsageStatCardData } from '@/types/usage';
import { formatNumber, formatCurrency, formatPercent, formatDuration } from '@/hooks/useUsageData';

interface UsageStatCardProps {
  data: UsageStatCardData;
}

function getStatusColor(status?: string): string {
  switch (status) {
    case 'good':
      return 'text-[var(--success)]';
    case 'warn':
      return 'text-[var(--warning)]';
    case 'bad':
      return 'text-[var(--error)]';
    default:
      return 'text-[var(--text)]';
  }
}

function getStatusBg(status?: string): string {
  switch (status) {
    case 'good':
      return 'bg-[var(--success)]/10 border-[var(--success)]/20';
    case 'warn':
      return 'bg-[var(--warning)]/10 border-[var(--warning)]/20';
    case 'bad':
      return 'bg-[var(--error)]/10 border-[var(--error)]/20';
    default:
      return 'bg-gradient-to-b from-[var(--surface)] to-[var(--bg-canvas)] border-[var(--border)]';
  }
}

function formatValue(value: string | number, format?: string): string {
  if (typeof value === 'string') return value;
  switch (format) {
    case 'currency':
      return formatCurrency(value);
    case 'percent':
      return formatPercent(value);
    case 'duration':
      return formatDuration(value);
    case 'number':
    default:
      return formatNumber(value);
  }
}

export const UsageStatCard: React.FC<UsageStatCardProps> = ({ data }) => {
  return (
    <div
      className={`rounded-xl border p-4 transition-all duration-200 hover:shadow-md ${getStatusBg(data.status)}`}
    >
      <div className="text-[11px] uppercase tracking-wider text-[var(--muted)] font-semibold">
        {data.label}
      </div>
      <div
        className={`text-2xl font-bold mt-2 font-[family-name:--font-copernicus] ${getStatusColor(data.status)}`}
      >
        {formatValue(data.value, data.format)}
      </div>
      {data.subtext && (
        <div className="text-xs text-[var(--muted)] mt-1 leading-relaxed">{data.subtext}</div>
      )}
    </div>
  );
};
