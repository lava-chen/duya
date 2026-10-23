// Shared single-line chrome for every action row and group header.
//
// Lays out `[icon?] [verb] [summary] [rightSlot?] [duration?] [StatusDot]
// [caret?]`. The expand caret sits at the END of the row and is always
// visible — the reference transcripts (Codex / Claude Code) put it right
// after the diff stat on the tail of the line, so the affordance is
// discoverable without hovering.
//
// Rows that need extra affordances (e.g. FileEditToolRow's +N/-M stats,
// SubAgentToolRow's tool count tail) wrap the summary children with
// their own buttons inside the chrome, or push them into the rightSlot.

'use client';

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  CaretRightIcon,
  CheckCircleIcon,
  SpinnerGapIcon,
  XCircleIcon,
} from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import type { ToolStatus } from '../types';

interface ActionRowChromeProps {
  status: ToolStatus;
  /** Per-state verb translation key. Falls back to the literal empty
   *  string when undefined — useful for the Group header, whose
   *  summary text is already a complete sentence. */
  verbKey?: TranslationKey;
  /**
   * Plan 517 P3: pre-translated verb text. Takes precedence over
   * `verbKey` when present so callers that need interpolation
   * variables (e.g. compact step count) can pre-build the string
   * instead of forcing the chrome to know about every consumer's
   * interpolation shape.
   */
  verbText?: string;
  /** Optional leading icon rendered before the verb. Used by rows that
   *  want a glyph next to the status text (e.g. MCP tool rows). Kept
   *  optional so existing rows are unaffected. */
  icon?: React.ReactNode;
  canExpand: boolean;
  expanded: boolean;
  hovered: boolean;
  durationMs?: number | null;
  /** Extra classes appended to the button. Use sparingly — prefer
   *  keeping the chrome uniform across rows. */
  buttonClassName?: string;
  /** Wraps the entire row click area. When omitted the chrome is
   *  inert (no click handler). */
  onClick?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  /** Optional right-side slot for row-specific affordances that
   *  shouldn't disturb the duration / StatusDot tail (e.g. the
   *  FileEditToolRow's +N/-M stats). */
  rightSlot?: React.ReactNode;
  /** Extra classes for the summary slot. The default is a truncating
   *  text span that grows to fill the row; a caller that renders an
   *  inline row (a truncating label followed by a fixed-width badge)
   *  passes its own flex layout instead. */
  summaryClassName?: string;
  children: React.ReactNode;
}

export function ActionRowChrome({
  status,
  verbKey,
  verbText,
  icon,
  canExpand,
  expanded,
  hovered,
  durationMs,
  buttonClassName,
  onClick,
  onMouseEnter,
  onMouseLeave,
  rightSlot,
  summaryClassName,
  children,
}: ActionRowChromeProps) {
  const { t } = useTranslation();
  const verb = verbText ?? (verbKey ? t(verbKey) : null);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      // No `gap-2` on purpose: the row's own paddings + the element
      // margins below define the rhythm, and the verb has to sit flush
      // against the left edge so expandable and plain rows share one
      // alignment baseline.
      className={
        'flex w-full items-center px-2 py-0.5 min-h-6 text-sm hover:bg-muted/30 rounded-sm transition-colors ' +
        (buttonClassName ?? '')
      }
    >
      {icon && (
        <span className="shrink-0 mr-1.5 flex items-center text-muted-foreground/70">
          {icon}
        </span>
      )}
      {verb && (
        <span className="font-medium text-muted-foreground/80 shrink-0 mr-2">{verb}</span>
      )}
      <span
        className={`font-mono text-left transition-colors ${
          hovered ? 'text-foreground' : 'text-muted-foreground/90'
        } ${summaryClassName ?? 'truncate flex-1'}`}
      >
        {children}
      </span>
      {rightSlot}
      {durationMs != null && durationMs > 0 && (
        <span className="text-muted-foreground/50 text-[11px] tabular-nums shrink-0 font-mono ml-2">
          {formatDuration(durationMs)}
        </span>
      )}
      <span className="ml-2">
        <StatusDot status={status} />
      </span>
      {/* Caret sits at the END of the row and is always visible — the
          reference transcripts (Codex / Claude Code) show the expand
          affordance at the tail of the line, next to the diff stat,
          instead of hiding it behind a hover on the left edge. */}
      {canExpand && (
        <span
          aria-hidden="true"
          className="ml-1 inline-flex shrink-0 items-center justify-center"
          data-testid="row-caret"
        >
          <CaretRightIcon
            size={10}
            className={`text-muted-foreground/60 transition-transform duration-200 ${
              expanded ? 'rotate-90' : ''
            }`}
          />
        </span>
      )}
    </button>
  );
}

export function StatusDot({ status }: { status: ToolStatus }) {
  return (
    <AnimatePresence mode="wait">
      {status === 'running' && (
        <motion.span
          key="running"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="inline-flex"
        >
          <SpinnerGapIcon size={14} className="shrink-0 animate-spin text-muted-foreground/50" />
        </motion.span>
      )}
      {status === 'success' && (
        <motion.span
          key="success"
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 400, damping: 20 }}
          className="inline-flex"
        >
          <CheckCircleIcon size={14} className="shrink-0 text-green-500" />
        </motion.span>
      )}
      {status === 'error' && (
        <motion.span
          key="error"
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 400, damping: 20 }}
          className="inline-flex"
        >
          <XCircleIcon size={14} className="shrink-0 text-red-500" />
        </motion.span>
      )}
    </AnimatePresence>
  );
}

// Local copy of the duration formatter so the chrome doesn't reach back
// into ToolActionsGroup. Kept in sync with the parent file's
// `formatDuration`; both are 4-line helpers and intentionally duplicated
// to avoid a circular import between row / chrome / group modules.
function formatDuration(ms: number): string {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds.toFixed(0)}s`;
  }
  return `${seconds.toFixed(1)}s`;
}
