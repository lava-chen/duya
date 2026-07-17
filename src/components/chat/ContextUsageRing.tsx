'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ContextUsage as StreamingContextUsage, Message } from '@/types/message';
import {
  useContextUsage,
  useContextBreakdown,
  type ContextUsage,
} from '@/hooks/useContextUsage';
import { ContextUsagePopover } from './ContextUsagePopover';
import { ContextBreakdownModal } from './ContextBreakdownModal';

interface ContextUsageRingProps {
  messages: Message[];
  modelName?: string;
  contextWindow?: number;
  /** Live usage arrives before the canonical assistant message is persisted. */
  streamingContextUsage?: StreamingContextUsage | null;
  onCompress?: () => void;
  isCompacting?: boolean;
}

const HIDE_DELAY_MS = 200;

/**
 * Small ring trigger next to the input that, on hover, shows a popover
 * with the context grid + summary numbers, and on click opens a modal
 * with a per-category breakdown.
 *
 * Hover is driven by React state (not pure CSS :hover) so the popover
 * stays open while the user moves the cursor into it — there's a 200ms
 * grace period after the cursor leaves the wrapper, and a transparent
 * "bridge" element between the trigger and the popover covers the gap.
 */
export function ContextUsageRing({
  messages,
  modelName,
  contextWindow,
  streamingContextUsage,
  onCompress,
  isCompacting = false,
}: ContextUsageRingProps) {
  const persistedUsage = useContextUsage(messages, modelName, contextWindow);
  const usage = useMemo<ContextUsage>(() => {
    if (!streamingContextUsage || streamingContextUsage.contextWindow <= 0) {
      return persistedUsage;
    }

    const ratio = Math.min(
      1,
      Math.max(0, streamingContextUsage.percentFull / 100),
    );
    const state = ratio >= 0.95 ? 'critical' : ratio >= 0.8 ? 'warning' : 'normal';
    return {
      ...persistedUsage,
      contextWindow: streamingContextUsage.contextWindow,
      used: streamingContextUsage.usedTokens,
      ratio,
      estimatedNextTurn: streamingContextUsage.usedTokens,
      estimatedNextRatio: ratio,
      hasData: true,
      state,
    };
  }, [persistedUsage, streamingContextUsage]);
  const [hovered, setHovered] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const shouldBuildBreakdown = hovered || detailsOpen;
  const breakdown = useContextBreakdown(
    shouldBuildBreakdown ? messages : [],
    shouldBuildBreakdown ? usage : { ...usage, hasData: false },
    typeof window !== 'undefined' && window.innerWidth < 480,
  );
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelHide = () => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };
  const scheduleHide = () => {
    cancelHide();
    hideTimer.current = setTimeout(() => setHovered(false), HIDE_DELAY_MS);
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

  return (
    <>
      <div
        className="context-usage-ring-wrapper"
        onMouseEnter={() => {
          cancelHide();
          setHovered(true);
        }}
        onMouseLeave={scheduleHide}
      >
        <button
          type="button"
          className="context-usage-ring-trigger"
          aria-label="Context usage"
          aria-expanded={hovered}
          onClick={() => setDetailsOpen(true)}
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
        </button>

        {/* Transparent bridge covers the 8px gap so the cursor can travel
            from the trigger into the popover without leaving the wrapper. */}
        <div className="context-usage-ring-bridge" aria-hidden="true" />

        <div
          className={
            'context-usage-ring-card ' +
            (hovered ? 'context-usage-ring-card--open' : '')
          }
          // Mouse events on the card itself keep hover alive while the
          // cursor is inside the popover.
          onMouseEnter={cancelHide}
          onMouseLeave={scheduleHide}
        >
          <ContextUsagePopover
            usage={usage}
            breakdown={breakdown}
            contextWindow={effectiveWindow}
            onOpenDetails={() => setDetailsOpen(true)}
            onCompress={onCompress}
            isCompacting={isCompacting}
          />
        </div>
      </div>

      <ContextBreakdownModal
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        usage={usage}
        breakdown={breakdown}
        contextWindow={effectiveWindow}
        onCompress={onCompress}
        isCompacting={isCompacting}
      />

      <style>{`
        .context-usage-ring-wrapper {
          position: relative;
          display: inline-flex;
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

        /* Invisible bridge between the trigger and the popover — covers
           the 8px gap so the cursor never leaves the wrapper while
           moving toward the popover. */
        .context-usage-ring-bridge {
          position: absolute;
          right: 0;
          bottom: 100%;
          width: 100%;
          height: 12px;
          pointer-events: auto;
        }

        .context-usage-ring-card {
          position: absolute;
          bottom: calc(100% + 8px);
          right: 0;
          opacity: 0;
          visibility: hidden;
          transform: translateY(4px);
          transition: opacity 0.15s ease, transform 0.15s ease, visibility 0.15s ease;
          pointer-events: none;
          z-index: 1;
        }

        .context-usage-ring-card--open {
          opacity: 1;
          visibility: visible;
          transform: translateY(0);
          pointer-events: auto;
        }
      `}</style>
    </>
  );
}
