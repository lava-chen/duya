// NextStepSuggestions.tsx - End-of-turn follow-up option cards.
//
// Rendered by MessageList after the last message once the agent turn has
// finished. Clicking a card hands the text back to ChatView which prefills
// the input box (visible and editable — NOT auto-sent).

'use client';

import React from 'react';
import { useTranslation } from '@/hooks/useTranslation';

interface NextStepSuggestionsProps {
  suggestions: string[];
  onSelect: (value: string) => void;
}

const clampTwoLines: React.CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
};

export function NextStepSuggestions({ suggestions, onSelect }: NextStepSuggestionsProps) {
  const { t } = useTranslation();
  if (suggestions.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 my-3" role="group" aria-label={t('chat.nextStepSuggestions')}>
      {suggestions.map((text) => (
        <button
          key={text}
          type="button"
          onClick={() => onSelect(text)}
          title={text}
          className="group flex items-center gap-2 w-full min-w-0 text-left rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-[13px] leading-snug text-[var(--muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text)] cursor-pointer"
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 opacity-60 group-hover:opacity-100 transition-opacity"
            aria-hidden="true"
          >
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
          <span className="min-w-0 flex-1" style={clampTwoLines}>{text}</span>
        </button>
      ))}
    </div>
  );
}
