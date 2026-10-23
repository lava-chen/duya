// FileEditToolRow — handles the `edit` / `write` / `create_file` tool
// family. The collapsed chrome shows:
//   - a blue clickable filename (.html/.htm → DUYA's side-panel browser,
//     .doc/.docx/.ppt/.pptx/.xls/.xlsx → DUYA's side-panel Office viewer,
//     .md/.txt/.json/.png/.pdf/.ts/.tsx/.py/... → DUYA's side-panel file
//     preview workspace, everything else → system default editor via
//     shell.openPath), and
//   - live `+N -M` git-style stats in the right slot. Stats are
//     computed from `input` as soon as the tool_use arrives, then
//     recomputed from the authoritative `result` once the tool
//     finishes — the row stays visible (and updating) throughout
//     streaming.
//
// Plan 461: while the model is *still generating* the arguments
// (`tool_use_delta` fragments merged into `input` by
// stream-session-manager), the row shows the filename as soon as it
// appears, the line count ticks up with every flushed chunk, and the
// card auto-expands into a live "正在写入…" preview that renders the
// new content as it streams (Codex/pi TUI parity). Once the
// authoritative result arrives, the card collapses back to the
// regular SimpleDiffViewer of old vs new content.
//
// The expanded card shows a SimpleDiffViewer of the old vs new content.

'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  CheckCircleIcon,
  CopyIcon,
  SpinnerGapIcon,
  XCircleIcon,
} from '@/components/icons';
import { IconButton } from '@/components/ui/IconButton';
import { useTranslation } from '@/hooks/useTranslation';
import { useTheme } from '@/hooks/useTheme';
import { SimpleDiffViewer } from '@/components/diff/SimpleDiffViewer';
import { SyntaxHighlighter } from '@/lib/prism-languages';
import { oneLight, oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { getLanguageFromPath } from '@/lib/diff/diff-utils';
import { ActionRowChrome } from '../chrome/ActionRowChrome';
import { getStatus, getFilePath } from '../registry';
import { computeFileEditStats, parseEditResult } from '../fileEditStats';
import { truncatePathMiddle } from '@/lib/path-display';
import { openLocalArtifactTarget } from '@/lib/chat-file-links';
import { useConversationStore } from '@/stores/conversation-store';
import type { ToolAction } from '../types';

interface FileEditToolRowProps {
  tool: ToolAction;
}

/** Tail window for the live streaming preview — keeps diffing/render O(1)
 *  even when the model writes a very large file. */
const LIVE_PREVIEW_MAX_LINES = 200;

/** ZCode parity: beyond this many chars the highlighted render falls back
 *  to plain text so syntax highlighting can never stall the stream. */
const LIVE_PREVIEW_HIGHLIGHT_MAX_CHARS = 120_000;

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

/**
 * Plan 461: live "正在写入…" preview shown while the model is still
 * generating the file content. Renders the new content as green additions
 * with line numbers, tail-windowed to the last 200 lines, and auto-scrolls
 * to the bottom as the content grows — a Codex/pi-style editor preview.
 *
 * ZCode-parity two-phase rendering: the first frame after mount is plain
 * text (cheap, no highlighter work on the hot path); once the browser is
 * idle the preview swaps to the Prism highlighter and stays there — later
 * content updates re-highlight without flipping back to plain text.
 */
function StreamingFilePreview({
  newContent,
  filePath,
  isCreate,
  lineCount,
}: {
  newContent: string;
  filePath: string;
  isCreate: boolean;
  lineCount: number;
}) {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const scrollRef = useRef<HTMLDivElement>(null);

  const lines = useMemo(() => {
    const all = newContent.split('\n');
    return all.slice(-LIVE_PREVIEW_MAX_LINES);
  }, [newContent]);

  // Auto-scroll to the bottom whenever the preview grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  // Track the starting line number for the tail window so numbering stays
  // continuous instead of restarting at 1.
  const startLine = useMemo(() => {
    const total = newContent.split('\n').length;
    return Math.max(1, total - lines.length + 1);
  }, [newContent, lines.length]);

  const language = useMemo(() => getLanguageFromPath(filePath), [filePath]);
  const tailText = useMemo(() => lines.join('\n'), [lines]);
  const canHighlight = tailText.length <= LIVE_PREVIEW_HIGHLIGHT_MAX_CHARS;

  // Phase 1 renders plain rows; after idle we swap to the highlighter and
  // never flip back on content updates (only when the cap is exceeded or
  // the language changes). Deps deliberately exclude the content itself.
  const [highlightReady, setHighlightReady] = useState(false);
  useEffect(() => {
    if (!canHighlight) {
      setHighlightReady(false);
      return;
    }
    setHighlightReady(false);
    let cancelled = false;
    let idleHandle: number;
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (typeof w.requestIdleCallback === 'function') {
      idleHandle = w.requestIdleCallback(() => {
        if (!cancelled) setHighlightReady(true);
      });
      return () => {
        cancelled = true;
        w.cancelIdleCallback?.(idleHandle);
      };
    }
    idleHandle = window.setTimeout(() => {
      if (!cancelled) setHighlightReady(true);
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(idleHandle);
    };
  }, [canHighlight, language]);

  return (
    <div className="overflow-hidden rounded-md border border-border/60">
      {/* Header — the filename lives in the chrome above the card, so
          this header only carries the live write status + line count. */}
      <div className="flex items-center gap-1.5 px-2 py-1 bg-muted/40 border-b border-border/60 text-[11px] text-muted-foreground">
        <SpinnerGapIcon size={11} className="animate-spin text-blue-500" />
        <span className="flex items-center gap-2 shrink-0">
          <span className="text-blue-500 font-medium">
            {t('streaming.toolAction.liveLines', { count: lineCount })}
          </span>
          <span className="text-muted-foreground/60">
            {isCreate
              ? t('streaming.toolAction.writing')
              : t('streaming.toolAction.running.edit')}
          </span>
        </span>
      </div>
      {/* Live content */}
      <div
        ref={scrollRef}
        className="max-h-[200px] overflow-y-auto font-mono text-[11px] leading-[1.5] py-1"
      >
        {highlightReady && canHighlight ? (
          <SyntaxHighlighter
            language={language || 'text'}
            style={isDark ? oneDark : oneLight}
            showLineNumbers
            startingLineNumber={startLine}
            wrapLines
            lineProps={{
              style: { display: 'block', backgroundColor: 'rgba(34, 197, 94, 0.08)' },
            }}
            customStyle={{
              margin: 0,
              padding: 0,
              background: 'transparent',
              fontSize: '11px',
              lineHeight: '1.5',
            }}
            codeTagProps={{
              style: {
                fontFamily: "'Fira Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              },
            }}
          >
            {tailText}
          </SyntaxHighlighter>
        ) : (
          <>
            {lines.map((line, idx) => (
              <div key={`${startLine + idx}-${line.length}`} className="flex whitespace-pre">
                <span className="w-8 shrink-0 pr-2 text-right text-muted-foreground/35 select-none">
                  {startLine + idx}
                </span>
                <span className="flex-1 text-green-600 dark:text-green-400">{line || ' '}</span>
              </div>
            ))}
            {lines.length === 0 && (
              <div className="px-2 text-muted-foreground/50">…</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function FileEditToolRow({ tool }: FileEditToolRowProps) {
  const { t } = useTranslation();
  const activeThreadId = useConversationStore((s) => s.activeThreadId);
  const threads = useConversationStore((s) => s.threads);
  const activeThread = activeThreadId ? threads.find((th) => th.id === activeThreadId) : undefined;
  const cwd = activeThread?.workingDirectory ?? undefined;
  const [expanded, setExpanded] = useState(false);
  const [userCollapsed, setUserCollapsed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [fileHovered, setFileHovered] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const resultFilePath = typeof tool.metadata?.filePath === 'string' ? tool.metadata.filePath : '';
  const inputFilePath = getFilePath(tool.input);
  const filePath = resultFilePath || inputFilePath;
  const fileName = filePath ? (filePath.split(/[/\\]/).pop() || filePath) : 'file';
  const status = getStatus(tool);
  const hasResult = tool.result !== undefined && tool.result !== '';
  const isRunning = status === 'running';

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

  // Open the file. Delegates to openLocalArtifactTarget which routes:
  //   - .html / .htm → DUYA's side-panel browser (duya:open-browser-panel)
  //   - previewable assets (md, txt, json, png, ts, tsx, py, go, rs, …)
  //     → DUYA's side-panel file preview workspace
  //     (duya:open-file-preview-panel)
  //   - office docs (.doc/.xlsx/.pptx …), directories, binaries, and
  //     anything else → system default app via shell.openPath (a folder
  //     opens in the file manager)
  // The helper also resolves relative paths against the current
  // thread's working directory, so a bare "tank-battle.html" becomes
  // E:\projects\duya\tank-battle.html instead of https://tank-battle.html/.
  const handleOpenFile = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      if (!filePath) return;
      openLocalArtifactTarget(filePath, cwd);
    },
    [filePath, cwd],
  );

  // Copy the FULL path — the row above only shows the file name, and
  // the card's path header is truncated in the middle.
  const copyPathLabel = t('streaming.toolAction.copyPath');
  const handleCopyPath = useCallback(async () => {
    if (!filePath) return;
    try {
      await navigator.clipboard.writeText(filePath);
      setCopiedPath(true);
      setTimeout(() => setCopiedPath(false), 1500);
    } catch {
      // clipboard unavailable — leave the button as-is
    }
  }, [filePath]);

  // Plan 461: while the model is still producing the arguments (no result
  // yet) and we already see content in `input`, treat the row as a live
  // write — auto-expand the streaming preview, show the ticking line count.
  const inp = tool.input as Record<string, unknown> | undefined;
  const liveNewContent = isCreate
    ? (typeof inp?.content === 'string' ? (inp.content as string) : '')
    : (typeof inp?.new_string === 'string'
        ? (inp.new_string as string)
        : typeof inp?.new_str === 'string'
          ? (inp.new_str as string)
          : '');
  const isStreamingInput = isRunning && !hasResult && liveNewContent.length > 0;

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
    if (isCreate && typeof inp?.content === 'string') {
      return { oldContent: '', newContent: inp.content as string };
    }
    if (typeof inp?.old_string === 'string' && typeof inp?.new_string === 'string') {
      return { oldContent: inp.old_string as string, newContent: inp.new_string as string };
    }
    if (typeof inp?.new_string === 'string' || typeof inp?.new_str === 'string') {
      return {
        oldContent: (typeof inp?.old_string === 'string' ? inp.old_string : '') as string,
        newContent: (typeof inp?.new_string === 'string' ? inp.new_string : inp.new_str) as string,
      };
    }
    return null;
  })();

  const canExpand = diffPayload !== null;
  // The card is visible when: user explicitly expanded, OR the model is
  // still writing (auto-open, unless the user collapsed it mid-stream).
  const showCard = expanded || (isStreamingInput && !userCollapsed);

  const handleToggle = useCallback(() => {
    if (!canExpand) return;
    if (showCard) {
      // Collapse: respect the manual collapse even while streaming.
      setUserCollapsed(true);
      setExpanded(false);
    } else {
      setUserCollapsed(false);
      setExpanded(true);
    }
  }, [canExpand, showCard]);

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
        expanded={showCard}
        hovered={hovered}
        durationMs={tool.durationMs}
        onClick={handleToggle}
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
        {showCard && canExpand && diffPayload && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div className="mx-0.5 my-0.5 rounded-lg tool-card relative overflow-hidden">
              {/* Path header — the row above shows the file NAME only;
                  the card shows where the file actually lives (middle
                  truncated) with a copy button for the full path. */}
              {!isStreamingInput && filePath && (
                <div className="tool-diff-path">
                  <span className="truncate" title={filePath}>
                    {truncatePathMiddle(filePath, 64)}
                  </span>
                  <IconButton
                    type="button"
                    variant="ghost"
                    shape="square"
                    size="sm"
                    aria-label={copyPathLabel}
                    title={copyPathLabel}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleCopyPath();
                    }}
                    className="shrink-0"
                  >
                    {copiedPath ? (
                      <CheckCircleIcon size={12} className="text-green-500" />
                    ) : (
                      <CopyIcon size={12} />
                    )}
                  </IconButton>
                </div>
              )}
              <div className="p-1.5">
                {isStreamingInput ? (
                  // Live write preview — renders the new content as it streams.
                  <StreamingFilePreview
                    newContent={liveNewContent}
                    filePath={filePath}
                    isCreate={isCreate}
                    lineCount={stats.additions}
                  />
                ) : (
                  <SimpleDiffViewer
                    oldContent={diffPayload.oldContent}
                    newContent={diffPayload.newContent}
                    maxHeight={200}
                    language={getLanguageFromPath(filePath)}
                  />
                )}

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
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
