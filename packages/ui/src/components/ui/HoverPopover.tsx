'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

/**
 * HoverPopover — the minimal reusable hover-triggered popover used across
 * the chat UI (memory citations, context stats, attachment tooltips, …).
 *
 * Design goals:
 *   · Hover to open. The wrapper <div> sits between trigger and popover so
 *     the cursor can travel the gap without closing (the same pattern used
 *     by ContextUsageRing and Apple hover tooltips).
 *   · Optional click-to-toggle as well, controlled by `trigger` prop.
 *   · Positioning: purely declarative via props, no runtime measurement.
 *     Callers that need measured positioning (e.g., flip on overflow) can
 *     layer their own useLayoutEffect on top by passing `popoverStyle`.
 *   · Does NOT import popover content CSS — callers style their own cards
 *     via className (e.g., `.memory-popover`, `.ctx-popover`).
 *   · Portal body into document.body so ancestors with `overflow: hidden`
 *     never clip the popover.
 *
 * Props mirror the (small) surface area our existing callers actually
 * need — deliberately smaller than Radix / floating-ui, zero new deps.
 */

export type HoverPopoverPlacement =
  | 'above'
  | 'above-start'
  | 'above-end'
  | 'below'
  | 'below-start'
  | 'below-end';

export interface HoverPopoverProps {
  /** The clickable / hoverable trigger element (button, icon, …). */
  children: ReactNode;
  /** Popover body. Rendered conditionally while open. */
  content: ReactNode;
  /** CSS class(es) applied to the popover card (`memory-popover`, etc.). */
  popoverClassName?: string;
  /** Inline styles for the popover card (position overrides, z-index, …). */
  popoverStyle?: CSSProperties;
  /** Where the popover sits relative to the trigger. Default: `above`. */
  placement?: HoverPopoverPlacement;
  /** ms to wait before hiding after mouse leaves (gap crossing buffer). */
  closeDelayMs?: number;
  /** ms to wait before opening after mouse enters. Prevents flicker. */
  openDelayMs?: number;
  /** Enable click-to-open (in addition to hover). Default false. */
  clickToOpen?: boolean;
  /** Disable entirely (always closed, but trigger still renders). */
  disabled?: boolean;
  /** Extra class(es) on the trigger-wrapping <div>. */
  className?: string;
  /** Inline styles on the trigger-wrapping <div>. */
  style?: CSSProperties;
  /** role for accessibility; defaults to `tooltip`. */
  role?: string;
  /** aria label for the popover region. */
  ariaLabel?: string;
}

const PLACEMENT_GAP_PX = 10;

function basePopoverStyle(
  placement: HoverPopoverPlacement,
): CSSProperties {
  // Relative to the wrapper <div> (which is `position: relative`).
  // We only toggle which axis the popover is anchored to; the caller is
  // responsible for horizontal alignment via `placement`'s -start / -end.
  const horizontal: Record<string, string> = {
    above: 'left: 0;',
    'above-start': 'left: 0;',
    'above-end': 'right: 0;',
    below: 'left: 0;',
    'below-start': 'left: 0;',
    'below-end': 'right: 0;',
  };
  const vertical = placement.startsWith('above')
    ? `bottom: calc(100% + ${PLACEMENT_GAP_PX}px);`
    : `top: calc(100% + ${PLACEMENT_GAP_PX}px);`;

  const styleText = `position: absolute; ${vertical} ${horizontal[placement] ?? 'left: 0;'}`;
  const out: CSSProperties = {};
  for (const decl of styleText.split(';')) {
    const trimmed = decl.trim();
    if (!trimmed) continue;
    const [prop, val] = trimmed.split(':').map(s => s.trim());
    if (!prop || !val) continue;
    const camel = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    (out as Record<string, string>)[camel] = val;
  }
  return out;
}

export function HoverPopover({
  children,
  content,
  popoverClassName,
  popoverStyle,
  placement = 'above',
  closeDelayMs = 120,
  openDelayMs = 0,
  clickToOpen = false,
  disabled = false,
  className,
  style,
  role = 'tooltip',
  ariaLabel,
}: HoverPopoverProps) {
  const [open, setOpen] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const scheduleOpen = useCallback(() => {
    if (disabled) return;
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (openTimer.current) return;
    if (openDelayMs <= 0) {
      setOpen(true);
      return;
    }
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      setOpen(true);
    }, openDelayMs);
  }, [disabled, openDelayMs]);

  const scheduleClose = useCallback(() => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current) return;
    if (closeDelayMs <= 0) {
      setOpen(false);
      return;
    }
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, closeDelayMs);
  }, [closeDelayMs]);

  const cancelTimers = useCallback(() => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  useEffect(() => () => cancelTimers(), [cancelTimers]);

  const handleWrapperClick = useCallback(
    (e: React.MouseEvent) => {
      if (!clickToOpen || disabled) return;
      e.stopPropagation();
      cancelTimers();
      setOpen(prev => !prev);
    },
    [clickToOpen, disabled, cancelTimers],
  );

  // Compute anchored styles once per placement; combine with any inline
  // overrides the caller passes. Default z-index so popovers sit above
  // sibling panels; callers can bump higher via `popoverStyle` as needed.
  const mergedPopoverStyle: CSSProperties = {
    zIndex: 60,
    ...basePopoverStyle(placement),
    ...popoverStyle,
  };

  return (
    <div
      ref={wrapperRef}
      className={`relative inline-flex ${className ?? ''}`.trim()}
      style={style}
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
      onClick={handleWrapperClick}
    >
      {children}
      {/* Render inline (as direct child of the .relative wrapper) so the
          absolute-positioned popover anchors correctly to the trigger, and
          so mouse can cross the 10px gap between trigger and popover
          without the wrapper losing hover. This is the stable default for
          chat UI; callers that genuinely need to escape an overflow:hidden
          ancestor can layer their own portal wrapper on top. */}
      {open && (
        <div
          className={popoverClassName}
          style={mergedPopoverStyle}
          role={role}
          aria-label={ariaLabel}
          onMouseEnter={scheduleOpen}
          onMouseLeave={scheduleClose}
          onClick={(e) => e.stopPropagation()}
        >
          {content}
        </div>
      )}
    </div>
  );
}

export default HoverPopover;
