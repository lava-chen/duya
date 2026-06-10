/**
 * MailboxComposer.tsx - AgentMailbox composer component (Plan 202 — PR1)
 *
 * Replaces MessageInput when isStreaming is true.
 * Allows the user to send follow-up messages during agent execution.
 *
 * PR1: 3-chip UI with hint inference, single textarea + Send.
 * The inferred kind is a hint; the server may rewrite it.
 */

'use client';

import React, { useState, useCallback, useMemo } from 'react';
import { PaperPlaneTilt } from '@phosphor-icons/react';
import type { MailboxKind } from '@/stores/mailbox-store';

// =============================================================================
// Kind hint inference (best-effort, server is authoritative)
// =============================================================================

interface KindChip {
  kind: MailboxKind;
  label: string;
  description: string;
}

const KIND_CHIPS: KindChip[] = [
  { kind: 'followup', label: 'Follow-up', description: 'Add to the current task' },
  { kind: 'correction', label: 'Correction', description: 'Correct the agent\'s approach' },
  { kind: 'constraint', label: 'Constraint', description: 'Add a guard or restriction' },
];

function inferKind(content: string): MailboxKind {
  if (!content.trim()) return 'followup';

  const lower = content.toLowerCase();

  // Stop / abort patterns
  if (/^(停止|算了|cancel|stop now)/i.test(lower)) return 'stop';

  // Correction patterns
  if (/^(先|然后|接着|then|之后|actually|不对|错了)/i.test(lower)) return 'correction';

  // Constraint patterns
  if (/(不要|别|禁止|don'?t|never|stop|abort|block)\s/i.test(lower)) return 'constraint';
  if (/(\*\*\/\*|glob|pattern|\*\.\w+)/i.test(lower)) return 'constraint';

  return 'followup';
}

// =============================================================================
// Props
// =============================================================================

interface MailboxComposerProps {
  sessionId: string;
  submittedDuringRunId: string;
  onSend: (params: {
    content: string;
    kind: MailboxKind;
    submittedDuringRunId: string;
  }) => void;
  disabled?: boolean;
}

// =============================================================================
// Component
// =============================================================================

export function MailboxComposer({
  sessionId,
  submittedDuringRunId,
  onSend,
  disabled = false,
}: MailboxComposerProps) {
  const [content, setContent] = useState('');
  const [selectedKind, setSelectedKind] = useState<MailboxKind>('followup');

  const inferredKind = useMemo(() => inferKind(content), [content]);

  const handleSend = useCallback(() => {
    const trimmed = content.trim();
    if (!trimmed || disabled) return;

    onSend({
      content: trimmed,
      kind: selectedKind,
      submittedDuringRunId,
    });

    setContent('');
  }, [content, selectedKind, submittedDuringRunId, onSend, disabled]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="mailbox-composer flex flex-col gap-2">
      {/* Kind chips */}
      <div className="flex items-center gap-1.5">
        {KIND_CHIPS.map((chip) => {
          const isSelected = selectedKind === chip.kind;
          const isInferred = inferredKind === chip.kind;
          return (
            <button
              key={chip.kind}
              type="button"
              onClick={() => setSelectedKind(chip.kind)}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-all ${
                isSelected
                  ? 'bg-[var(--accent)] text-white'
                  : 'bg-[var(--hover-bg)] text-[var(--muted)] hover:text-[var(--text)]'
              } ${isInferred && !isSelected ? 'ring-1 ring-[var(--accent)]/50' : ''}`}
              title={chip.description}
            >
              {chip.label}
              {isInferred && !isSelected && (
                <span className="text-[10px] opacity-70">(suggested)</span>
              )}
            </button>
          );
        })}

        {/* Server reclassify hint */}
        <span className="text-[10px] text-[var(--muted)]/60 ml-auto">
          server may re-classify
        </span>
      </div>

      {/* Input area */}
      <div className="flex items-center gap-2">
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Send a message during execution..."
          disabled={disabled}
          rows={1}
          className="flex-1 px-3 py-2 text-sm bg-[var(--input-bg)] border border-[var(--border)] rounded-lg resize-none focus:outline-none focus:border-[var(--accent)] placeholder:text-[var(--muted)]/50"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={disabled || !content.trim()}
          className="p-2 rounded-lg bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
          title="Send"
        >
          <PaperPlaneTilt size={16} weight="fill" />
        </button>
      </div>
    </div>
  );
}