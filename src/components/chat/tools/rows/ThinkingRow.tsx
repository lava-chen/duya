// ThinkingRow — collapsible row for the agent's "thinking" content.
//
// The summary is derived from the content: a leading bold span
// (`**…**`) or first markdown heading wins, otherwise we fall back to
// "Thinking..." (while streaming) or "Thought" (once stable). The
// expanded body is a verbatim dump of the thinking content inside a
// left-bordered block.

'use client';

import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BrainIcon, CaretRightIcon } from '@/components/icons';
import { Shimmer } from '../../Shimmer';

interface ThinkingRowProps {
  content: string;
  isStreaming?: boolean;
}

export function ThinkingRow({ content, isStreaming }: ThinkingRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);

  const summary = (() => {
    const boldMatch = content.match(/\*\*(.+?)\*\*/);
    if (boldMatch) return boldMatch[1];
    const headingMatch = content.match(/^#{1,4}\s+(.+)$/m);
    if (headingMatch) return headingMatch[1];
    return isStreaming ? 'Thinking...' : 'Thought';
  })();

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
          {isStreaming ? <Shimmer duration={1.5}>{summary}</Shimmer> : summary}
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
              {content}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
