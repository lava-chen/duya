'use client';

/**
 * ContextBreakdownModal.tsx
 *
 * Centered modal opened from the ring popover's "View details" link. Shows
 * the per-category breakdown with expandable rows, plus the same
 * cache/output summary numbers the popover shows, plus a Compress button
 * when state is warning/critical.
 *
 * The modal mounts at the document root via a portal so it escapes any
 * stacking-context surprises near the input.
 */
import { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { I18nContext } from '@/components/layout/I18nProvider';
import {
  formatTokens,
  type ContextUsage,
} from '@/hooks/useContextUsage';
import type {
  ContextBreakdown,
  ContextCategory,
  ContextSource,
  GridSquare,
} from '@/lib/context-usage-utils';
import { getCategoryLabel } from '@/lib/context-usage-utils';

interface ContextBreakdownModalProps {
  open: boolean;
  onClose: () => void;
  usage: ContextUsage;
  breakdown: ContextBreakdown;
  contextWindow: number;
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

export function ContextBreakdownModal({
  open,
  onClose,
  usage,
  breakdown,
  contextWindow,
  onCompress,
  isCompacting = false,
}: ContextBreakdownModalProps) {
  const { t } = useContext(I18nContext);
  const [expanded, setExpanded] = useState<Set<ContextCategory>>(new Set());
  const dialogRef = useRef<HTMLDivElement>(null);

  // Esc closes; capture focus on mount and restore on unmount
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const node = dialogRef.current;
    node?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Tab' && node) {
        // Simple focus trap
        const focusables = node.querySelectorAll<HTMLElement>(
          'button, [href], [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  const visibleCategories: { category: ContextCategory; tokens: number }[] = [];
  for (const [cat, list] of breakdown.byCategory) {
    const tokens = list.reduce((acc, s) => acc + s.tokens, 0);
    if (tokens > 0) visibleCategories.push({ category: cat, tokens });
  }
  visibleCategories.sort((a, b) => b.tokens - a.tokens);

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

  const toggleCategory = (cat: ContextCategory) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const stateHint =
    usage.state === 'critical'
      ? t('context.usage.critical')
      : usage.state === 'warning'
        ? t('context.usage.warning')
        : null;

  return createPortal(
    <div
      className="ctx-modal__backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="ctx-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ctx-modal-title"
        tabIndex={-1}
      >
        <header className="ctx-modal__head">
          <h2 id="ctx-modal-title" className="ctx-modal__title">
            {t('context.usage')}
          </h2>
          <button
            type="button"
            className="ctx-modal__close"
            aria-label={t('common.close')}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="ctx-modal__sub">
          <span>{usage.modelName}</span>
          <span className="ctx-modal__sub-sep">·</span>
          <span>
            {formatTokens(usage.used)} / {formatTokens(contextWindow)} (
            {formatPercent(usage.ratio)})
          </span>
        </div>

        <section className="ctx-modal__section ctx-modal__grid-section">
          <div
            className="ctx-modal__grid"
            aria-label="context distribution"
            role="img"
          >
            {gridRows.map((row, ri) => (
              <div key={ri} className="ctx-modal__grid-row">
                {row.map((cell, ci) => {
                  const cat = cell.category as ContextCategory | '__free__';
                  if (cat === '__free__') {
                    return (
                      <span
                        key={ci}
                        className="ctx-cell ctx-cell--free"
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
        </section>

        {visibleCategories.length > 0 && (
          <section className="ctx-modal__section">
            <h3 className="ctx-modal__section-title">
              {t('context.usage.byCategory')}
            </h3>
            <ul className="ctx-modal__cat-list">
              {visibleCategories.map(({ category, tokens }) => {
                const sources = breakdown.byCategory.get(category) ?? [];
                const isOpen = expanded.has(category);
                return (
                  <li key={category} className="ctx-modal__cat">
                    <button
                      type="button"
                      className="ctx-modal__cat-row"
                      onClick={() => toggleCategory(category)}
                      aria-expanded={isOpen}
                    >
                      <span
                        className="ctx-modal__cat-symbol"
                        style={{ color: categoryColor(category) }}
                      >
                        {tokens > 0 ? '⛁' : ' '}
                      </span>
                      <span className="ctx-modal__cat-name">
                        {getCategoryLabel(category)}
                      </span>
                      <span className="ctx-modal__cat-count">
                        ({sources.length})
                      </span>
                      <span className="ctx-modal__cat-tokens">
                        {formatTokens(tokens)}
                      </span>
                      <span className="ctx-modal__cat-pct">
                        ({formatPercent(tokens / Math.max(1, contextWindow))})
                      </span>
                      <span className="ctx-modal__cat-chevron">
                        {isOpen ? '▾' : '▸'}
                      </span>
                    </button>
                    {isOpen && sources.length > 0 && (
                      <ul className="ctx-modal__src-list">
                        {sources.map((src) => (
                          <SourceRow key={src.id} src={src} />
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section className="ctx-modal__section">
          <h3 className="ctx-modal__section-title">
            {t('context.usage.tokenBreakdown')}
          </h3>
          <div className="ctx-modal__kv">
            <span className="ctx-modal__kv-label">{t('context.cacheRead')}</span>
            <span className="ctx-modal__kv-value">
              {formatTokens(usage.cacheReadTokens)}
            </span>
            <span className="ctx-modal__kv-label">{t('context.cacheCreate')}</span>
            <span className="ctx-modal__kv-value">
              {formatTokens(usage.cacheCreationTokens)}
            </span>
            {usage.cacheReadTokens + usage.cacheCreationTokens > 0 && (
              <>
                <span className="ctx-modal__kv-label">
                  {t('context.cacheHitRate')}
                </span>
                <span className="ctx-modal__kv-value">
                  {formatPercent(usage.cacheHitRate)}
                </span>
              </>
            )}
            <span className="ctx-modal__kv-label">{t('context.output')}</span>
            <span className="ctx-modal__kv-value">
              {formatTokens(usage.outputTokens)}
            </span>
            <span className="ctx-modal__kv-label">{t('context.nextEst')}</span>
            <span
              className={
                'ctx-modal__kv-value' +
                (usage.estimatedNextRatio >= 0.8
                  ? ' ctx-modal__kv-value--warn'
                  : '')
              }
            >
              ~{formatTokens(usage.estimatedNextTurn)} (
              {formatPercent(usage.estimatedNextRatio)})
            </span>
          </div>
        </section>

        {stateHint && (
          <p
            className={
              'ctx-modal__hint ' +
              (usage.state === 'critical'
                ? 'ctx-modal__hint--critical'
                : 'ctx-modal__hint--warn')
            }
          >
            {stateHint}
          </p>
        )}

        {onCompress && usage.state !== 'normal' && (
          <footer className="ctx-modal__foot">
            <button
              type="button"
              className="ctx-modal__compress"
              onClick={onCompress}
              disabled={isCompacting}
              title={t('context.compress')}
            >
              {isCompacting
                ? t('context.compressing')
                : t('context.compress')}
            </button>
          </footer>
        )}
      </div>

      <style>{MODAL_STYLES}</style>
    </div>,
    document.body,
  );
}

function SourceRow({ src }: { src: ContextSource }) {
  const { t } = useContext(I18nContext);
  return (
    <li className="ctx-modal__src">
      <span className="ctx-modal__src-name">
        {src.label}
        {src.attachmentName && src.attachmentName !== src.label
          ? ` · ${src.attachmentName}`
          : ''}
      </span>
      {src.preview && (
        <span className="ctx-modal__src-preview">{src.preview}</span>
      )}
      <span className="ctx-modal__src-tokens">
        {formatTokens(src.tokens)} {t('context.tokens')}
      </span>
    </li>
  );
}

const MODAL_STYLES = `
  .ctx-modal__backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 24px;
  }

  .ctx-modal {
    width: 480px;
    max-width: 100%;
    max-height: 80vh;
    overflow: auto;
    background: var(--main-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.25);
    color: var(--text);
    font-size: 12px;
    line-height: 1.5;
    padding: 18px;
    outline: none;
  }

  .ctx-modal__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }

  .ctx-modal__title {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }

  .ctx-modal__close {
    background: transparent;
    border: none;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    color: var(--muted);
    padding: 0 4px;
    border-radius: 4px;
  }

  .ctx-modal__close:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  .ctx-modal__sub {
    display: flex;
    align-items: baseline;
    gap: 6px;
    color: var(--muted);
    font-size: 11px;
    margin-bottom: 12px;
  }

  .ctx-modal__sub-sep {
    opacity: 0.6;
  }

  .ctx-modal__section {
    margin: 14px 0;
  }

  .ctx-modal__section-title {
    margin: 0 0 6px 0;
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .ctx-modal__grid-section {
    display: flex;
    justify-content: center;
  }

  .ctx-modal__grid {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .ctx-modal__grid-row {
    display: flex;
    gap: 1px;
  }

  .ctx-cell {
    font-size: 11px;
    line-height: 1;
    width: 11px;
    text-align: center;
    user-select: none;
  }

  .ctx-cell--free {
    color: var(--muted);
    opacity: 0.35;
  }

  .ctx-cell--reserved {
    color: var(--muted);
    opacity: 0.6;
  }

  .ctx-modal__cat-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .ctx-modal__cat {
    border-bottom: 1px solid var(--border);
  }

  .ctx-modal__cat-row {
    display: grid;
    grid-template-columns: 12px 1fr auto auto auto 12px;
    gap: 8px;
    align-items: baseline;
    width: 100%;
    background: transparent;
    border: none;
    padding: 6px 0;
    cursor: pointer;
    text-align: left;
    color: inherit;
    font: inherit;
  }

  .ctx-modal__cat-row:hover {
    background: var(--bg-hover);
  }

  .ctx-modal__cat-symbol {
    text-align: center;
    font-size: 11px;
    line-height: 1;
  }

  .ctx-modal__cat-name {
    font-weight: 500;
  }

  .ctx-modal__cat-count {
    color: var(--muted);
    font-size: 10px;
  }

  .ctx-modal__cat-tokens,
  .ctx-modal__cat-pct {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    font-size: 11px;
  }

  .ctx-modal__cat-chevron {
    color: var(--muted);
    font-size: 10px;
  }

  .ctx-modal__src-list {
    list-style: none;
    margin: 0 0 6px 20px;
    padding: 0;
    border-left: 2px solid var(--border);
  }

  .ctx-modal__src {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 4px 12px;
    padding: 4px 8px;
    font-size: 10px;
    color: var(--muted);
  }

  .ctx-modal__src-name {
    color: var(--text);
    font-weight: 500;
  }

  .ctx-modal__src-preview {
    grid-column: 1 / -1;
    color: var(--muted);
    font-style: italic;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ctx-modal__src-tokens {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .ctx-modal__kv {
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: 12px;
    row-gap: 4px;
    font-size: 11px;
  }

  .ctx-modal__kv-label {
    color: var(--muted);
  }

  .ctx-modal__kv-value {
    color: var(--text);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .ctx-modal__kv-value--warn {
    color: var(--warning);
  }

  .ctx-modal__hint {
    margin: 12px 0 0 0;
    padding: 8px 10px;
    border-radius: 6px;
    font-size: 11px;
    background: var(--warning-soft, rgba(245,158,11,0.12));
    color: var(--warning);
  }

  .ctx-modal__hint--critical {
    background: var(--error-soft, rgba(239,68,68,0.12));
    color: var(--error);
  }

  .ctx-modal__foot {
    display: flex;
    justify-content: flex-end;
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }

  .ctx-modal__compress {
    background: var(--accent);
    color: var(--accent-fg, #fff);
    border: none;
    border-radius: 4px;
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.15s ease;
  }

  .ctx-modal__compress:hover:not(:disabled) {
    opacity: 0.85;
  }

  .ctx-modal__compress:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
`;
