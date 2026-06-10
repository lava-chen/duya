'use client';

/**
 * ContextUsagePopover.tsx
 *
 * Hover-triggered popover next to the input. The design is intentionally
 * dense: the user should see the four big numbers (used / total / usage /
 * next est), a glance-able grid, and one-line cache + top-3 categories.
 * Everything else lives in the modal.
 *
 * Hover is managed by the parent (ContextUsageRing) — the wrapper sits
 * between the trigger and the popover so the cursor can travel across
 * the gap without losing hover.
 */
import { useContext } from 'react';
import { I18nContext } from '@/components/layout/I18nProvider';
import {
  formatTokens,
  type ContextUsage,
} from '@/hooks/useContextUsage';
import {
  getCategoryLabel,
  type ContextBreakdown,
  type ContextCategory,
  type GridSquare,
} from '@/lib/context-usage-utils';

interface ContextUsagePopoverProps {
  usage: ContextUsage;
  breakdown: ContextBreakdown;
  contextWindow: number;
  onOpenDetails: () => void;
  onCompress?: () => void;
  isCompacting?: boolean;
}

const CATEGORY_COLOR: Record<ContextCategory, string> = {
  user_text: 'var(--info, #3b82f6)',
  assistant_text: 'var(--accent, #7c3aed)',
  tool_call: 'var(--warning, #f59e0b)',
  tool_result: 'var(--warning-soft, rgba(245,158,11,0.55))',
  thinking: 'var(--muted, #8a8a8a)',
  attachment: 'var(--success, #22c55e)',
  compact_summary: 'var(--border, rgba(0,0,0,0.12))',
  subagent: 'var(--accent-soft, rgba(124,58,237,0.45))',
  system: 'var(--muted, #8a8a8a)',
};

function categoryColor(c: ContextCategory): string {
  return CATEGORY_COLOR[c] ?? 'var(--muted, #8a8a8a)';
}

function formatPercent(n: number): string {
  return (n * 100).toFixed(1) + '%';
}

const TOP_CATEGORIES = 3;

export function ContextUsagePopover({
  usage,
  breakdown,
  contextWindow,
  onOpenDetails,
  onCompress,
  isCompacting = false,
}: ContextUsagePopoverProps) {
  const { t } = useContext(I18nContext);

  if (!usage.hasData) {
    return (
      <div className="ctx-popover" role="tooltip">
        <p className="ctx-popover__no-data">{t('context.usage.noData')}</p>
        <style>{POPOVER_STYLES}</style>
      </div>
    );
  }

  const { columns, rows } = breakdown;
  const cells = breakdown.gridSquares;
  const totalCells = cells.length;
  const gridRows: GridSquare[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: GridSquare[] = [];
    for (let c = 0; c < columns; c++) {
      const idx = r * columns + c;
      if (idx < totalCells) {
        row.push(cells[idx]);
        continue;
      }
      row.push({
        category: '__free__' as unknown as ContextCategory,
        fullness: 1,
      });
    }
    gridRows.push(row);
  }

  const categoryTotals: { category: ContextCategory; tokens: number }[] = [];
  for (const [cat, list] of breakdown.byCategory) {
    const tokens = list.reduce((acc, s) => acc + s.tokens, 0);
    if (tokens > 0) categoryTotals.push({ category: cat, tokens });
  }
  categoryTotals.sort((a, b) => b.tokens - a.tokens);
  const topCategories = categoryTotals.slice(0, TOP_CATEGORIES);

  const nextEstWarn = usage.estimatedNextRatio >= 0.8;
  const stateClass =
    usage.state === 'critical'
      ? 'ctx-popover__stat--critical'
      : usage.state === 'warning'
        ? 'ctx-popover__stat--warn'
        : '';

  // Used cell count drives the "1 cell ≈ X tokens" scale so the user
  // can translate the grid back into token count at a glance.
  const tokensPerCell = usage.used / Math.max(1, totalCells);

  return (
    <div className="ctx-popover" role="tooltip">
      <div className="ctx-popover__head">
        <span className="ctx-popover__title">{t('context.usage')}</span>
        <span className="ctx-popover__model">{usage.modelName}</span>
      </div>

      <div className={'ctx-popover__stats ' + stateClass}>
        <div className="ctx-popover__stat ctx-popover__stat--primary">
          <span className="ctx-popover__stat-value">
            {formatTokens(usage.used)}
          </span>
          <span className="ctx-popover__stat-label">{t('context.used')}</span>
        </div>
        <div className="ctx-popover__stat">
          <span className="ctx-popover__stat-value">
            {formatPercent(usage.ratio)}
          </span>
          <span className="ctx-popover__stat-label">
            {t('context.percentage')}
          </span>
        </div>
        <div className="ctx-popover__stat">
          <span className="ctx-popover__stat-value">
            ~{formatTokens(usage.estimatedNextTurn)}
          </span>
          <span className="ctx-popover__stat-label">{t('context.nextEst')}</span>
        </div>
        <div className="ctx-popover__stat">
          <span className="ctx-popover__stat-value">
            {formatTokens(contextWindow)}
          </span>
          <span className="ctx-popover__stat-label">{t('context.total')}</span>
        </div>
      </div>

      <div className="ctx-popover__grid-wrap">
        <div className="ctx-popover__grid" aria-hidden="true">
          {gridRows.map((row, ri) => (
            <div key={ri} className="ctx-popover__row">
              {row.map((cell, ci) => {
                const cat = cell.category as ContextCategory | '__free__';
                if (cat === '__free__') {
                  return (
                    <span
                      key={ci}
                      className="ctx-cell ctx-cell--free"
                      title={`${formatTokens(tokensPerCell)} free`}
                    >
                      ⛶
                    </span>
                  );
                }
                const isFull = cell.fullness >= 0.7;
                return (
                  <span
                    key={ci}
                    className="ctx-cell"
                    style={{ color: categoryColor(cat) }}
                  >
                    {isFull ? '⛁' : '⛀'}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
        <div className="ctx-popover__scale">
          <span>1 cell ≈ {formatTokens(Math.max(1, Math.round(tokensPerCell)))}</span>
        </div>
      </div>

      {topCategories.length > 0 && (
        <ul className="ctx-popover__top">
          {topCategories.map(({ category, tokens }) => (
            <li key={category} className="ctx-popover__top-item">
              <span
                className="ctx-popover__top-dot"
                style={{ background: categoryColor(category) }}
              />
              <span className="ctx-popover__top-name">
                {getCategoryLabel(category)}
              </span>
              <span className="ctx-popover__top-tokens">
                {formatTokens(tokens)}
              </span>
              <span className="ctx-popover__top-pct">
                {formatPercent(tokens / Math.max(1, contextWindow))}
              </span>
            </li>
          ))}
        </ul>
      )}

      {usage.cacheReadTokens + usage.cacheCreationTokens > 0 && (
        <div className="ctx-popover__cache">
          <span className="ctx-popover__cache-label">
            {t('context.cacheRead')}
          </span>
          <span className="ctx-popover__cache-value">
            {formatTokens(usage.cacheReadTokens)}
          </span>
          <span className="ctx-popover__cache-hit">
            {t('context.cacheHitRate')} {formatPercent(usage.cacheHitRate)}
          </span>
        </div>
      )}

      {usage.state !== 'normal' && (
        <p
          className={
            'ctx-popover__hint ' +
            (usage.state === 'critical'
              ? 'ctx-popover__hint--critical'
              : 'ctx-popover__hint--warn')
          }
        >
          {usage.state === 'critical'
            ? t('context.usage.critical')
            : t('context.usage.warning')}
        </p>
      )}

      <div className="ctx-popover__footer">
        <button
          type="button"
          className="ctx-popover__details"
          onClick={onOpenDetails}
        >
          {t('context.viewDetails')} ▸
        </button>
        {onCompress && usage.state !== 'normal' && (
          <button
            type="button"
            className="ctx-popover__compress"
            onClick={onCompress}
            disabled={isCompacting}
            title={t('context.compress')}
          >
            {isCompacting
              ? t('context.compressing')
              : t('context.compress')}
          </button>
        )}
      </div>

      <style>{POPOVER_STYLES}</style>
    </div>
  );
}

const POPOVER_STYLES = `
  .ctx-popover {
    width: 280px;
    padding: 12px;
    background: var(--main-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
    color: var(--text);
    font-size: 11px;
    line-height: 1.4;
    z-index: 100;
  }

  .ctx-popover__no-data {
    margin: 4px 0;
    text-align: center;
    color: var(--muted);
  }

  .ctx-popover__head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .ctx-popover__title {
    font-weight: 600;
    font-size: 12px;
  }

  .ctx-popover__model {
    color: var(--muted);
    font-size: 10px;
  }

  /* Top stat row — the four big numbers. Primary (Used) is biggest. */
  .ctx-popover__stats {
    display: grid;
    grid-template-columns: 1.2fr 0.9fr 1fr 0.9fr;
    gap: 10px;
    align-items: end;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
  }

  .ctx-popover__stat {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .ctx-popover__stat--primary .ctx-popover__stat-value {
    font-size: 16px;
    font-weight: 600;
  }

  .ctx-popover__stat-value {
    font-size: 12px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    color: var(--text);
    line-height: 1.1;
  }

  .ctx-popover__stat-label {
    color: var(--muted);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .ctx-popover__stat--warn .ctx-popover__stat-value {
    color: var(--warning);
  }

  .ctx-popover__stat--critical .ctx-popover__stat-value {
    color: var(--error);
  }

  /* Grid centered below the stats. */
  .ctx-popover__grid-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 10px 0;
  }

  .ctx-popover__grid {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .ctx-popover__row {
    display: flex;
    gap: 1px;
  }

  .ctx-cell {
    font-size: 10px;
    line-height: 1;
    width: 11px;
    text-align: center;
    user-select: none;
  }

  .ctx-cell--free {
    color: var(--muted);
    opacity: 0.4;
  }

  .ctx-popover__scale {
    margin-top: 6px;
    font-size: 9px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  /* Top-3 categories. */
  .ctx-popover__top {
    list-style: none;
    margin: 0 0 8px 0;
    padding: 8px 0;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .ctx-popover__top-item {
    display: grid;
    grid-template-columns: 8px 1fr auto auto;
    gap: 6px;
    align-items: center;
  }

  .ctx-popover__top-dot {
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }

  .ctx-popover__top-name {
    color: var(--text);
  }

  .ctx-popover__top-tokens,
  .ctx-popover__top-pct {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  /* One-line cache readout. */
  .ctx-popover__cache {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 10px;
    color: var(--muted);
    margin-bottom: 8px;
  }

  .ctx-popover__cache-label {
    color: var(--muted);
  }

  .ctx-popover__cache-value {
    color: var(--text);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }

  .ctx-popover__cache-hit {
    color: var(--success);
    margin-left: auto;
    font-weight: 500;
  }

  .ctx-popover__hint {
    margin: 0 0 8px 0;
    padding: 6px 8px;
    border-radius: 4px;
    font-size: 10px;
    background: var(--warning-soft, rgba(245,158,11,0.12));
    color: var(--warning);
  }

  .ctx-popover__hint--critical {
    background: var(--error-soft, rgba(239,68,68,0.12));
    color: var(--error);
  }

  .ctx-popover__footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .ctx-popover__details {
    background: transparent;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font-size: 11px;
    padding: 4px 6px;
    border-radius: 4px;
    font-weight: 500;
  }

  .ctx-popover__details:hover {
    background: var(--bg-hover);
  }

  .ctx-popover__compress {
    background: var(--accent);
    color: var(--accent-fg, #fff);
    border: none;
    border-radius: 4px;
    padding: 4px 10px;
    font-size: 10px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.15s ease;
  }

  .ctx-popover__compress:hover:not(:disabled) {
    opacity: 0.85;
  }

  .ctx-popover__compress:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;
