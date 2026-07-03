// FileEditToolRow — handles the `edit` / `write` / `create_file` tool
// family. The collapsed chrome shows:
//   - a blue clickable filename (.html/.htm → DUYA's side-panel browser,
//     .doc/.docx/.ppt/.pptx/.xls/.xlsx → DUYA's side-panel Office viewer,
//     everything else → system default editor via shell.openPath), and
//   - live `+N -M` git-style stats in the right slot. Stats are
//     computed from `input` as soon as the tool_use arrives, then
//     recomputed from the authoritative `result` once the tool
//     finishes — the row stays visible (and updating) throughout
//     streaming.
//
// The expanded card shows a SimpleDiffViewer of the old vs new content.

'use client';

import React, { useCallback, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  CheckCircleIcon,
  SpinnerGapIcon,
  XCircleIcon,
} from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import { SimpleDiffViewer, calculateDiff } from '@/components/diff/SimpleDiffViewer';
import { ActionRowChrome } from '../chrome/ActionRowChrome';
import { getStatus, getFilePath } from '../registry';
import { FILE_CREATE_TOOLS, FILE_EDIT_TOOLS } from '../classify';
import { openLocalFileTarget } from '@/lib/chat-file-links';
import { useConversationStore } from '@/stores/conversation-store';
import type { ToolAction, FileEditStats } from '../types';

interface FileEditToolRowProps {
  tool: ToolAction;
}

/**
 * Compute live diff stats for edit / write / create_file tools.
 *
 * Priority:
 *   1. If `result` is available, parse the authoritative result format
 *      (edit: "Changed:/To:" blocks; write: JSON `{content, file_path}`).
 *   2. Otherwise fall back to the tool's `input` so stats are visible
 *      from the moment the tool_use arrives (during streaming).
 */
function computeFileEditStats(tool: ToolAction): FileEditStats {
  const inp = tool.input as Record<string, unknown> | undefined;
  const name = tool.name.toLowerCase();
  const isCreateTool = FILE_CREATE_TOOLS.has(name);
  const isEditTool = FILE_EDIT_TOOLS.has(name);

  // 1) Prefer authoritative result when present.
  if (tool.result && !tool.isError) {
    const parsed = parseEditResult(tool.result);
    if (parsed) {
      const stats = calculateDiff(parsed.oldContent, parsed.newContent).stats;
      return { stats, kind: 'edit' };
    }
    // write result is JSON: { file_path, content, previous_content? }
    try {
      const data = JSON.parse(tool.result);
      if (typeof data?.content === 'string') {
        const oldContent = typeof data.previous_content === 'string' ? data.previous_content : '';
        if (oldContent) {
          const stats = calculateDiff(oldContent, data.content as string).stats;
          return { stats, kind: 'edit' };
        }
        const additions = (data.content as string).split('\n').filter((l: string) => l !== '').length;
        return { stats: { additions, removals: 0 }, kind: 'create' };
      }
    } catch {
      // not JSON — fall through to input
    }
  }

  // 2) Live estimate from `input` while streaming.
  if (isEditTool && typeof inp?.old_string === 'string' && typeof inp?.new_string === 'string') {
    const stats = calculateDiff(inp.old_string as string, inp.new_string as string).stats;
    return { stats, kind: 'edit' };
  }
  if (isCreateTool && typeof inp?.content === 'string') {
    const additions = (inp.content as string).split('\n').filter((l: string) => l !== '').length;
    return { stats: { additions, removals: 0 }, kind: 'create' };
  }

  return { stats: { additions: 0, removals: 0 }, kind: 'unknown' };
}

/**
 * Parse edit tool result to get old and new content.
 * Returns `{ filePath, oldContent, newContent }` or null on parse failure.
 */
function parseEditResult(result: string): { filePath: string; oldContent: string; newContent: string } | null {
  try {
    // Parse format: "Successfully edited {file_path}\n\nChanged:\n{old_string}\n\nTo:\n{new_string}"
    const changedMatch = result.match(/Changed:\n([\s\S]+?)\n\nTo:\n([\s\S]+)$/);
    if (changedMatch) {
      const filePathMatch = result.match(/Successfully edited (.+)\n/);
      const filePath = filePathMatch ? filePathMatch[1] : 'unknown';
      const oldContent = changedMatch[1];
      const newContent = changedMatch[2];
      return { filePath, oldContent, newContent };
    }

    // Try JSON format
    const data = JSON.parse(result);
    if (data.old_string !== undefined && data.new_string !== undefined) {
      const filePath = data.file_path || data.path || 'unknown';
      return {
        filePath,
        oldContent: data.old_string || '',
        newContent: data.new_string || data.diff || '',
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Animated stat number — fades and slides when the value changes.
 * Used to make the live `+N -M` feel like the digits are ticking.
 */
function StatNumber({ value, tone }: { value: number; tone: 'add' | 'remove' }) {
  if (value <= 0) return null;
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={value}
        initial={{ y: -6, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 6, opacity: 0 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className={`font-mono tabular-nums font-medium ${
          tone === 'add' ? 'text-green-500' : 'text-red-500'
        }`}
      >
        {tone === 'add' ? `+${value}` : `-${value}`}
      </motion.span>
    </AnimatePresence>
  );
}

export function FileEditToolRow({ tool }: FileEditToolRowProps) {
  const { t } = useTranslation();
  const activeThreadId = useConversationStore((s) => s.activeThreadId);
  const threads = useConversationStore((s) => s.threads);
  const activeThread = activeThreadId ? threads.find((th) => th.id === activeThreadId) : undefined;
  const cwd = activeThread?.workingDirectory ?? undefined;
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [fileHovered, setFileHovered] = useState(false);
  const filePath = getFilePath(tool.input);
  const fileName = filePath ? (filePath.split(/[/\\]/).pop() || filePath) : 'file';
  const status = getStatus(tool);
  const hasResult = tool.result !== undefined && tool.result !== '';

  // Live diff stats — visible from tool_use onwards, updated when result arrives.
  const { stats, kind } = computeFileEditStats(tool);
  const isCreate = kind === 'create';

  // Verb shown next to the icon. "已编辑"/"Edited" vs "已创建"/"Created".
  // Verb follows the row's status: "正在编辑…" while running, "已编辑"
  // once done, "编辑失败" on error. The create/edit distinction still
  // matters for the *default* verb (editing vs creating) so we pick
  // the right key from the action kind.
  const verbKey =
    status === 'running'
      ? (isCreate ? 'streaming.toolAction.running.create' : 'streaming.toolAction.running.edit')
      : status === 'error'
        ? (isCreate ? 'streaming.toolAction.error.create' : 'streaming.toolAction.error.edit')
        : (isCreate ? 'streaming.toolAction.created' : 'streaming.toolAction.edited');
  const openFileTitle = t('streaming.toolAction.openFile');

  // Open the file. Delegates to openLocalFileTarget which routes:
  //   - .html / .htm → DUYA's side-panel browser (duya:open-browser-panel)
  //   - .doc / .docx / .ppt / .pptx / .xls / .xlsx → DUYA's side-panel
  //     Office viewer (duya:open-office-panel)
  //   - everything else → system default editor via shell.openPath
  // The helper also resolves relative paths against the current
  // thread's working directory, so a bare "tank-battle.html" becomes
  // E:\projects\duya\tank-battle.html instead of https://tank-battle.html/.
  const handleOpenFile = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      if (!filePath) return;
      openLocalFileTarget(filePath, cwd);
    },
    [filePath, cwd],
  );

  // Diff payload for the expanded card. We use the same source as the
  // stats so the card and the collapsed `+N -M` always agree.
  const diffPayload = (() => {
    if (hasResult) {
      const parsed = parseEditResult(tool.result!);
      if (parsed) {
        return { oldContent: parsed.oldContent, newContent: parsed.newContent };
      }
      try {
        const data = JSON.parse(tool.result!);
        if (typeof data?.content === 'string') {
          return {
            oldContent: typeof data.previous_content === 'string' ? data.previous_content : '',
            newContent: data.content as string,
          };
        }
      } catch {
        // fall through
      }
    }
    // During streaming, render what the agent has committed so far.
    const inp = tool.input as Record<string, unknown> | undefined;
    if (isCreate && typeof inp?.content === 'string') {
      return { oldContent: '', newContent: inp.content as string };
    }
    if (typeof inp?.old_string === 'string' && typeof inp?.new_string === 'string') {
      return { oldContent: inp.old_string as string, newContent: inp.new_string as string };
    }
    return null;
  })();

  const canExpand = diffPayload !== null;

  // Right-side slot: live +N -M git-style stats. Hidden before the
  // agent commits to the edit so the row stays quiet.
  const statsSlot = (
    <div className="ml-auto flex items-center gap-1.5 shrink-0 text-[11px] min-h-[14px]">
      {stats.additions > 0 || stats.removals > 0 ? (
        <>
          <StatNumber value={stats.additions} tone="add" />
          <StatNumber value={stats.removals} tone="remove" />
        </>
      ) : status === 'running' ? (
        <span className="text-muted-foreground/40 font-mono tabular-nums">…</span>
      ) : null}
    </div>
  );

  return (
    <div>
      <ActionRowChrome
        status={status}
        verbKey={verbKey}
        canExpand={canExpand}
        expanded={expanded}
        hovered={hovered}
        durationMs={tool.durationMs}
        onClick={() => canExpand && setExpanded((prev) => !prev)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        buttonClassName={canExpand ? 'cursor-pointer' : 'cursor-default'}
        rightSlot={statsSlot}
      >
        {/* Blue clickable filename — opens in system default editor. We
            can't nest a <button> inside the chrome's outer <button>
            (HTML disallows it), so use a <span> with onClick +
            stopPropagation. */}
        <span
          role="button"
          tabIndex={0}
          onClick={handleOpenFile}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleOpenFile(e as unknown as React.MouseEvent);
            }
          }}
          title={filePath ? `${openFileTitle}\n${filePath}` : openFileTitle}
          className={`font-mono truncate min-w-0 max-w-full text-left transition-colors cursor-pointer ${
            fileHovered
              ? 'text-blue-500 underline underline-offset-2'
              : 'text-blue-500/90 hover:text-blue-500'
          }`}
          onMouseEnter={() => setFileHovered(true)}
          onMouseLeave={() => setFileHovered(false)}
        >
          {fileName}
        </span>
      </ActionRowChrome>

      <AnimatePresence initial={false}>
        {expanded && canExpand && diffPayload && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div className="mx-0.5 my-0.5 rounded-lg tool-card p-1.5 relative">
              <SimpleDiffViewer
                oldContent={diffPayload.oldContent}
                newContent={diffPayload.newContent}
                maxHeight={200}
              />

              {/* Status badge - bottom right */}
              <div className="mt-1 flex justify-end">
                {status === 'success' && (
                  <div className="flex items-center gap-1 text-[11px] text-green-500">
                    <CheckCircleIcon size={12} />
                    <span>Success</span>
                  </div>
                )}
                {status === 'error' && (
                  <div className="flex items-center gap-1 text-[11px] text-red-500">
                    <XCircleIcon size={12} />
                    <span>Failed</span>
                  </div>
                )}
                {status === 'running' && (
                  <div className="flex items-center gap-1 text-[11px] text-amber-500">
                    <SpinnerGapIcon size={12} className="animate-spin" />
                    <span>Running</span>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
