// ReadToolRow — handles the `read` tool (and `readfile` / `read_file`
// aliases). The collapsed chrome shows the filename as the summary and
// the parsed line range (`L12-45`) in the right slot.
//
// Clicking the row no longer expands an inline result card. Instead it
// opens the file directly in DUYA's side-panel file preview workspace
// (duya:open-file-preview-panel via openLocalArtifactTarget). When the
// agent read a specific line range, the range is forwarded to the panel
// so it can scroll to and highlight the exact lines. This mirrors the
// FileEditToolRow pattern of "click the row → open the file", just
// without the separate diff card.

'use client';

import React, { useCallback, useState } from 'react';
import { ActionRowChrome } from '../chrome/ActionRowChrome';
import { getStatus, getFilePath } from '../registry';
import { openLocalArtifactTarget } from '@/lib/chat-file-links';
import { useConversationStore } from '@/stores/conversation-store';
import type { ToolAction } from '../types';

interface ReadToolRowProps {
  tool: ToolAction;
}

/** Parse the `File: <path>` header from the read tool result.
 *  The agent resolves the input path against its own working directory,
 *  so this absolute path is the most reliable value to hand to the
 *  preview panel. Falls back to the tool input when the header is
 *  missing or the path is empty. */
function parseReadFilePath(result: string): string | null {
  if (!result) return null;
  const match = result.match(/^File:\s*(.+?)\s*$/m);
  const path = match?.[1]?.trim();
  return path || null;
}

/** Parse a `File: …\nLines: N-M\n\n` preamble from the read tool
 *  result. Returns null when the result has no preamble (older / non-
 *  standard formats). */
function parseReadLineRange(result: string): { start: number; end: number } | null {
  if (!result) return null;
  const match = result.match(/^File:\s*.+?\s*\nLines:\s*(\d+)-(\d+)\s*\n\n/);
  if (match) {
    return { start: parseInt(match[1]), end: parseInt(match[2]) };
  }
  return null;
}

/** Resolve the line range to focus in the preview panel.
 *
 *  Priority:
 *    1. `input.line_range` — structured, available as soon as the
 *       tool_use arrives (before the result streams back). `end=-1`
 *       (read-to-EOF sentinel from the agent schema) is treated as
 *       "no end", so the panel only focuses `start`.
 *    2. The `Lines: N-M` preamble in the result string — used when
 *       the agent didn't pass `line_range` but the backend emitted a
 *       range header (e.g. older callers).
 *
 *  Returns null when neither source yields a range, meaning the agent
 *  read the whole file from line 1 — the panel just opens at the top
 *  with no highlight.
 */
function resolveFocusRange(tool: ToolAction): { start: number; end?: number } | null {
  const inp = tool.input as Record<string, unknown> | undefined;
  const lr = inp?.line_range as { start?: number; end?: number } | undefined;
  if (lr && typeof lr.start === "number" && Number.isFinite(lr.start) && lr.start > 0) {
    const start = lr.start;
    let end: number | undefined;
    if (
      typeof lr.end === "number" &&
      Number.isFinite(lr.end) &&
      lr.end > 0 &&
      lr.end >= start
    ) {
      end = lr.end;
    }
    return { start, end };
  }
  if (tool.result) {
    const parsed = parseReadLineRange(tool.result);
    if (parsed) return { start: parsed.start, end: parsed.end };
  }
  return null;
}

/** Format the right-slot line range label. Shows `L{start}-{end}` for
 *  multi-line ranges, `L{start}` for single-line, and null when no
 *  range is known (whole-file read). */
function formatLineLabel(range: { start: number; end?: number } | null): string | null {
  if (!range) return null;
  if (range.end == null || range.end === range.start) return `L${range.start}`;
  return `L${range.start}-${range.end}`;
}

export function ReadToolRow({ tool }: ReadToolRowProps) {
  const [hovered, setHovered] = useState(false);
  const activeThreadId = useConversationStore((s) => s.activeThreadId);
  const threads = useConversationStore((s) => s.threads);
  const activeThread = activeThreadId ? threads.find((th) => th.id === activeThreadId) : undefined;
  const cwd = activeThread?.workingDirectory ?? undefined;
  // Prefer the resolved absolute path from the read tool result. The agent
  // already resolved the user-supplied (possibly relative) path against its
  // own working directory, so this avoids mismatches when the renderer's
  // cwd-based resolution would land somewhere else.
  const filePath = parseReadFilePath(tool.result ?? '') ?? getFilePath(tool.input);
  const fileName = filePath ? (filePath.split(/[/\\]/).pop() || filePath) : 'file';
  const status = getStatus(tool);
  const focusRange = resolveFocusRange(tool);
  const lineLabel = formatLineLabel(focusRange);

  const verbKey =
    status === 'running' ? 'streaming.toolAction.running.read'
    : status === 'error' ? 'streaming.toolAction.error.read'
    : 'streaming.toolAction.done.read';

  // Click the row → open the file in DUYA's side-panel preview workspace.
  // When a line range is known, forward it so the panel scrolls to and
  // highlights the exact lines the agent read. If the file isn't a
  // previewable type, openLocalArtifactTarget falls back to the system
  // default editor via shell.openPath.
  const handleClick = useCallback(() => {
    if (!filePath) return;
    openLocalArtifactTarget(filePath, cwd, focusRange ?? undefined);
  }, [filePath, cwd, focusRange]);

  return (
    <ActionRowChrome
      status={status}
      verbKey={verbKey}
      canExpand={false}
      expanded={false}
      hovered={hovered}
      durationMs={tool.durationMs}
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      buttonClassName="cursor-pointer"
      rightSlot={
        lineLabel ? (
          <span className="text-[11px] text-muted-foreground/50 tabular-nums shrink-0 font-mono">
            {lineLabel}
          </span>
        ) : null
      }
    >
      <span
        className={`font-mono truncate min-w-0 max-w-full text-left transition-colors ${
          hovered ? 'text-blue-500 underline underline-offset-2' : 'text-blue-500/90'
        }`}
        title={filePath || undefined}
      >
        {fileName}
      </span>
    </ActionRowChrome>
  );
}
