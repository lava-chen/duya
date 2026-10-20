import React, { useState, useMemo, useCallback } from 'react';
import type { DailyUsageEntry, ModelUsageEntry } from '@/types/usage';
import { MODEL_PALETTE, type ChartMode, type ChartStackMode } from '@/types/usage';
import { useTranslation } from '@/hooks/useTranslation';
import { formatNumber, formatCurrency } from '@/hooks/useUsageData';
import { Button } from '@/components/ui/Button';

interface DailyTokenChartProps {
  dailyData: DailyUsageEntry[];
  modelUsage?: ModelUsageEntry[];
}

const SEGMENT_COLORS = {
  input: 'var(--accent)',
  output: 'var(--success)',
  cacheRead: '#3b82f6',
  cacheWrite: 'var(--warning)',
};

// Filter out entries with obviously wrong dates (before 2020)
const MIN_VALID_YEAR = 2020;

export const DailyTokenChart: React.FC<DailyTokenChartProps> = ({ dailyData, modelUsage }) => {
  const { t } = useTranslation();
  const [mode, setMode] = useState<ChartMode>('tokens');
  const [stackMode, setStackMode] = useState<ChartStackMode>('total');
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    entry: DailyUsageEntry;
  } | null>(null);

  const days = (dailyData ?? []).filter((d) => {
    const year = parseInt(d.date.slice(0, 4), 10);
    return !isNaN(year) && year >= MIN_VALID_YEAR;
  });
  const models = modelUsage ?? [];

  const SEGMENT_LABELS = {
    input: t('usage.inputTokens'),
    output: t('usage.outputTokens'),
    cacheRead: t('usage.cacheRead'),
    cacheWrite: t('usage.cacheWrite'),
  };

  // Model id -> stable color, ordered by token volume (matches donut).
  const modelColorMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of models) {
      map.set(entry.model, MODEL_PALETTE[entry.colorIndex % MODEL_PALETTE.length]);
    }
    return map;
  }, [models]);

  const chartData = useMemo(() => {
    if (days.length === 0) return [];

    return days.map((entry) => ({
      ...entry,
      totalValue: mode === 'tokens' ? entry.tokens : entry.cost,
      segments: {
        input: mode === 'tokens' ? entry.input : entry.inputCost,
        output: mode === 'tokens' ? entry.output : entry.outputCost,
        cacheRead: mode === 'tokens' ? entry.cacheRead : entry.cacheReadCost,
        cacheWrite: mode === 'tokens' ? entry.cacheWrite : entry.cacheWriteCost,
      },
    }));
  }, [days, mode]);

  // Linear scaling
  const { maxTotalValue, getScaledHeight } = useMemo(() => {
    if (chartData.length === 0) {
      return { maxTotalValue: 1, getScaledHeight: (_v: number) => 0 };
    }

    const totalValues = chartData.map((d) => d.totalValue);
    const maxTotal = Math.max(...totalValues, 1);

    return {
      maxTotalValue: maxTotal,
      getScaledHeight: (value: number) => {
        if (value <= 0) return 0;
        return (value / maxTotal) * 100;
      },
    };
  }, [chartData]);

  const handleBarHover = useCallback(
    (index: number, event: React.MouseEvent) => {
      setHoveredIndex(index);
      const entry = days[index];
      if (entry) {
        setTooltip({
          x: event.clientX,
          y: event.clientY,
          entry,
        });
      }
    },
    [days]
  );

  const handleBarLeave = useCallback(() => {
    setHoveredIndex(null);
    setTooltip(null);
  }, []);

  return (
    <div className="rounded-xl border border-[var(--border)] bg-gradient-to-b from-[var(--surface)] to-[var(--bg-canvas)] p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-[var(--text)]">{t('usage.dailyUsage')}</h3>
        <div className="flex gap-2 flex-wrap">
          <div className="flex rounded-lg border border-[var(--border)] overflow-hidden">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMode('tokens')}
              className={`rounded-none px-3 py-1 ${
                mode === 'tokens'
                  ? 'bg-[var(--accent)] text-white hover:bg-[var(--accent)] hover:text-white'
                  : ''
              }`}
            >
              {t('usage.tokens')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMode('cost')}
              className={`rounded-none px-3 py-1 ${
                mode === 'cost'
                  ? 'bg-[var(--accent)] text-white hover:bg-[var(--accent)] hover:text-white'
                  : ''
              }`}
            >
              {t('usage.cost')}
            </Button>
          </div>
          <div className="flex rounded-lg border border-[var(--border)] overflow-hidden">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStackMode('total')}
              className={`rounded-none px-3 py-1 ${
                stackMode === 'total'
                  ? 'bg-[var(--accent)] text-white hover:bg-[var(--accent)] hover:text-white'
                  : ''
              }`}
            >
              {t('usage.totalBtn')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStackMode('breakdown')}
              className={`rounded-none px-3 py-1 ${
                stackMode === 'breakdown'
                  ? 'bg-[var(--accent)] text-white hover:bg-[var(--accent)] hover:text-white'
                  : ''
              }`}
            >
              {t('usage.breakdown')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStackMode('model')}
              className={`rounded-none px-3 py-1 ${
                stackMode === 'model'
                  ? 'bg-[var(--accent)] text-white hover:bg-[var(--accent)] hover:text-white'
                  : ''
              }`}
            >
              {t('usage.byModel')}
            </Button>
          </div>
        </div>
      </div>

      {chartData.length === 0 ? (
        <div className="h-48 flex items-center justify-center text-sm text-[var(--muted)]">
          {t('usage.noDataAvailable')}
        </div>
      ) : (
        <>
          <div className="flex items-end gap-[2px] h-48 px-2">
            {chartData.map((entry, index) => {
              const barHeight = getScaledHeight(entry.totalValue);
              const isHovered = hoveredIndex === index;

              const benchProps = {
                className: 'flex flex-col justify-end group cursor-pointer h-full flex-1',
                onMouseEnter: (e: React.MouseEvent) => handleBarHover(index, e),
                onMouseMove: (e: React.MouseEvent) => handleBarHover(index, e),
                onMouseLeave: handleBarLeave,
              };

              if (stackMode === 'total') {
                return (
                  <div key={entry.date} {...benchProps}>
                    <div
                      className="w-full rounded-t-sm transition-all duration-150"
                      style={{
                        height: `${barHeight}%`,
                        backgroundColor: 'var(--accent)',
                        opacity: isHovered ? 1 : 0.75,
                        minHeight: entry.totalValue > 0 ? '2px' : '0',
                      }}
                    />
                  </div>
                );
              }

              if (stackMode === 'model') {
                const modelSegs = Object.entries(entry.models)
                  .sort(([, a], [, b]) => b - a)
                  .slice(0, 8);
                return (
                  <div key={entry.date} {...benchProps}>
                    <div className="w-full flex flex-col-reverse rounded-t-sm overflow-hidden" style={{ height: `${barHeight}%` }}>
                      {modelSegs.map(([model, value]) => (
                        <div
                          key={model}
                          className="w-full transition-all duration-150"
                          style={{
                            height: `${entry.totalValue > 0 ? (value / entry.totalValue) * 100 : 0}%`,
                            backgroundColor: modelColorMap.get(model) ?? 'var(--muted)',
                            opacity: isHovered ? 1 : 0.85,
                            minHeight: value > 0 ? '1px' : '0',
                          }}
                        />
                      ))}
                      {modelSegs.length === 0 && entry.totalValue > 0 && (
                        <div className="w-full" style={{ height: '100%', backgroundColor: 'var(--muted)', opacity: 0.4 }} />
                      )}
                    </div>
                  </div>
                );
              }

              // Stacked breakdown
              const segmentKeys = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
              return (
                <div key={entry.date} {...benchProps}>
                  <div className="w-full flex flex-col-reverse rounded-t-sm overflow-hidden" style={{ height: `${barHeight}%` }}>
                    {segmentKeys.map((key) => {
                      const segmentValue = entry.segments[key];
                      const segmentRatio = entry.totalValue > 0 ? segmentValue / entry.totalValue : 0;
                      return (
                        <div
                          key={key}
                          className="w-full transition-all duration-150"
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

          {stackMode === 'model' && (
            <div className="flex flex-wrap gap-3 mt-3 pt-3 border-t border-[var(--border)]">
              {models.slice(0, 10).map((entry) => (
                <div key={entry.model} className="flex items-center gap-1.5">
                  <div
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: MODEL_PALETTE[entry.colorIndex % MODEL_PALETTE.length] }}
                  />
                  <span className="text-[10px] text-[var(--muted)] truncate max-w-40" title={entry.model}>
                    {entry.model}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tooltip && (
        <div
          className="fixed z-50 pointer-events-none bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-lg px-3 py-2 text-xs"
          style={{
            left: tooltip.x > window.innerWidth - 200 ? tooltip.x - 180 : tooltip.x + 12,
            top: tooltip.y - 10,
          }}
        >
          <div className="font-medium text-[var(--text)] mb-1">{tooltip.entry.date}</div>
          <div className="text-[var(--muted)] space-y-0.5">
            {stackMode === 'model' ? (
              <>
                <div>{t('usage.totalBtn')}: {formatNumber(tooltip.entry.tokens)}</div>
                {Object.entries(tooltip.entry.models)
                  .sort(([, a], [, b]) => b - a)
                  .slice(0, 8)
                  .map(([model, value]) => (
                    <div key={model} className="flex items-center gap-1.5">
                      <span
                        className="inline-block w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: modelColorMap.get(model) ?? 'var(--muted)' }}
                      />
                      <span className="truncate">{model}: {formatNumber(value)}</span>
                    </div>
                  ))}
              </>
            ) : mode === 'tokens' ? (
              <>
                <div>{t('usage.totalBtn')}: {formatNumber(tooltip.entry.tokens)}</div>
                <div>{t('usage.inputTokens')}: {formatNumber(tooltip.entry.input)}</div>
                <div>{t('usage.outputTokens')}: {formatNumber(tooltip.entry.output)}</div>
                {tooltip.entry.cacheRead > 0 && <div>{t('usage.cacheRead')}: {formatNumber(tooltip.entry.cacheRead)}</div>}
                {tooltip.entry.cacheWrite > 0 && <div>{t('usage.cacheWrite')}: {formatNumber(tooltip.entry.cacheWrite)}</div>}
              </>
            ) : (
              <>
                <div>{t('usage.totalBtn')}: {formatCurrency(tooltip.entry.cost)}</div>
                <div>{t('usage.inputTokens')}: {formatCurrency(tooltip.entry.inputCost)}</div>
                <div>{t('usage.outputTokens')}: {formatCurrency(tooltip.entry.outputCost)}</div>
                {tooltip.entry.cacheReadCost > 0 && <div>{t('usage.cacheRead')}: {formatCurrency(tooltip.entry.cacheReadCost)}</div>}
                {tooltip.entry.cacheWriteCost > 0 && <div>{t('usage.cacheWrite')}: {formatCurrency(tooltip.entry.cacheWriteCost)}</div>}
              </>
            )}
            <div className="mt-1 pt-1 border-t border-[var(--border)] text-[var(--muted)]">
              {tooltip.entry.messageCount} {t('usage.messagesShort')} · {tooltip.entry.sessionCount} {t('usage.sessionsShort')}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
