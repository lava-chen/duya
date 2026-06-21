// Shared single-line chrome for every action row and group header.
//
// Lays out `[verb] [summary] [duration?] [StatusDot]`. The leading caret
// is hidden until the row is hovered (or already expanded), so when the
// row is at rest it sits flush against the surrounding text.
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
  children: React.ReactNode;
}

export function ActionRowChrome({
  status,
  verbKey,
  canExpand,
  expanded,
  hovered,
  durationMs,
  buttonClassName,
  onClick,
  onMouseEnter,
  onMouseLeave,
  rightSlot,
  children,
}: ActionRowChromeProps) {
  const { t } = useTranslation();
  const verb = verbKey ? t(verbKey) : null;
  const showCaret = canExpand && (expanded || hovered);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      // Flex `gap-2` is intentionally absent: when the leading caret is
      // collapsed (no hover, not expanded), we want the verb to sit
      // flush against the row's left edge so the chrome aligns with
      // the surrounding text. The caret's motion.span animates its
      // own `marginRight` to push siblings only when it's visible.
      className={
        'flex w-full items-center px-2 py-0.5 min-h-6 text-sm hover:bg-muted/30 rounded-sm transition-colors ' +
        (buttonClassName ?? '')
      }
    >
      <AnimatePresence initial={false}>
        {canExpand && (
          <motion.span
            key="caret"
            aria-hidden="true"
            initial={{ width: 0, opacity: 0, marginRight: 0 }}
            animate={{
              width: showCaret ? 10 : 0,
              opacity: showCaret ? 1 : 0,
              marginRight: showCaret ? 8 : 0,
            }}
            exit={{ width: 0, opacity: 0, marginRight: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              flexShrink: 0,
            }}
          >
            <CaretRightIcon
              size={10}
              className={`text-muted-foreground/60 transition-transform duration-200 ${
                expanded ? 'rotate-90' : ''
              }`}
            />
          </motion.span>
        )}
      </AnimatePresence>
      {verb && (
        <span className="font-medium text-muted-foreground/80 shrink-0 mr-2">{verb}</span>
      )}
      <span
        className={`font-mono truncate flex-1 text-left transition-colors ${
          hovered ? 'text-foreground' : 'text-muted-foreground/90'
        }`}
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
