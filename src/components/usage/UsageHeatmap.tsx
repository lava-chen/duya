import React, { useState, useMemo, useCallback } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { formatNumber } from '@/hooks/useUsageData';

interface DailyContribution {
  date: string;
  value: number;
}

interface UsageHeatmapProps {
  /** Per-day token totals keyed by a value field, e.g. `{ date, value }`. */
  data: DailyContribution[];
}

const WEEKS = 53;
const DAYS_IN_WEEK = 7;

export const UsageHeatmap: React.FC<UsageHeatmapProps> = ({ data }) => {
  const { t } = useTranslation();
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    date: string;
    value: number;
  } | null>(null);

  const DAY_LABELS = [
    t('common.mon'),
    t('common.wed'),
    t('common.fri'),
  ];
  const MONTH_LABELS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

  // Map date -> value for O(1) lookups.
  const valueByDate = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of data) map.set(d.date, d.value);
    return map;
  }, [data]);

  const maxValue = useMemo(
    () => Math.max(...data.map((d) => d.value), 1),
    [data],
  );

  // Build a GitHub-style grid: columns are weeks (most recent on the right),
  // rows are days of the week starting Sunday. `totalDays` sized so the
  // rightmost column ends on today.
  const { weeks, monthPositions } = useMemo(() => {
    const today = new Date();
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const start = new Date(end);
    // 52 full weeks back, then align so end sits on a Saturday (grid columns
    // each run Sunday..Saturday).
    start.setDate(end.getDate() - (WEEKS - 1) * 7 + (6 - end.getDay()));
    // Offset start back to the previous Sunday.
    start.setDate(start.getDate() - start.getDay());

    const cells: { date: Date; day: number; week: number }[] = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      const day = cursor.getDay();
      // Start aligned to a Sunday, so each 7-date block forms one column.
      const week = Math.floor(cells.length / DAYS_IN_WEEK);
      cells.push({ date: new Date(cursor), day, week });
      cursor.setDate(cursor.getDate() + 1);
    }

    // Month labels at the first week (column) containing the 1st of each month.
    const positions: { month: string; week: number; label: string }[] = [];
    const seen = new Set<number>();
    for (const cell of cells) {
      const m = cell.date.getMonth();
      if (cell.date.getDate() === 1 && !seen.has(m)) {
        seen.add(m);
        positions.push({ month: String(m + 1), week: cell.week, label: MONTH_LABELS[m] });
      }
    }

    return { weeks: cells, monthPositions: positions };
  }, []);

  const gridCells = useMemo(() => weeks.map((cell) => ({ ...cell, value: 0 })), [weeks]);

  // Fill values into grid cells.
  const filledGrid = useMemo(() => {
    return gridCells.map((cell) => {
      const key = `${cell.date.getFullYear()}-${String(cell.date.getMonth() + 1).padStart(2, '0')}-${String(cell.date.getDate()).padStart(2, '0')}`;
      return { ...cell, value: valueByDate.get(key) ?? 0 };
    });
  }, [gridCells, valueByDate]);

  // Group cells by week (column), each column holds 7 day rows (0..6).
  const columns = useMemo(() => {
    const cols: Record<number, typeof filledGrid> = {};
    for (const cell of filledGrid) {
      (cols[cell.week] ??= []).push(cell);
    }
    const list = Object.values(cols);
    // Right-align so the last column is the current week.
    return list;
  }, [filledGrid]);

  const getColor = useCallback(
    (value: number) => {
      if (value <= 0) return 'var(--surface)';
      const ratio = value / maxValue;
      const alpha = 0.08 + ratio * 0.82;
      return `color-mix(in srgb, var(--accent) ${alpha * 100}%, transparent)`;
    },
    [maxValue],
  );

  const handleCellHover = useCallback(
    (cell: { date: Date; value: number; day: number; week: number }, event: React.MouseEvent) => {
      const key = `${cell.date.getFullYear()}-${String(cell.date.getMonth() + 1).padStart(2, '0')}-${String(cell.date.getDate()).padStart(2, '0')}`;
      setTooltip({
        x: event.clientX,
        y: event.clientY,
        date: key,
        value: cell.value,
      });
    },
    [],
  );

  const handleCellLeave = useCallback(() => setTooltip(null), []);

  // x pixel offset for each month label (weeks are the column index).
  const monthOffset = (week: number) => week * (13 + 2) + 4;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-gradient-to-b from-[var(--surface)] to-[var(--bg-canvas)] p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-[var(--text)]">{t('usage.activityHeatmap')}</h3>
        <span className="text-xs text-[var(--muted)]">{t('usage.lastYear')}</span>
      </div>

      {data.length === 0 ? (
        <div className="h-32 flex items-center justify-center text-sm text-[var(--muted)]">
          {t('usage.noActivityData')}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div style={{ display: 'flex', gap: 4 }}>
            {/* Weekday labels column */}
            <div className="flex flex-col" style={{ width: 26, gap: 2, marginRight: 4 }}>
              <div style={{ height: 16 }} />
              {[1, 3, 5].map((dayRow) => (
                <div
                  key={dayRow}
                  className="text-[9px] text-[var(--muted)] leading-none flex items-center"
                  style={{ height: 13, paddingTop: dayRow === 1 ? 0 : 0 }}
                >
                  {dayRow === 1 ? DAY_LABELS[0] : dayRow === 3 ? DAY_LABELS[1] : DAY_LABELS[2]}
                </div>
              ))}
            </div>

            {/* Grid */}
            <div className="flex flex-col gap-[3px]">
              {/* Month labels */}
              <div className="flex relative" style={{ height: 16 }}>
                {monthPositions.map((mp) => (
                  <span
                    key={mp.month}
                    className="text-[9px] text-[var(--muted)] absolute"
                    style={{ left: monthOffset(mp.week) }}
                  >
                    {mp.label}
                  </span>
                ))}
              </div>
              {/* Day cells */}
              <div className="flex gap-[3px]">
                {columns.map((col, colIdx) => (
                  <div key={colIdx} className="flex flex-col gap-[3px]">
                    {Array.from({ length: DAYS_IN_WEEK }, (_, r) => {
                      const cell = col.find((c) => c.day === r);
                      if (!cell) return <div key={r} style={{ width: 13, height: 13 }} />;
                      return (
                        <div
                          key={r}
                          className="rounded-[3px] cursor-pointer transition-all duration-150 hover:scale-125 hover:z-10 hover:ring-1 hover:ring-[var(--border)]"
                          style={{
                            width: 13,
                            height: 13,
                            backgroundColor: getColor(cell.value),
                            border: cell.value <= 0 ? '1px solid var(--border)' : 'none',
                          }}
                          onMouseEnter={(e) => handleCellHover(cell, e)}
                          onMouseMove={(e) => handleCellHover(cell, e)}
                          onMouseLeave={handleCellLeave}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Legend */}
          <div className="flex items-center justify-end gap-2 mt-2">
            <span className="text-[9px] text-[var(--muted)]">{t('usage.less')}</span>
            <div className="flex gap-[3px]">
              {[0, 0.25, 0.5, 0.75, 1].map((level) => (
                <div
                  key={level}
                  className="w-[13px] h-[13px] rounded-[3px]"
                  style={{
                    backgroundColor:
                      level === 0
                        ? 'var(--surface)'
                        : `color-mix(in srgb, var(--accent) ${(0.08 + level * 0.82) * 100}%, transparent)`,
                    border: level === 0 ? '1px solid var(--border)' : 'none',
                  }}
                />
              ))}
            </div>
            <span className="text-[9px] text-[var(--muted)]">{t('usage.more')}</span>
          </div>
        </div>
      )}

      {tooltip && (
        <div
          className="fixed z-[100] pointer-events-none bg-[var(--main-bg)] border border-[var(--border)] rounded-lg shadow-lg p-2 text-xs"
          style={{
            left: tooltip.x > window.innerWidth - 160 ? tooltip.x - 130 : tooltip.x + 10,
            top: tooltip.y - 10,
          }}
        >
          <div className="font-semibold text-[var(--text)]">{tooltip.date}</div>
          <div className="text-[var(--muted)]">
            {formatNumber(tooltip.value)} {t('usage.tokens')}
          </div>
        </div>
      )}
    </div>
  );
};