// ThinkingRow — collapsible row for the agent's "thinking" content.
//
// While streaming, the collapsed row shows a live preview of the actual
// thinking text (paced by the adaptive typewriter) instead of a generic
// "Thinking..." label. Clicking the row expands the full content inside a
// left-bordered block. For stable rows we still prefer an explicit bold
// span or heading as the summary, falling back to a one-line preview.

'use client';

import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BrainIcon, CaretRightIcon } from '@/components/icons';
import { Shimmer } from '../../Shimmer';
import { useAdaptiveTypewriter } from '@/hooks/useAdaptiveTypewriter';

interface ThinkingRowProps {
  content: string;
  isStreaming?: boolean;
}

const PREVIEW_MAX_LENGTH = 120;

function makePreview(text: string): string {
  const plain = text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= PREVIEW_MAX_LENGTH) return plain;
  return plain.slice(0, PREVIEW_MAX_LENGTH).replace(/\s+\S*$/, '') + '…';
}

export function ThinkingRow({ content, isStreaming }: ThinkingRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);

  const streamedContent = useAdaptiveTypewriter(content, !!isStreaming);
  const previewSource = isStreaming ? streamedContent : content;

  const summary = (() => {
    if (isStreaming) {
      return makePreview(previewSource) || 'Thinking...';
    }
    const boldMatch = content.match(/\*\*(.+?)\*\*/);
    if (boldMatch) return boldMatch[1];
    const headingMatch = content.match(/^#{1,4}\s+(.+)$/m);
    if (headingMatch) return headingMatch[1];
    return makePreview(content) || 'Thought';
  })();

  const displayedContent = isStreaming ? streamedContent : content;

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className="flex items-center gap-2 px-2 py-1 min-h-[28px] text-xs hover:bg-muted/30 rounded-sm transition-colors w-full"
      >
        {hovered ? (
          <CaretRightIcon
            size={14}
            className={`shrink-0 text-muted-foreground transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          />
        ) : (
          <BrainIcon size={14} className="shrink-0 text-muted-foreground" />
        )}
        <span className="font-mono text-muted-foreground/60 truncate flex-1 text-left">
          {isStreaming && summary === 'Thinking...' ? (
            <Shimmer duration={1.5}>{summary}</Shimmer>
          ) : (
            summary
          )}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div className="ml-4 px-2 py-1.5 text-xs text-muted-foreground/70 border-l-2 border-border/30 prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap">
              {displayedContent}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
