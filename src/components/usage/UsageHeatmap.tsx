import React, { useState, useMemo, useCallback } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { formatNumber } from '@/hooks/useUsageData';

interface DailyContribution {
  date: string;
  value: number;
  sessions?: number;
}

interface UsageHeatmapProps {
  /** Per-day token totals keyed by a value field, e.g. `{ date, value }`. */
  data: DailyContribution[];
}

const WEEKS = 20;
const DAYS_IN_WEEK = 7;
const CELL_SIZE = 18;
const CELL_GAP = 3;

export const UsageHeatmap: React.FC<UsageHeatmapProps> = ({ data }) => {
  const { t } = useTranslation();
  const [hoveredCell, setHoveredCell] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    date: string;
    value: number;
    sessions?: number;
  } | null>(null);

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
  const { weeks } = useMemo(() => {
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

    return { weeks: cells };
  }, []);

  const gridCells = useMemo(() => weeks.map((cell) => ({ ...cell, value: 0 })), [weeks]);

  // Map date -> sessions for O(1) lookups.
  const sessionsByDate = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of data) {
      if (d.sessions !== undefined) map.set(d.date, d.sessions);
    }
    return map;
  }, [data]);

  // Fill values into grid cells.
  const filledGrid = useMemo(() => {
    return gridCells.map((cell) => {
      const key = `${cell.date.getFullYear()}-${String(cell.date.getMonth() + 1).padStart(2, '0')}-${String(cell.date.getDate()).padStart(2, '0')}`;
      return {
        ...cell,
        value: valueByDate.get(key) ?? 0,
        sessions: sessionsByDate.get(key),
      };
    });
  }, [gridCells, valueByDate, sessionsByDate]);

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
    (cell: { date: Date; value: number; day: number; week: number; sessions?: number }, event: React.MouseEvent) => {
      const key = `${cell.date.getFullYear()}-${cell.date.getMonth()}-${cell.date.getDate()}`;
      setHoveredCell(key);
      const dateStr = `${cell.date.getFullYear()}-${String(cell.date.getMonth() + 1).padStart(2, '0')}-${String(cell.date.getDate()).padStart(2, '0')}`;
      setTooltip({
        x: event.clientX,
        y: event.clientY,
        date: dateStr,
        value: cell.value,
        sessions: cell.sessions,
      });
    },
    [],
  );

  const handleCellLeave = useCallback(() => {
    setHoveredCell(null);
    setTooltip(null);
  }, []);

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
        <div>
          {/* Grid - no axis labels, no scroll */}
          <div className="flex">
            <div className="flex gap-[3px]">
              {columns.map((col, colIdx) => (
                <div key={colIdx} className="flex flex-col gap-[3px]">
                  {Array.from({ length: DAYS_IN_WEEK }, (_, r) => {
                    const cell = col.find((c) => c.day === r);
                    if (!cell) return <div key={r} style={{ width: CELL_SIZE, height: CELL_SIZE }} />;
                    return (
                      <div
                        key={r}
                        className="rounded-[3px] cursor-pointer"
                        style={{
                          width: CELL_SIZE,
                          height: CELL_SIZE,
                          backgroundColor: getColor(cell.value),
                          border: cell.value <= 0 ? '1px solid var(--border)' : 'none',
                          outline: hoveredCell === `${cell.date.getFullYear()}-${cell.date.getMonth()}-${cell.date.getDate()}` ? '2px solid var(--accent)' : 'none',
                          outlineOffset: '-1px',
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

          {/* Legend */}
          <div className="flex items-center justify-end gap-2 mt-2">
            <span className="text-[9px] text-[var(--muted)]">{t('usage.less')}</span>
            <div className="flex gap-[3px]">
              {[0, 0.25, 0.5, 0.75, 1].map((level) => (
                <div
                  key={level}
                  className="rounded-[3px]"
                  style={{
                    width: CELL_SIZE,
                    height: CELL_SIZE,
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
          className="fixed z-[100] pointer-events-none bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-lg px-3 py-2 text-xs"
          style={{
            left: tooltip.x > window.innerWidth - 180 ? tooltip.x - 160 : tooltip.x + 12,
            top: tooltip.y - 10,
          }}
        >
          <div className="font-medium text-[var(--text)]">
            {tooltip.date}
          </div>
          <div className="text-[var(--muted)]">
            {formatNumber(tooltip.value)} {t('usage.tokens')}
            {tooltip.sessions !== undefined && tooltip.sessions > 0 && (
              <> · {tooltip.sessions} {t('usage.sessionsShort')}</>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
