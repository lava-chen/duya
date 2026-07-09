// MessageSessionToolRow — handles the `MessageSession` tool (see
// packages/agent/src/tool/MessageSessionTool). The tool returns a
// plain-text response from the target agent, optionally followed by a
// tool-call summary trailer:
//   "<response text>\n\n[Target agent used tools: Read, Grep]"
// On error the result is:
//   "Error from target session: <message> (code: <code>)"
//
// The whole row is a one-click navigation to the target session's
// chat view (mirrors SubAgentToolRow). The target session title is
// resolved from the conversation store (or fetched via IPC on mount)
// so the user never sees a raw session id.
//
// Collapsed:  [verb] [target title · message preview / response preview] [StatusDot]

'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { TablerMessageCircleIcon } from '@/components/icons';
import { useConversationStore } from '@/stores/conversation-store';
import { getThreadIPC } from '@/lib/ipc-client';
import { ActionRowChrome } from '../chrome/ActionRowChrome';
import { getStatus } from '../registry';
import type { ToolAction, ToolStatus } from '../types';
import type { TranslationKey } from '@/i18n';

interface MessageSessionToolRowProps {
  tool: ToolAction;
}

// Splits the raw result string into the target agent's response text
// and the optional "[Target agent used tools: ...]" trailer. The
// trailer is appended by MessageSessionTool.execute() when the target
// agent emitted any tool_use blocks during its run.
const TOOL_SUMMARY_MARKER = '\n\n[Target agent used tools:';
const ERROR_PREFIX = 'Error from target session:';

function parseMessageSessionResult(result: string | undefined): {
  text: string;
  toolSummary: string | null;
  error: string | null;
  errorCode: string | null;
} {
  if (!result) return { text: '', toolSummary: null, error: null, errorCode: null };

  // Error envelope — produced by MessageSessionTool when the target
  // session emits chat:error or crashes.
  if (result.startsWith(ERROR_PREFIX)) {
    const rest = result.slice(ERROR_PREFIX.length).trim();
    // Trailing "(code: <code>)" — extract it if present.
    const codeMatch = rest.match(/\(code:\s*([^)]+)\)\s*$/);
    const code = codeMatch ? codeMatch[1].trim() : null;
    const message = codeMatch ? rest.slice(0, codeMatch.index).trim() : rest;
    return { text: '', toolSummary: null, error: message || 'Unknown error', errorCode: code };
  }

  // Success envelope — split off the tool-call summary trailer.
  const idx = result.indexOf(TOOL_SUMMARY_MARKER);
  if (idx >= 0) {
    const text = result.slice(0, idx);
    const trailer = result.slice(idx + TOOL_SUMMARY_MARKER.length).replace(/\]$/, '').trim();
    return {
      text,
      toolSummary: trailer || null,
      error: null,
      errorCode: null,
    };
  }
  return { text: result, toolSummary: null, error: null, errorCode: null };
}

function truncateText(text: string, maxLen: number): string {
  const cleaned = text.trim().replace(/\s+/g, ' ');
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen - 1) + '…' : cleaned;
}

/**
 * Resolve the target session's title for display. Looks up the thread
 * in the conversation store first (synchronous), then falls back to
 * an IPC fetch on mount. Returns null until the title is known so the
 * caller can render a short-id placeholder.
 */
function useTargetSessionTitle(targetSessionId: string): string | null {
  const storeThread = useConversationStore((s) =>
    s.threads.find((t) => t.id === targetSessionId),
  );
  const [fetchedTitle, setFetchedTitle] = useState<string | null>(null);

  useEffect(() => {
    if (!targetSessionId) return;
    let cancelled = false;
    // Only fetch when the store doesn't already have it.
    setFetchedTitle(null);
    getThreadIPC(targetSessionId)
      .then((res) => {
        if (cancelled) return;
        if (res?.thread?.title) setFetchedTitle(res.thread.title);
      })
      .catch(() => {
        // Thread may have been deleted — leave title as null so the
        // caller falls back to the short id.
      });
    return () => {
      cancelled = true;
    };
  }, [targetSessionId]);

  // Store hit wins (it's the freshest — updated live as titles change).
  return storeThread?.title || fetchedTitle;
}

export function MessageSessionToolRow({ tool }: MessageSessionToolRowProps) {
  const [hovered, setHovered] = useState(false);
  const status = getStatus(tool);
  const hasResult = tool.result !== undefined && tool.result !== '';
  const inp = (tool.input || {}) as Record<string, unknown>;
  const targetId = typeof inp.targetSessionId === 'string' ? inp.targetSessionId : '';
  const mode = typeof inp.mode === 'string' ? inp.mode : 'minimal';
  const message = typeof inp.message === 'string' ? inp.message.trim() : '';

  const targetTitle = useTargetSessionTitle(targetId);
  // Short id is the last-resort label when the title can't be resolved
  // (e.g. the thread was deleted).
  const shortId = targetId ? targetId.slice(0, 8) : '';
  const displayTitle = targetTitle || (shortId ? `session ${shortId}` : 'target session');

  const parsed = useMemo(
    () => (hasResult ? parseMessageSessionResult(tool.result) : null),
    [hasResult, tool.result],
  );
  const isError = status === 'error' || parsed?.error != null;
  const hasToolSummary = parsed?.toolSummary != null;

  const rowStatus: ToolStatus = isError ? 'error' : status;

  const chromeVerbKey: TranslationKey | undefined =
    status === 'running'
      ? 'streaming.toolAction.running.messageSession'
      : status === 'error'
        ? 'streaming.toolAction.error.messageSession'
        : 'streaming.toolAction.label.messageSession';

  // Build the inline summary. The shape depends on the row state so
  // the user always sees the most useful preview at a glance:
  //   running  → "Target Title · \"question preview\""
  //   success  → "Target Title · \"response preview\""
  //   error    → "Target Title · error message"
  const summary = (() => {
    const titleSpan = (
      <span
        className={`transition-all group-hover:brightness-75 font-medium ${
          targetTitle ? '' : 'text-muted-foreground/70 italic'
        }`}
      >
        {displayTitle}
      </span>
    );

    let tail: React.ReactNode = null;

    if (isError && parsed?.error) {
      const errPreview = truncateText(parsed.error, 80);
      tail = (
        <>
          <Sep />
          <span className="text-red-400/90">{errPreview}</span>
        </>
      );
    } else if (parsed?.text) {
      const responsePreview = truncateText(parsed.text, 80);
      tail = (
        <>
          <Sep />
          <span className="text-muted-foreground/80">{responsePreview}</span>
        </>
      );
    } else if (message) {
      // Running or no response yet — show the question being asked.
      const questionPreview = truncateText(message, 60);
      tail = (
        <>
          <Sep />
          <span className="text-muted-foreground/70">
            <span className="select-none mr-1">Q:</span>
            {questionPreview}
          </span>
        </>
      );
    }

    return (
      <div className="group relative flex items-center gap-1.5 min-w-0 w-full">
        <TablerMessageCircleIcon size={14} className="shrink-0 text-muted-foreground" />
        <div className="relative min-w-0 flex-1 overflow-hidden">
          <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
            {titleSpan}
            {tail}
            {hasToolSummary && (
              <>
                <Sep />
                <span className="text-[10px] font-mono px-1 py-0.5 rounded text-amber-400 bg-amber-400/10">
                  tools
                </span>
              </>
            )}
          </span>
          {/* Fade-out mask when content overflows the row width */}
          <span
            className="pointer-events-none absolute inset-y-0 right-0 w-8"
            style={{
              background:
                'linear-gradient(to right, transparent, var(--bg-canvas, var(--background)))',
            }}
          />
        </div>
      </div>
    );
  })();

  const handleClick = () => {
    if (!targetId) return;
    useConversationStore.getState().setActiveThread(targetId);
  };

  return (
    <ActionRowChrome
      status={rowStatus}
      verbKey={chromeVerbKey}
      canExpand={false}
      expanded={false}
      hovered={hovered}
      durationMs={tool.durationMs}
      onClick={targetId ? handleClick : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      buttonClassName={targetId ? 'cursor-pointer' : 'cursor-default'}
      // Hide the mode in the right slot — only show when the row is
      // hovered so the collapsed chrome stays clean. Mode is useful
      // context but not important enough to always show.
      rightSlot={
        mode === 'full' ? (
          <span className="text-muted-foreground/40 text-[10px] font-mono shrink-0 hidden sm:inline">
            full
          </span>
        ) : null
      }
    >
      {summary}
    </ActionRowChrome>
  );
}

function Sep() {
  return <span className="text-muted-foreground/40 select-none">·</span>;
}
