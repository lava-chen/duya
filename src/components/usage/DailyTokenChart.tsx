import React, { useState, useMemo, useCallback } from 'react';
import type { DailyUsageEntry } from '@/types/usage';
import type { ChartMode, ChartStackMode } from '@/types/usage';
import { useTranslation } from '@/hooks/useTranslation';
import { formatNumber, formatCurrency } from '@/hooks/useUsageData';

interface DailyTokenChartProps {
  data: DailyUsageEntry[];
}

const SEGMENT_COLORS = {
  input: 'var(--accent)',
  output: 'var(--success)',
  cacheRead: '#3b82f6',
  cacheWrite: 'var(--warning)',
};

export const DailyTokenChart: React.FC<DailyTokenChartProps> = ({ data }) => {
  const { t } = useTranslation();
  const [mode, setMode] = useState<ChartMode>('tokens');
  const [stackMode, setStackMode] = useState<ChartStackMode>('total');
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    entry: DailyUsageEntry;
  } | null>(null);

  const SEGMENT_LABELS = {
    input: t('usage.inputTokens'),
    output: t('usage.outputTokens'),
    cacheRead: t('usage.cacheRead'),
    cacheWrite: t('usage.cacheWrite'),
  };

  const chartData = useMemo(() => {
    if (data.length === 0) return [];

    return data.map((entry) => ({
      ...entry,
      totalValue: mode === 'tokens' ? entry.tokens : entry.cost,
      segments: {
        input: mode === 'tokens' ? entry.input : entry.inputCost,
        output: mode === 'tokens' ? entry.output : entry.outputCost,
        cacheRead: mode === 'tokens' ? entry.cacheRead : entry.cacheReadCost,
        cacheWrite: mode === 'tokens' ? entry.cacheWrite : entry.cacheWriteCost,
      },
    }));
  }, [data, mode]);

  const maxValue = useMemo(() => {
    if (chartData.length === 0) return 1;
    if (stackMode === 'total') {
      return Math.max(...chartData.map((d) => d.totalValue), 1);
    }
    return Math.max(
      ...chartData.flatMap((d) => [
        d.segments.input,
        d.segments.output,
        d.segments.cacheRead,
        d.segments.cacheWrite,
      ]),
      1
    );
  }, [chartData, stackMode]);

  const handleBarHover = useCallback(
    (index: number, event: React.MouseEvent) => {
      setHoveredIndex(index);
      const entry = data[index];
      if (entry) {
        setTooltip({
          x: event.clientX,
          y: event.clientY,
          entry,
        });
      }
    },
    [data]
  );

  const handleBarLeave = useCallback(() => {
    setHoveredIndex(null);
    setTooltip(null);
  }, []);

  const formatValue = mode === 'tokens' ? formatNumber : formatCurrency;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-gradient-to-b from-[var(--surface)] to-[var(--bg-canvas)] p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-[var(--text)]">{t('usage.dailyUsage')}</h3>
        <div className="flex gap-2">
          <div className="flex rounded-lg border border-[var(--border)] overflow-hidden">
            <button
              onClick={() => setMode('tokens')}
              className={`px-3 py-1 text-xs font-medium transition-colors ${
                mode === 'tokens'
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--muted)] hover:text-[var(--text)]'
              }`}
            >
              {t('usage.tokens')}
            </button>
            <button
              onClick={() => setMode('cost')}
              className={`px-3 py-1 text-xs font-medium transition-colors ${
                mode === 'cost'
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--muted)] hover:text-[var(--text)]'
              }`}
            >
              {t('usage.cost')}
            </button>
          </div>
          <div className="flex rounded-lg border border-[var(--border)] overflow-hidden">
            <button
              onClick={() => setStackMode('total')}
              className={`px-3 py-1 text-xs font-medium transition-colors ${
                stackMode === 'total'
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--muted)] hover:text-[var(--text)]'
              }`}
            >
              {t('usage.totalBtn')}
            </button>
            <button
              onClick={() => setStackMode('breakdown')}
              className={`px-3 py-1 text-xs font-medium transition-colors ${
                stackMode === 'breakdown'
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--muted)] hover:text-[var(--text)]'
              }`}
            >
              {t('usage.breakdown')}
            </button>
          </div>
        </div>
      </div>

      {chartData.length === 0 ? (
        <div className="h-48 flex items-center justify-center text-sm text-[var(--muted)]">
          {t('usage.noDataAvailable')}
        </div>
      ) : (
        <>
          <div className="flex items-end gap-1 h-48 px-2">
            {chartData.map((entry, index) => {
              const barHeight = maxValue > 0 ? (entry.totalValue / maxValue) * 100 : 0;
              const isHovered = hoveredIndex === index;

              if (stackMode === 'total') {
                return (
                  <div
                    key={entry.date}
                    className="flex-1 flex flex-col justify-end group cursor-pointer"
                    onMouseEnter={(e) => handleBarHover(index, e)}
                    onMouseMove={(e) => handleBarHover(index, e)}
                    onMouseLeave={handleBarLeave}
                  >
                    <div
                      className="w-full rounded-t transition-all duration-200"
                      style={{
                        height: `${Math.max(barHeight, 1)}%`,
                        backgroundColor: 'var(--accent)',
                        opacity: isHovered ? 1 : 0.7,
                        minHeight: '2px',
                      }}
                    />
                  </div>
                );
              }

              // Stacked breakdown
              const segmentKeys = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
              return (
                <div
                  key={entry.date}
                  className="flex-1 flex flex-col justify-end group cursor-pointer"
                  onMouseEnter={(e) => handleBarHover(index, e)}
                  onMouseMove={(e) => handleBarHover(index, e)}
                  onMouseLeave={handleBarLeave}
                >
                  <div className="w-full flex flex-col-reverse rounded-t overflow-hidden">
                    {segmentKeys.map((key) => {
                      const segmentValue = entry.segments[key];
                      const segmentHeight =
                        maxValue > 0 ? (segmentValue / maxValue) * 100 : 0;
                      return (
                        <div
                          key={key}
                          className="w-full transition-all duration-200"
                          style={{
                            height: `${Math.max(segmentHeight, 0.5)}%`,
                            backgroundColor: SEGMENT_COLORS[key],
                            opacity: isHovered ? 1 : 0.8,
                            minHeight: '1px',
                          }}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex justify-between mt-2 px-2">
            <span className="text-[10px] text-[var(--muted)]">
              {chartData[0]?.date}
            </span>
            <span className="text-[10px] text-[var(--muted)]">
              {chartData[chartData.length - 1]?.date}
            </span>
          </div>

          {stackMode === 'breakdown' && (
            <div className="flex flex-wrap gap-3 mt-3 pt-3 border-t border-[var(--border)]">
              {(Object.keys(SEGMENT_COLORS) as Array<keyof typeof SEGMENT_COLORS>).map((key) => (
                <div key={key} className="flex items-center gap-1.5">
                  <div
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: SEGMENT_COLORS[key] }}
                  />
                  <span className="text-[10px] text-[var(--muted)]">{SEGMENT_LABELS[key]}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tooltip && (
        <div
          className="fixed z-50 pointer-events-none bg-[var(--main-bg)] border border-[var(--border)] rounded-lg shadow-lg p-3 text-xs"
          style={{
            left: tooltip.x + 10,
            top: tooltip.y - 10,
          }}
        >
          <div className="font-semibold text-[var(--text)] mb-1">{tooltip.entry.date}</div>
          <div className="text-[var(--muted)]">
            {mode === 'tokens' ? (
              <>
                <div>{t('usage.totalBtn')}: {formatNumber(tooltip.entry.tokens)}</div>
                <div>{t('usage.inputTokens')}: {formatNumber(tooltip.entry.input)}</div>
                <div>{t('usage.outputTokens')}: {formatNumber(tooltip.entry.output)}</div>
                <div>{t('usage.cacheRead')}: {formatNumber(tooltip.entry.cacheRead)}</div>
                <div>{t('usage.cacheWrite')}: {formatNumber(tooltip.entry.cacheWrite)}</div>
              </>
            ) : (
              <>
                <div>{t('usage.totalBtn')}: {formatCurrency(tooltip.entry.cost)}</div>
                <div>{t('usage.inputTokens')}: {formatCurrency(tooltip.entry.inputCost)}</div>
                <div>{t('usage.outputTokens')}: {formatCurrency(tooltip.entry.outputCost)}</div>
                <div>{t('usage.cacheRead')}: {formatCurrency(tooltip.entry.cacheReadCost)}</div>
                <div>{t('usage.cacheWrite')}: {formatCurrency(tooltip.entry.cacheWriteCost)}</div>
              </>
            )}
            <div className="mt-1 pt-1 border-t border-[var(--border)]">
              {tooltip.entry.messageCount} {t('usage.messagesShort')} · {tooltip.entry.sessionCount} {t('usage.sessionsShort')}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
