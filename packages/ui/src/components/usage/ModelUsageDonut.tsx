import React, { useState, useMemo } from 'react';
import type { ModelUsageEntry } from '@/types/usage';
import { MODEL_PALETTE } from '@/types/usage';
import { useTranslation } from '@/hooks/useTranslation';
import { formatCurrency, formatNumber } from '@/hooks/useUsageData';

interface ModelUsageDonutProps {
  modelUsage: ModelUsageEntry[];
  totalTokens: number;
}

export const ModelUsageDonut: React.FC<ModelUsageDonutProps> = ({ modelUsage, totalTokens }) => {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState<number | null>(null);

  const list = modelUsage ?? [];

  const total = useMemo(
    () => (totalTokens > 0 ? totalTokens : list.reduce((sum, d) => sum + d.tokens, 0)),
    [totalTokens, list],
  );

  if (list.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-gradient-to-b from-[var(--surface)] to-[var(--bg-canvas)] p-4">
        <h3 className="text-sm font-semibold text-[var(--text)] mb-3">{t('usage.modelUsage')}</h3>
        <div className="h-48 flex items-center justify-center text-sm text-[var(--muted)]">
          {t('usage.noDataAvailable')}
        </div>
      </div>
    );
  }

  const topModels = list.slice(0, 5);
  const radius = 60;
  const stroke = 16;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  // Circle segments progress from 12 o'clock clockwise.
  const segments = topModels.map((entry) => {
    const fraction = entry.percentage;
    const segLen = fraction * circumference;
    const seg = { ...entry, segLen, offset };
    offset += segLen;
    return seg;
  });

  return (
    <div className="rounded-xl border border-[var(--border)] bg-gradient-to-b from-[var(--surface)] to-[var(--bg-canvas)] p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-[var(--text)]">{t('usage.modelUsage')}</h3>
        <span className="text-xs text-[var(--muted)]">{formatNumber(total)} {t('usage.tokens')}</span>
      </div>

      <div className="flex flex-col sm:flex-row items-center gap-5">
        {/* Donut */}
        <div className="relative shrink-0">
          <svg width="150" height="150" viewBox="0 0 150 150" className="rotate-[-90deg]">
            <circle
              cx="75"
              cy="75"
              r={radius}
              fill="none"
              stroke="var(--surface)"
              strokeWidth={stroke}
            />
            {segments.map((seg) => (
              <circle
                key={seg.model}
                cx="75"
                cy="75"
                r={radius}
                fill="none"
                stroke={MODEL_PALETTE[seg.colorIndex % MODEL_PALETTE.length]}
                strokeWidth={stroke}
                strokeDasharray={`${seg.segLen} ${circumference - seg.segLen}`}
                strokeDashoffset={-seg.offset}
                strokeLinecap="butt"
                style={{ opacity: hovered === null || hovered === seg.colorIndex ? 1 : 0.35, transition: 'opacity 0.15s' }}
                onMouseEnter={() => setHovered(seg.colorIndex)}
                onMouseLeave={() => setHovered(null)}
              />
            ))}
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <span className="text-xl font-bold text-[var(--text)] font-[family-name:--font-copernicus]">
              {list.length}
            </span>
            <span className="text-[11px] text-[var(--muted)]">{t('usage.modelCountShort')}</span>
          </div>
        </div>

        {/* Legend list */}
        <div className="flex-1 w-full min-w-0 space-y-1.5 overflow-hidden">
          {list.slice(0, 6).map((entry) => {
            const color = MODEL_PALETTE[entry.colorIndex % MODEL_PALETTE.length];
            const isActive = hovered === null || hovered === entry.colorIndex;
            return (
              <div
                key={entry.model}
                className="flex items-center gap-2 rounded-md px-1.5 py-1 cursor-pointer"
                style={{ opacity: isActive ? 1 : 0.35, transition: 'opacity 0.15s' }}
                onMouseEnter={() => setHovered(entry.colorIndex)}
                onMouseLeave={() => setHovered(null)}
              >
                <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                <span className="text-[11px] font-medium text-[var(--text)] shrink-0 w-9 text-right tabular-nums">
                  {(entry.percentage * 100).toFixed(1)}%
                </span>
                <span className="text-[11px] text-[var(--muted)] shrink-0 w-11 text-right tabular-nums">
                  {formatNumber(entry.tokens)}
                </span>
                <span className="text-[11px] text-[var(--muted)] shrink-0 w-9 text-right tabular-nums hidden sm:inline">
                  {formatCurrency(entry.cost)}
                </span>
                <span className="flex-1 min-w-0 truncate text-[12px] text-[var(--muted)]" title={entry.model}>
                  {entry.model}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};