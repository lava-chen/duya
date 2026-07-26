// ThinkingRow — collapsible row for the agent's "thinking" content.
//
// Collapsed header shows a short preview (bold or heading extracted
// from the content, otherwise a 120-char trimmed snippet) via the
// shared ActionRowChrome so the chrome matches every other tool row.
//
// Expanded view replaces the header preview with the full content
// inside a `.tool-card` panel — the same surface used by BashToolRow,
// FileEditToolRow, etc. — and clamps the inner scroll container at
// `max-h-[160px]` so a long thought doesn't push the chat out of
// view. While streaming the typewriter paces the preview in the
// collapsed header (matches the previous behaviour); on expand the
// full stream is shown.

'use client';

import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Shimmer } from '../../Shimmer';
import { ActionRowChrome } from '../chrome/ActionRowChrome';
import { useAdaptiveTypewriter } from '@/hooks/useAdaptiveTypewriter';
import { useTranslation } from '@/hooks/useTranslation';

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
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);

  const streamedContent = useAdaptiveTypewriter(content, !!isStreaming);
  const previewSource = isStreaming ? streamedContent : content;

  // Localized fallback strings — previously hardcoded as 'Thinking...'
  // / 'Thought' / '思考' literals, which broke locale consistency
  // whenever the rest of the chrome was translated.
  const placeholder = t('streaming.toolAction.thinking.placeholder');
  const emptyFallback = t('streaming.toolAction.thinking.empty');

  const summary = (() => {
    if (isStreaming) {
      return makePreview(previewSource) || placeholder;
    }
    const boldMatch = content.match(/\*\*(.+?)\*\*/);
    if (boldMatch) return boldMatch[1];
    const headingMatch = content.match(/^#{1,4}\s+(.+)$/m);
    if (headingMatch) return headingMatch[1];
    return makePreview(content) || emptyFallback;
  })();

  const displayedContent = isStreaming ? streamedContent : content;

  return (
    <div>
      <ActionRowChrome
        status="success"
        // Thinking has no per-state verb ("已思考"/"Thought" feel
        // redundant next to the content itself). Leave verbKey off
        // so the chrome collapses verb + caret directly against the
        // preview, matching the surrounding text alignment.
        canExpand
        expanded={expanded}
        hovered={hovered}
        onClick={() => setExpanded((prev) => !prev)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {isStreaming && summary === placeholder ? (
          <Shimmer duration={1.5}>{summary}</Shimmer>
        ) : (
          summary
        )}
      </ActionRowChrome>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div className="mx-1 my-1 rounded-lg tool-card p-3 max-h-40 overflow-auto">
              <div className="text-[11px] tool-card-muted font-medium mb-1.5">
                {t('streaming.toolAction.thinking.title')}
              </div>
              <div className="text-xs text-foreground/80 whitespace-pre-wrap break-words leading-relaxed">
                {displayedContent}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}