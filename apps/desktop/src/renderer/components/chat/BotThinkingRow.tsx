/**
 * BotThinkingRow — Expandable thinking/reasoning row (grok-bot's TranscriptThinkingRow).
 *
 * Layout: [brain-icon] [label] [preview] [chevron]
 * Expanded: full thinking text in a <pre> block.
 */

import React, { useState } from 'react';
import { BrainIcon, CaretRightIcon } from '@/components/icons';

interface BotThinkingRowProps {
  text: string;
  isStreaming?: boolean;
}

export function BotThinkingRow({ text, isStreaming = false }: BotThinkingRowProps) {
  const [expanded, setExpanded] = useState(false);

  const preview = text.slice(0, 60) + (text.length > 60 ? '…' : '');

  return (
    <div className="bot-thinking-row" role="listitem">
      <button
        type="button"
        className="bot-thinking-row__toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <BrainIcon size={14} className="bot-thinking-row__icon" />
        <span className="bot-thinking-row__label">
          Thinking{isStreaming ? '…' : ''}
        </span>
        {preview && !expanded && (
          <span className="bot-thinking-row__preview">{preview}</span>
        )}
        <CaretRightIcon
          size={12}
          className={`bot-thinking-row__chevron ${expanded ? 'bot-thinking-row__chevron--open' : ''}`}
        />
      </button>

      {expanded && (
        <div className="bot-thinking-row__detail">
          <pre className="bot-thinking-row__detail-pre">{text}</pre>
        </div>
      )}
    </div>
  );
}
