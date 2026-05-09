import React, { useState, useCallback } from 'react';
import type { HeatmapCell } from '@/types/usage';
import { useTranslation } from '@/hooks/useTranslation';
import { formatNumber } from '@/hooks/useUsageData';

interface UsageHeatmapProps {
  data: HeatmapCell[];
}

const HOUR_LABELS = ['12a', '3a', '6a', '9a', '12p', '3p', '6p', '9p'];

export const UsageHeatmap: React.FC<UsageHeatmapProps> = ({ data }) => {
  const { t } = useTranslation();
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    cell: HeatmapCell;
  } | null>(null);

  const DAY_LABELS = [t('common.sun'), t('common.mon'), t('common.tue'), t('common.wed'), t('common.thu'), t('common.fri'), t('common.sat')];

  const handleCellHover = useCallback((cell: HeatmapCell, event: React.MouseEvent) => {
    setTooltip({
      x: event.clientX,
      y: event.clientY,
      cell,
    });
  }, []);

  const handleCellLeave = useCallback(() => {
    setTooltip(null);
  }, []);

  // Build a 7x24 grid
  const grid: (HeatmapCell | null)[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => null)
  );

  for (const cell of data) {
    if (cell.day >= 0 && cell.day < 7 && cell.hour >= 0 && cell.hour < 24) {
      grid[cell.day][cell.hour] = cell;
    }
  }

  const maxIntensity = Math.max(...data.map((d) => d.intensity), 0.01);

  return (
    <div className="rounded-xl border border-[var(--border)] bg-gradient-to-b from-[var(--surface)] to-[var(--bg-canvas)] p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-[var(--text)]">{t('usage.activityHeatmap')}</h3>
        <span className="text-xs text-[var(--muted)]">{t('usage.timeRange')}</span>
      </div>

      {data.length === 0 ? (
        <div className="h-32 flex items-center justify-center text-sm text-[var(--muted)]">
          {t('usage.noActivityData')}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[600px]">
            {/* Hour labels */}
            <div className="flex ml-12 mb-1">
              {HOUR_LABELS.map((label, i) => (
                <div
                  key={label}
                  className="flex-1 text-[9px] text-[var(--muted)] text-center"
                  style={{ marginLeft: i === 0 ? 0 : 'calc(300% - 1px)' }}
                >
                  {label}
                </div>
              ))}
            </div>

            {/* Grid */}
            <div className="flex">
              {/* Day labels */}
              <div className="flex flex-col justify-around mr-2 w-10">
                {DAY_LABELS.map((day) => (
                  <div key={day} className="text-[9px] text-[var(--muted)] text-right leading-4">
                    {day}
                  </div>
                ))}
              </div>

              {/* Cells */}
              <div className="flex-1 grid grid-cols-24 gap-px">
                {grid.map((dayRow, dayIndex) =>
                  dayRow.map((cell, hourIndex) => {
                    const intensity = cell ? cell.intensity / maxIntensity : 0;
                    const isEmpty = !cell || cell.value === 0;

                    return (
                      <div
                        key={`${dayIndex}-${hourIndex}`}
                        className="aspect-square rounded-sm cursor-pointer transition-all duration-150 hover:scale-125 hover:z-10"
                        style={{
                          backgroundColor: isEmpty
                            ? 'var(--surface)'
                            : `color-mix(in srgb, var(--accent) ${8 + intensity * 70}%, transparent)`,
                          border: isEmpty
                            ? '1px solid var(--border)'
                            : `1px solid color-mix(in srgb, var(--accent) ${intensity * 60}%, var(--border))`,
                        }}
                        onMouseEnter={(e) => cell && handleCellHover(cell, e)}
                        onMouseMove={(e) => cell && handleCellHover(cell, e)}
                        onMouseLeave={handleCellLeave}
                      />
                    );
                  })
                )}
              </div>
            </div>

            {/* Legend */}
            <div className="flex items-center justify-end gap-2 mt-2">
              <span className="text-[9px] text-[var(--muted)]">{t('usage.less')}</span>
              <div className="flex gap-px">
                {[0, 0.25, 0.5, 0.75, 1].map((level) => (
                  <div
                    key={level}
                    className="w-3 h-3 rounded-sm"
                    style={{
                      backgroundColor: `color-mix(in srgb, var(--accent) ${8 + level * 70}%, transparent)`,
                      border: `1px solid color-mix(in srgb, var(--accent) ${level * 60}%, var(--border))`,
                    }}
                  />
                ))}
              </div>
              <span className="text-[9px] text-[var(--muted)]">{t('usage.more')}</span>
            </div>
          </div>
        </div>
      )}

      {tooltip && (
        <div
          className="fixed z-50 pointer-events-none bg-[var(--main-bg)] border border-[var(--border)] rounded-lg shadow-lg p-2 text-xs"
          style={{
            left: tooltip.x + 10,
            top: tooltip.y - 10,
          }}
        >
          <div className="font-semibold text-[var(--text)]">
            {DAY_LABELS[tooltip.cell.day]} {tooltip.cell.hour}:00
          </div>
          <div className="text-[var(--muted)]">{formatNumber(tooltip.cell.value)} {t('usage.tokens')}</div>
        </div>
      )}
    </div>
  );
};
