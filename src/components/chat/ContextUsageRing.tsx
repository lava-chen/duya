'use client';

import { useEffect, useRef, useState } from 'react';
import type { Message } from '@/types/message';
import { useContextUsage, type ContextUsage } from '@/hooks/useContextUsage';
import { formatTokensPi } from '@/lib/context-usage-utils';
import { Button } from '@/components/ui/Button';

interface ContextUsageRingProps {
  messages: Message[];
  sessionId?: string;
  modelName?: string;
  contextWindow?: number;
  onCompress?: () => void;
  isCompacting?: boolean;
}

/**
 * Small ring trigger next to the input. On hover the ring slides a pi-style
 * stats line out to the left (cumulative ↑input / ↓output / R cache / $ cost,
 * then the current context %), updating live from the worker during
 * streaming. No click popup — the hover line is the only detail view.
 */
export function ContextUsageRing({
  messages,
  sessionId,
  modelName,
  contextWindow,
  onCompress,
  isCompacting = false,
}: ContextUsageRingProps) {
  const usage = useContextUsage(messages, modelName, contextWindow, sessionId);
  const [hovered, setHovered] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelHide = () => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };
  const scheduleHide = () => {
    cancelHide();
    hideTimer.current = setTimeout(() => setHovered(false), 150);
  };

  useEffect(() => {
    return () => cancelHide();
  }, []);

  const size = 18;
  const strokeWidth = 2.5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - usage.ratio * circumference;

  let strokeColor = 'var(--muted)';
  if (usage.hasData) {
    if (usage.state === 'critical') strokeColor = 'var(--error)';
    else if (usage.state === 'warning') strokeColor = 'var(--warning)';
    else strokeColor = 'var(--success)';
  }

  const effectiveWindow = contextWindow || usage.contextWindow;
  // `(auto)` mirrors pi's footer: it means the context window was NOT pinned
  // by the user (no 200K/1M override from provider capabilities), so the
  // window is auto-resolved from the model. When a window is pinned, the tag
  // is hidden because the fraction is then exact, not "auto".
  const isAutoWindow = !contextWindow;
  const ctxClass =
    usage.state === 'critical'
      ? 'context-usage-ring-ctx context-usage-ring-ctx--critical'
      : usage.state === 'warning'
        ? 'context-usage-ring-ctx context-usage-ring-ctx--warn'
        : 'context-usage-ring-ctx';

  // pi-style footer line: ↑input ↓output RcacheRead [WcacheWrite] [CH hit%]
  // [ $cost] {context}%/{window} (auto). Totals are session-cumulative.
  const f = formatTokensPi;
  const hasCache = usage.totalCacheRead > 0 || usage.totalCacheWrite > 0;
  const ctxPercent = usage.hasData
    ? (usage.ratio * 100).toFixed(1)
    : '?';

  return (
    <>
      <div
        className="context-usage-ring-wrap"
        data-hovered={hovered}
        onMouseEnter={() => {
          cancelHide();
          setHovered(true);
        }}
        onMouseLeave={scheduleHide}
      >
        <div
          className="context-usage-ring-stats-shell"
          aria-hidden={!hovered}
        >
          <div className="context-usage-ring-stats">
            {usage.hasData && (
              <>
                {/* Group 1: cumulative token traffic (↑↓R/W).
                    Stats inside a group sit tight; groups are visually
                    separated by a middle-dot in CSS (::before). */}
                <span className="context-usage-ring-group">
                  <span className="context-usage-ring-stat">
                    <span className="context-usage-ring-arrow">↑</span>
                    {f(usage.totalInput)}
                  </span>
                  <span className="context-usage-ring-stat">
                    <span className="context-usage-ring-arrow">↓</span>
                    {f(usage.totalOutput)}
                  </span>
                  {usage.totalCacheRead > 0 && (
                    <span className="context-usage-ring-stat">
                      <span className="context-usage-ring-arrow">R</span>
                      {f(usage.totalCacheRead)}
                    </span>
                  )}
                  {usage.totalCacheWrite > 0 && (
                    <span className="context-usage-ring-stat">
                      <span className="context-usage-ring-arrow">W</span>
                      {f(usage.totalCacheWrite)}
                    </span>
                  )}
                </span>

                {/* Group 2: cache hit rate. */}
                {hasCache && usage.cacheHitRate >= 0 && (
                  <span className="context-usage-ring-group">
                    <span className="context-usage-ring-stat">
                      CH{(usage.cacheHitRate * 100).toFixed(1)}%
                    </span>
                  </span>
                )}

                {/* Group 3: cost. */}
                {usage.totalCost > 0 && (
                  <span className="context-usage-ring-group">
                    <span className="context-usage-ring-stat">
                      ${usage.totalCost.toFixed(3)}
                    </span>
                  </span>
                )}

                {/* Group 4: current context % — the only number that's a
                    live state indicator rather than cumulative stat. Slight
                    emphasis via --primary so the eye lands here. */}
                <span className="context-usage-ring-group context-usage-ring-group--primary">
                  <span className={ctxClass}>
                    {ctxPercent}%/{f(effectiveWindow)}
                  </span>
                  {isAutoWindow && (
                    <span className="context-usage-ring-stat context-usage-ring-stat--dim">
                      (auto)
                    </span>
                  )}
                </span>
              </>
            )}
            {/* No usage data yet (brand-new session / history without
                tokenUsage): show a dim dash instead of a fake 0%. */}
            {!usage.hasData && (
              <span className="context-usage-ring-group">
                <span className="context-usage-ring-stat context-usage-ring-stat--dim">
                  —
                </span>
              </span>
            )}
            {onCompress && usage.state !== 'normal' && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="context-usage-ring-compress"
                onClick={onCompress}
                disabled={isCompacting}
                title="Compress context"
              >
                {isCompacting ? '…' : 'compress'}
              </Button>
            )}
          </div>
        </div>

        <span
          className="context-usage-ring-trigger"
          role="img"
          aria-label="Context usage"
        >
          <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            className="context-usage-ring-svg"
          >
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              strokeWidth={strokeWidth}
              className="context-usage-ring-bg"
            />
            {usage.hasData && usage.ratio > 0 && (
              <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                strokeWidth={strokeWidth}
                strokeDasharray={circumference}
                strokeDashoffset={offset}
                strokeLinecap="round"
                className="context-usage-ring-fill"
                style={{ stroke: strokeColor }}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
              />
            )}
          </svg>
        </span>
      </div>

      <style>{`
        .context-usage-ring-wrap {
          position: relative;
          display: inline-flex;
          align-items: center;
          max-width: 100%;
        }

        /* Slide-out stats line: grid 0fr→1fr animates the width smoothly from
           the ring leftwards (pi-style footer line). */
        .context-usage-ring-stats-shell {
          display: grid;
          grid-template-columns: 0fr;
          opacity: 0;
          overflow: hidden;
          max-width: 0;
          transition:
            grid-template-columns 0.28s cubic-bezier(0.22, 1, 0.36, 1),
            opacity 0.22s ease,
            max-width 0.28s cubic-bezier(0.22, 1, 0.36, 1);
        }
        .context-usage-ring-wrap[data-hovered='true'] .context-usage-ring-stats-shell,
        .context-usage-ring-wrap:hover .context-usage-ring-stats-shell {
          grid-template-columns: 1fr;
          opacity: 1;
          max-width: 480px;
        }

        .context-usage-ring-stats {
          min-width: 0;
          overflow: hidden;
          white-space: nowrap;
          display: flex;
          align-items: center;
          /* gap is the inter-group space; groups manage their own intra-gap.
             The ::before separator lives inside each group and gets the
             left margin via the selector below. */
          gap: 8px;
          padding-right: 4px;
          font-size: 11px;
          line-height: 1;
          font-variant-numeric: tabular-nums;
          color: var(--muted);
        }

        /* Semantic grouping: stats inside a group sit tight; groups are
           separated by a middle-dot rendered via ::before on every group
           except the first. */
        .context-usage-ring-group {
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .context-usage-ring-group + .context-usage-ring-group::before,
        .context-usage-ring-compress::before {
          content: '·';
          margin-right: 8px;
          opacity: 0.4;
          font-weight: 400;
        }
        .context-usage-ring-compress::before {
          margin-right: 6px;
          margin-left: -2px;
        }

        /* Live context % is the only number that's a state indicator
           rather than a cumulative stat — nudge the eye toward it. */
        .context-usage-ring-group--primary {
          padding: 1px 5px;
          margin-left: -2px;
          border-radius: 3px;
          background: var(--bg-hover);
        }

        .context-usage-ring-arrow {
          font-weight: 600;
        }

        .context-usage-ring-ctx {
          font-weight: 600;
        }
        .context-usage-ring-ctx--warn {
          color: var(--warning);
        }
        .context-usage-ring-ctx--critical {
          color: var(--error);
        }
        .context-usage-ring-stat--dim {
          opacity: 0.65;
        }

        .context-usage-ring-trigger {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 4px;
          background: transparent;
          border: none;
          cursor: default;
          border-radius: 4px;
          transition: background-color 0.15s ease;
          position: relative;
          z-index: 2;
          flex: none;
        }
        .context-usage-ring-trigger:hover {
          background-color: var(--bg-hover);
        }

        .context-usage-ring-svg {
          display: block;
        }

        .context-usage-ring-bg {
          stroke: var(--border);
        }

        .context-usage-ring-fill {
          transition: stroke-dashoffset 0.3s ease, stroke 0.3s ease;
        }

        .context-usage-ring-compress {
          background: transparent;
          border: 1px solid var(--border);
          border-radius: 4px;
          color: var(--warning);
          cursor: pointer;
          font-size: 10px;
          padding: 2px 6px;
          font-weight: 500;
          flex: none;
        }
        .context-usage-ring-compress:hover:not(:disabled) {
          background: var(--bg-hover);
        }
        .context-usage-ring-compress:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      `}</style>
    </>
  );
}
