// CompactSummary — the context-compaction record row in the message flow.
//
// When the agent compacts history, the summary lands in the stream as a
// message tagged `isCompactSummary`. This renders that record as an
// action row sharing the tool / hook row chrome:
//   - collapsed: [compress icon] 已对上下文进行压缩   [N messages]
//   - expanded: card showing the compressed summary text verbatim
//
// All chrome is shared with `ActionRowChrome` so visual weight matches
// every other action row.

'use client';

import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CornersInIcon } from '@/components/icons';
import { ActionRowChrome } from './tools/chrome/ActionRowChrome';
import { useTranslation } from '@/hooks/useTranslation';

interface CompactSummaryProps {
  /** The compressed summary text recorded in the message stream. */
  content: string;
  /** Number of messages that were compacted into this summary. */
  compactedMessageCount: number;
}

export function CompactSummary({ content, compactedMessageCount }: CompactSummaryProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);

  // A degenerate compaction can produce an empty summary; without body
  // text there is nothing to reveal, so the row stays inert.
  const canExpand = content.trim().length > 0;

  // Right slot: how much went into the summary. Hidden below the sm
  // breakpoint so narrow viewports keep the collapsed row clean.
  const countSlot =
    compactedMessageCount > 0 ? (
      <span className="text-muted-foreground/40 text-[10px] font-mono hidden sm:inline shrink-0">
        {t(
          compactedMessageCount === 1
            ? 'streaming.toolAction.compact.messagesCompacted.one'
            : 'streaming.toolAction.compact.messagesCompacted.other',
          { count: compactedMessageCount },
        )}
      </span>
    ) : null;

  return (
    <div className="py-0.5">
      <ActionRowChrome
        status="success"
        verbKey={'streaming.toolAction.compact.collapsed'}
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
