'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Message } from '@/types/message';
import { useContextUsage, type ContextUsage } from '@/hooks/useContextUsage';
import { formatTokensPi, type ModelPricing } from '@/lib/context-usage-utils';
import { Button } from '@/components/ui/Button';

interface ContextUsageRingProps {
  messages: Message[];
  sessionId?: string;
  modelName?: string;
  contextWindow?: number;
  /** Real per-model pricing (provider_model_capabilities). When absent the
   *  hover line hides the $ figure instead of pricing at hardcoded rates. */
  pricing?: ModelPricing;
  onCompress?: () => void;
  isCompacting?: boolean;
  /**
   * 'line' (default) — pi-style stats line slides out leftwards (session
   *   composer footer).
   * 'popup' — hover/pin opens a small stats CARD above the ring (bot
   *   composer, ring sits next to the send button with no room to slide).
   * 'panel' — bare trigger only: expansion state is owned by the parent,
   *   which renders a <ContextUsagePanel> below the composer (the input
   *   box shifts up; no space is reserved while collapsed).
   */
  variant?: 'line' | 'popup' | 'panel';
  /** When true, the stats are shown by default and clicking the ring hides
   *  them. Hover has no effect in reversed mode. Default false. */
  reversed?: boolean;
  /** variant='panel' only — controlled expansion state + toggle callback. */
  expanded?: boolean;
  onToggle?: () => void;
}

interface ContextUsageDataProps {
  messages: Message[];
  sessionId?: string;
  modelName?: string;
  contextWindow?: number;
  pricing?: ModelPricing;
  onCompress?: () => void;
  isCompacting?: boolean;
}

/**
 * Small ring trigger next to the input. On hover the ring slides a pi-style
 * stats line out to the left (cumulative ↑input / ↓output / R cache / $ cost,
 * then the current context %), updating live from the worker during
 * streaming. Clicking the ring once pins the stats line open — it survives
 * mouse-leave and keeps live-updating; only another click on the ring
 * (or Enter/Space on it) unpins.
 *
 * variant='panel' renders the ring as a bare controlled trigger: the stats
 * live in the sibling <ContextUsagePanel> the parent mounts below the
 * composer, so clicking just flips the parent's open state.
 */
export function ContextUsageRing({
  messages,
  sessionId,
  modelName,
  contextWindow,
  pricing,
  onCompress,
  isCompacting = false,
  variant = 'line',
  reversed = false,
  expanded,
  onToggle,
}: ContextUsageRingProps) {
  const usage = useContextUsage(messages, modelName, contextWindow, sessionId, pricing);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
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

  // Click-to-pin: a single click holds the stats line open regardless of
  // hover; only another click on the ring (or Enter/Space on it) unpins —
  // outside clicks and Escape deliberately leave it alone.
  const togglePin = () => {
    cancelHide();
    setPinned((p) => !p);
  };

  // Panel variant: the ring is a bare trigger — expansion lives with the
  // parent (the stats panel renders below the composer, not here).
  const isPanel = variant === 'panel';
  const handleTrigger = () => {
    if (isPanel) onToggle?.();
    else togglePin();
  };

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

  // The ratio and denominator both come from useContextUsage's resolved
  // snapshot, so a caller prop cannot display a different window than the
  // one used to calculate the percentage.
  const effectiveWindow = usage.contextWindow;
  // `(auto)` marks catalog/default resolution. A capability window is treated
  // as explicitly configured and hides the mark.
  // Plan 577 §4: when the resolution fell through BOTH the capability row
  // and the model catalog (windowSource === 'default'), the ring shows the
  // stronger `(auto · uncapped)` mark — the 200K fallback fired and the
  // ring's fraction may be silently wrong (plan 517 R1 split).
  const isAutoWindow = usage.windowSource !== 'capability';
  const autoWindowLabel =
    usage.windowSource === 'default' ? '(auto · uncapped)' : '(auto)';
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

  const statsExpanded = isPanel
    ? Boolean(expanded)
    : reversed
      ? !pinned
      : (hovered || pinned);

  // Popup-variant rows (bot composer): label/value pairs over the same
  // live `usage` data the line variant slides out.
  const popoverRows: Array<{ label: string; value: ReactNode; dim?: boolean }> = [];
  if (usage.hasData) {
    popoverRows.push({
      label: 'Context',
      value: (
        <>
          <span className={ctxClass}>{ctxPercent}%</span>
          {' · '}
          {f(usage.used)} / {f(effectiveWindow)}
          {isAutoWindow ? ` ${autoWindowLabel}` : ''}
        </>
      ),
    });
    popoverRows.push({ label: 'Input ↑', value: f(usage.totalInput) });
    popoverRows.push({ label: 'Output ↓', value: f(usage.totalOutput) });
    if (usage.totalCacheRead > 0)
      popoverRows.push({ label: 'Cache read R', value: f(usage.totalCacheRead) });
    if (usage.totalCacheWrite > 0)
      popoverRows.push({ label: 'Cache write W', value: f(usage.totalCacheWrite) });
    if (hasCache && usage.cacheHitRate >= 0)
      popoverRows.push({ label: 'Hit rate CH', value: `${(usage.cacheHitRate * 100).toFixed(1)}%` });
    if (usage.totalCost > 0)
      popoverRows.push({ label: 'Cost $', value: `$${usage.totalCost.toFixed(3)}` });
  }

  return (
    <>
      <div
        className="context-usage-ring-wrap"
        data-expanded={statsExpanded}
        onMouseEnter={() => {
          cancelHide();
          setHovered(true);
        }}
        onMouseLeave={scheduleHide}
      >
        {variant === 'popup' ? (
          <div className="context-usage-popover" role="status" aria-hidden={!statsExpanded}>
            {popoverRows.length > 0 ? (
              popoverRows.map((row) => (
                <div key={row.label} className="context-usage-popover__row">
                  <span className="context-usage-popover__label">{row.label}</span>
                  <span className={`context-usage-popover__value${row.dim ? ' context-usage-popover__value--dim' : ''}`}>
                    {row.value}
                  </span>
                </div>
              ))
            ) : (
              <div className="context-usage-popover__row">
                <span className="context-usage-popover__label">Context</span>
                <span className="context-usage-popover__value context-usage-popover__value--dim">?</span>
              </div>
            )}
            {onCompress && usage.hasData && (
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
        ) : variant === 'panel' ? null : (
        <div
          className="context-usage-ring-stats-shell"
          aria-hidden={!statsExpanded}
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
                      {autoWindowLabel}
                    </span>
                  )}
                </span>
              </>
            )}
            {/* No anchor yet (brand-new session / post-compaction /
                history without usage blocks): show "?" instead of a fake
                number — matches pi's footer unknown state. */}
            {!usage.hasData && (
              <span className="context-usage-ring-group">
                <span className="context-usage-ring-stat context-usage-ring-stat--dim">
                  ?
                </span>
              </span>
            )}
            {onCompress && usage.hasData && (
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
        )}

        <span
          className="context-usage-ring-trigger"
          role="button"
          tabIndex={0}
          aria-pressed={isPanel ? Boolean(expanded) : pinned}
          aria-label="Context usage"
          data-pinned={isPanel ? Boolean(expanded) : pinned}
          onClick={(e) => {
            e.stopPropagation();
            handleTrigger();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              handleTrigger();
            }
          }}
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
        /* Expansion is state-driven (hover OR pinned) via data-expanded,
           so a pinned line stays open even when the cursor is elsewhere. */
        .context-usage-ring-wrap[data-expanded='true'] .context-usage-ring-stats-shell {
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
          cursor: pointer;
          border-radius: 4px;
          transition: background-color 0.15s ease;
          position: relative;
          z-index: 2;
          flex: none;
        }
        .context-usage-ring-trigger:hover {
          background-color: var(--bg-hover);
        }
        /* Pinned: keep the hover tint while the mouse is elsewhere, plus a
           hairline inset so "this is held open" reads at a glance. */
        .context-usage-ring-trigger[data-pinned='true'] {
          background-color: var(--bg-hover);
          box-shadow: inset 0 0 0 1px var(--border);
        }
        .context-usage-ring-trigger:focus-visible {
          outline: 1px solid var(--accent);
          outline-offset: 1px;
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

        /* popup variant — small stats card above the ring (bot composer).
           Same hover/pin state as the line variant, different presentation:
           a label/value card instead of a slide-out line. */
        .context-usage-popover {
          position: absolute;
          bottom: calc(100% + 10px);
          right: 0;
          z-index: 60;
          min-width: 210px;
          padding: 10px 12px;
          border: 1px solid var(--border);
          border-radius: 12px;
          background: var(--surface-solid, var(--surface));
          box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
          display: flex;
          flex-direction: column;
          gap: 6px;
          opacity: 0;
          transform: translateY(4px);
          pointer-events: none;
          transition: opacity 0.15s ease, transform 0.15s ease;
        }
        .context-usage-ring-wrap[data-expanded='true'] .context-usage-popover {
          opacity: 1;
          transform: none;
          pointer-events: auto;
        }
        .context-usage-popover__row {
          display: flex;
          align-items: baseline;
          gap: 12px;
          font-size: 12px;
          line-height: 1.4;
        }
        .context-usage-popover__label {
          flex: 1 1 auto;
          color: var(--muted);
        }
        .context-usage-popover__value {
          font-variant-numeric: tabular-nums;
          color: var(--text);
          text-align: right;
          white-space: nowrap;
        }
        .context-usage-popover__value--dim {
          opacity: 0.65;
        }
      `}</style>
    </>
  );
}

/**
 * Context-stats panel rendered BELOW the composer input box. MessageInput
 * owns the open state (the panel-variant ring in the toolbar is just the
 * trigger): the shell is a 0fr→1fr grid row, so while open it animates open
 * and the bottom-anchored composer column pushes the input box up, while
 * closed it reserves no space at all. Content stays mounted through the
 * collapse animation and is hidden (visibility + aria-hidden) once closed.
 */
export function ContextUsagePanel({
  messages,
  sessionId,
  modelName,
  contextWindow,
  pricing,
  onCompress,
  isCompacting = false,
  open,
}: ContextUsageDataProps & { open: boolean }) {
  const usage = useContextUsage(messages, modelName, contextWindow, sessionId, pricing);

  const effectiveWindow = usage.contextWindow;
  // Match the ring: catalog/default resolution is automatic; a capability
  // window is explicitly configured.
  // Plan 577 §4: windowSource 'default' upgrades the mark to
  // `(auto · uncapped)` — the 200K fallback fired (plan 517 R1 visibility).
  const isAutoWindow = usage.windowSource !== 'capability';
  const autoWindowLabel =
    usage.windowSource === 'default' ? '(auto · uncapped)' : '(auto)';
  const ctxPercent = usage.hasData ? (usage.ratio * 100).toFixed(1) : '?';
  const ctxClass =
    usage.state === 'critical'
      ? 'context-usage-ring-ctx context-usage-ring-ctx--critical'
      : usage.state === 'warning'
        ? 'context-usage-ring-ctx context-usage-ring-ctx--warn'
        : 'context-usage-ring-ctx';

  const f = formatTokensPi;
  const hasCache = usage.totalCacheRead > 0 || usage.totalCacheWrite > 0;

  return (
    <div className="context-usage-panel-shell" data-open={open} aria-hidden={!open}>
      <div className="context-usage-panel-clip">
        <div className="context-usage-panel" role="status">
          {/* Current context state first — the number the ring's color
              mirrors, emphasized like the ring's primary group. */}
          <span className="context-usage-panel-item context-usage-panel-item--primary">
            <span className={ctxClass}>{ctxPercent}%</span>
            <span className="context-usage-panel-dim">
              · {f(usage.used)} / {f(effectiveWindow)}
              {isAutoWindow ? ` ${autoWindowLabel}` : ''}
            </span>
          </span>

          {/* Session-cumulative traffic — same totals the stats line shows. */}
          <span className="context-usage-panel-item">
            <span className="context-usage-panel-arrow">↑</span>
            {f(usage.totalInput)}
          </span>
          <span className="context-usage-panel-item">
            <span className="context-usage-panel-arrow">↓</span>
            {f(usage.totalOutput)}
          </span>
          {usage.totalCacheRead > 0 && (
            <span className="context-usage-panel-item">
              <span className="context-usage-panel-arrow">R</span>
              {f(usage.totalCacheRead)}
            </span>
          )}
          {usage.totalCacheWrite > 0 && (
            <span className="context-usage-panel-item">
              <span className="context-usage-panel-arrow">W</span>
              {f(usage.totalCacheWrite)}
            </span>
          )}
          {hasCache && usage.cacheHitRate >= 0 && (
            <span className="context-usage-panel-item">
              CH {(usage.cacheHitRate * 100).toFixed(1)}%
            </span>
          )}
          {usage.totalCost > 0 && (
            <span className="context-usage-panel-item">
              ${usage.totalCost.toFixed(3)}
            </span>
          )}
          {onCompress && usage.hasData && (
            <button
              type="button"
              className="context-usage-panel-compress"
              onClick={onCompress}
              disabled={isCompacting}
              title="Compress context"
            >
              {isCompacting ? '…' : 'compress'}
            </button>
          )}
        </div>
      </div>

      <style>{`
        .context-usage-panel-shell {
          display: grid;
          grid-template-rows: 0fr;
          opacity: 0;
          visibility: hidden;
          transition:
            grid-template-rows 0.24s cubic-bezier(0.22, 1, 0.36, 1),
            opacity 0.2s ease,
            visibility 0s linear 0.24s;
        }
        .context-usage-panel-shell[data-open='true'] {
          grid-template-rows: 1fr;
          opacity: 1;
          visibility: visible;
          transition:
            grid-template-rows 0.24s cubic-bezier(0.22, 1, 0.36, 1),
            opacity 0.2s ease;
        }
        .context-usage-panel-clip {
          overflow: hidden;
          min-height: 0;
        }
        .context-usage-panel {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: flex-end;
          gap: 4px 14px;
          padding: 4px 10px 6px;
          font-size: 11px;
          line-height: 1.5;
          font-variant-numeric: tabular-nums;
          color: var(--muted);
        }
        .context-usage-panel-item {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          white-space: nowrap;
        }
        .context-usage-panel-item--primary {
          padding: 1px 6px;
          border-radius: 4px;
          background: var(--bg-hover);
        }
        .context-usage-panel-arrow {
          font-weight: 600;
        }
        .context-usage-panel-dim {
          opacity: 0.75;
        }
        .context-usage-panel-compress {
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
        .context-usage-panel-compress:hover:not(:disabled) {
          background: var(--bg-hover);
        }
        .context-usage-panel-compress:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      `}</style>
    </div>
  );
}
