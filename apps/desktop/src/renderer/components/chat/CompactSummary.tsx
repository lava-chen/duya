// CompactSummary — the context-compaction record row in the message flow.
//
// When the agent compacts history, the summary lands in the stream as a
// message tagged `isCompactSummary` (rendered here), and during the active
// turn the compaction milestone is streamed as an inline `compact` action
// (also rendered here). Both render as action rows sharing the tool / hook
// row chrome:
//   - compacting: spinner + "compacting" verb
//   - done/success: [compress icon] 已对上下文进行压缩   [N messages],
//     expand to show the compressed summary text verbatim
//   - error:      failure verb
//
// All chrome is shared with `ActionRowChrome` so visual weight matches
// every other action row.

'use client';

import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CornersInIcon } from '@/components/icons';
import { ActionRowChrome } from './tools/chrome/ActionRowChrome';
import type { ToolStatus } from './tools/types';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/hooks/useTranslation';

interface CompactSummaryProps {
  /** The compressed summary text recorded in the message stream. */
  content?: string;
  /** Number of messages that were compacted into this summary. */
  compactedMessageCount?: number;
  /** Status→chrome mapping; 'success' matches a completed compaction. */
  status?: ToolStatus;
  /** Override the verb shown next to the icon. Defaults to the collapsed
   *  "已对上下文进行压缩" verb used by the durable summary row. */
  verbKey?: TranslationKey;
  /**
   * Plan 517 P3: when present, the verb interpolation receives `{count}`.
   * Used by per-step verbs like "summarizing 32 messages..." — the worker
   * emits messageCount on each `compact:step` start. The collapsed
   * terminal verb (and the historical compact summary) leave this undefined.
   */
  stepMessageCount?: number;
}

export function CompactSummary({
  content = '',
  compactedMessageCount = 0,
  status = 'success',
  verbKey = 'streaming.toolAction.compact.collapsed',
  stepMessageCount,
}: CompactSummaryProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);

  // A degenerate compaction can produce an empty summary; without body
  // text there is nothing to reveal, so the row stays inert.
  const canExpand = status === 'success' && content.trim().length > 0;

  // Right slot: how much went into the summary. Hidden below the sm
  // breakpoint so narrow viewports keep the collapsed row clean.
  const showCount = compactedMessageCount > 0;
  const countSlot = showCount ? (
    <span className="text-muted-foreground/40 text-[10px] font-mono hidden sm:inline shrink-0">
      {t(
        compactedMessageCount === 1
          ? 'streaming.toolAction.compact.messagesCompacted.one'
          : 'streaming.toolAction.compact.messagesCompacted.other',
        { count: compactedMessageCount },
      )}
    </span>
  ) : null;

  // Plan 517 P3: per-step verb interpolates {count} from the worker's
  // step message count. When undefined, the verb falls back to its no-
  // count form so legacy translations keep working.
  const verbWithCount =
    stepMessageCount !== undefined
      ? t(verbKey, { count: stepMessageCount })
      : t(verbKey);

  return (
    <div className="py-0.5">
      <ActionRowChrome
        status={status}
        verbText={verbWithCount}
        icon={<CornersInIcon size={14} />}
        canExpand={canExpand}
        expanded={expanded}
        hovered={hovered}
        onClick={() => canExpand && setExpanded((prev) => !prev)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        buttonClassName={canExpand ? 'cursor-pointer' : 'cursor-default'}
        rightSlot={countSlot}
      >
        {/* Children land in the chrome's mono/truncate span; keep it
            empty and let the verb carry the label — prose reads better
            outside the mono face. */}
        {null}
      </ActionRowChrome>

      <AnimatePresence initial={false}>
        {expanded && canExpand && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeInOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div className="mx-1 my-1 rounded-lg tool-card p-3 relative max-h-[60vh] overflow-y-auto">
              <pre className="text-xs text-foreground/85 whitespace-pre-wrap break-words font-mono leading-relaxed">
                {content}
              </pre>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
