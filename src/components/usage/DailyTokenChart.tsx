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

  // Use sqrt scaling to make small values more visible
  const { maxTotalValue, maxSegmentValue, getScaledHeight } = useMemo(() => {
    if (chartData.length === 0) {
      return { maxTotalValue: 1, maxSegmentValue: 1, getScaledHeight: (v: number) => v };
    }

    const totalValues = chartData.map((d) => d.totalValue);
    const allSegments = chartData.flatMap((d) => [
      d.segments.input,
      d.segments.output,
      d.segments.cacheRead,
      d.segments.cacheWrite,
    ]);

    const maxTotal = Math.max(...totalValues, 1);
    const maxSegment = Math.max(...allSegments, 1);
    const sqrtMaxTotal = Math.sqrt(maxTotal);
    const sqrtMaxSegment = Math.sqrt(maxSegment);

    return {
      maxTotalValue: maxTotal,
      maxSegmentValue: maxSegment,
      getScaledHeight: (value: number, isSegment = false) => {
        if (value <= 0) return 0;
        // Use sqrt scaling: small values become more visible
        const sqrtMax = isSegment ? sqrtMaxSegment : sqrtMaxTotal;
        const scaled = (Math.sqrt(value) / sqrtMax) * 100;
        return Math.max(scaled, 4); // Minimum 4% height for non-zero values
      },
    };
  }, [chartData]);

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
              const barHeight = getScaledHeight(entry.totalValue);
              const isHovered = hoveredIndex === index;

              // Calculate bar width: flex-1 when few items, fixed width when many
              const barWidth = chartData.length <= 30 ? 'flex-1' : '12px';

              if (stackMode === 'total') {
                return (
                  <div
                    key={entry.date}
                    className={`flex flex-col justify-end group cursor-pointer h-full ${chartData.length <= 30 ? 'flex-1' : 'flex-shrink-0'}`}
                    style={{ width: chartData.length <= 30 ? undefined : '12px', maxWidth: '40px' }}
                    onMouseEnter={(e) => handleBarHover(index, e)}
                    onMouseMove={(e) => handleBarHover(index, e)}
                    onMouseLeave={handleBarLeave}
                  >
                    <div
                      className="w-full rounded-t transition-all duration-200"
                      style={{
                        height: `${barHeight}%`,
                        backgroundColor: 'var(--accent)',
                        opacity: isHovered ? 1 : 0.7,
                        minHeight: entry.totalValue > 0 ? '4px' : '0',
                      }}
                    />
                  </div>
                );
              }

              // Stacked breakdown - scale segments relative to max segment value
              const segmentKeys = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
              return (
                <div
                  key={entry.date}
                  className={`flex flex-col justify-end group cursor-pointer h-full ${chartData.length <= 30 ? 'flex-1' : 'flex-shrink-0'}`}
                  style={{ width: chartData.length <= 30 ? undefined : '12px', maxWidth: '40px' }}
                  onMouseEnter={(e) => handleBarHover(index, e)}
                  onMouseMove={(e) => handleBarHover(index, e)}
                  onMouseLeave={handleBarLeave}
                >
                  <div className="w-full flex flex-col-reverse rounded-t overflow-hidden" style={{ height: `${getScaledHeight(entry.totalValue)}%` }}>
                    {segmentKeys.map((key) => {
                      const segmentValue = entry.segments[key];
                      const segmentRatio = entry.totalValue > 0 ? segmentValue / entry.totalValue : 0;
                      return (
                        <div
                          key={key}
                          className="w-full transition-all duration-200"
                          style={{
                            height: `${segmentRatio * 100}%`,
                            backgroundColor: SEGMENT_COLORS[key],
                            opacity: isHovered ? 1 : 0.8,
                            minHeight: segmentValue > 0 ? '1px' : '0',
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
