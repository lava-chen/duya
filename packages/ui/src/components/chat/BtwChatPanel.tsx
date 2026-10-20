// BtwChatPanel.tsx - Side-question (旁侧问答) content rendered inside the
// settings popover's "中途聊天" sub-view. Reuses the in-memory btw-store keyed
// by sessionId and the agent server /btw endpoint. Unlike the old modal
// overlay, this renders inline (no backdrop / portal) so it fits the popover.
//
// Grok-style: expanding cards accumulate upward (newest at the bottom); each
// card is expandable/collapsible showing a short preview when collapsed.

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useBtwStore, type BtwEntry } from '@/stores/btw-store';
import { askSideQuestion } from '@/lib/agent-sse-client';
import { CaretDownIcon, CaretUpIcon } from '@/components/icons';

interface BtwChatPanelProps {
  sessionId?: string;
}

const PREVIEW_CHARS = 120;

/**
 * Whitespace-safe preview: truncate the answer at ~120 chars, breaking at the
 * last space so words are never cut mid-syllable.
 */
function makePreview(answer: string): string {
  if (answer.length <= PREVIEW_CHARS) return answer;
  const slice = answer.slice(0, PREVIEW_CHARS);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

export function BtwChatPanel({ sessionId }: BtwChatPanelProps) {
  // Select the raw array directly (stable reference) so useSyncExternalStore
  // does not loop. `getEntries` returns `?? []`, a fresh array each call, which
  // would change the snapshot on every render. Default to [] outside the
  // selector instead.
  const entries = useBtwStore((s) => (sessionId ? s.entriesBySession[sessionId] : undefined)) ?? [];
  const addQuestion = useBtwStore((s) => s.addQuestion);
  const setAnswer = useBtwStore((s) => s.setAnswer);
  const setError = useBtwStore((s) => s.setError);
  const toggleExpanded = useBtwStore((s) => s.toggleExpanded);

  const [draft, setDraft] = useState('');
  const [inFlight, setInFlight] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to the bottom when a new card is added or one finishes loading.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }, [entries]);

  const submit = useCallback(async () => {
    if (!sessionId) return;
    const question = draft.trim();
    if (!question || inFlight) return;
    setDraft('');
    setInFlight(true);
    const id = addQuestion(sessionId, question);
    try {
      const result = await askSideQuestion(sessionId, question);
      setAnswer(sessionId, id, result.answer);
    } catch (err) {
      const message = err instanceof Error ? err.message : '旁侧问答失败，请重试。';
      setError(sessionId, id, message);
    } finally {
      setInFlight(false);
      inputRef.current?.focus();
    }
  }, [draft, inFlight, sessionId, addQuestion, setAnswer, setError]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void submit();
      }
    },
    [submit],
  );

  return (
    <div className="flex flex-col" style={{ gap: 8 }}>
      {/* Scrollable card list */}
      <div
        ref={listRef}
        className="overflow-y-auto px-1 flex flex-col"
        style={{ gap: 6, maxHeight: 220, minHeight: 60 }}
      >
        {entries.length === 0 ? (
          <div className="py-2 text-[12px]" style={{ color: 'var(--command-menu-muted)' }}>
            在下方输入问题，不打断当前对话独立提问。
          </div>
        ) : (
          entries.map((entry) => (
            <BtwCard
              key={entry.id}
              entry={entry}
              onToggle={() => toggleExpanded(sessionId!, entry.id)}
            />
          ))
        )}
      </div>

      {/* Input + send */}
      <div className="flex items-end gap-2 px-1">
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder="输入旁侧问题，Enter 发送，Shift+Enter 换行"
          className="flex-1 min-w-0 resize-none outline-none text-[12px] leading-5 py-1.5 px-2.5"
          style={{
            color: 'var(--text)',
            backgroundColor: 'var(--bg-canvas)',
            border: '1px solid var(--command-menu-border)',
            borderRadius: 8,
            maxHeight: 90,
          }}
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!draft.trim() || inFlight || !sessionId}
          className="flex-shrink-0 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            color: '#fff',
            backgroundColor: 'var(--accent)',
          }}
        >
          {inFlight ? '…' : '发送'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function BtwCard({ entry, onToggle }: { entry: BtwEntry; onToggle: () => void }) {
  const collapsed = !entry.expanded;

  return (
    <div
      className="flex flex-col cursor-pointer select-none"
      style={{
        border: '1px solid var(--command-menu-border)',
        borderRadius: 8,
        backgroundColor: 'var(--bg-canvas)',
        overflow: 'hidden',
      }}
      onClick={onToggle}
      role="button"
      aria-expanded={!collapsed}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <div className="px-2.5 py-1.5 flex items-start gap-2">
        <span
          className="text-[12px] font-semibold flex-1 min-w-0"
          style={{ color: 'var(--text)', lineHeight: '18px' }}
        >
          {entry.question}
        </span>
        <span className="flex-shrink-0 mt-0.5" style={{ color: 'var(--muted)' }}>
          {collapsed ? <CaretDownIcon size={12} /> : <CaretUpIcon size={12} />}
        </span>
      </div>

      <div className="px-2.5 pb-2">
        {entry.status === 'loading' && (
          <div className="text-[12px]" style={{ color: 'var(--muted)' }}>
            正在回答…
          </div>
        )}
        {entry.status === 'error' && (
          <div className="text-[12px]" role="alert" style={{ color: 'var(--danger, #ef4444)' }}>
            {entry.error ?? '旁侧问答失败，请重试。'}
          </div>
        )}
        {entry.status === 'done' && (
          <div
            className="text-[12px] whitespace-pre-wrap"
            style={{
              color: 'var(--text)',
              lineHeight: '18px',
              display: collapsed ? '-webkit-box' : undefined,
              WebkitLineClamp: collapsed ? 3 : undefined,
              WebkitBoxOrient: collapsed ? 'vertical' : undefined,
              overflow: collapsed ? 'hidden' : undefined,
            }}
          >
            {collapsed ? makePreview(entry.answer) : entry.answer}
          </div>
        )}
      </div>
    </div>
  );
}