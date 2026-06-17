'use client';

import React, { useState, useCallback, createElement } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Icon } from '@phosphor-icons/react';
import {
  FileIcon,
  NotePencilIcon,
  TerminalIcon,
  MagnifyingGlassIcon,
  WrenchIcon,
  SpinnerGapIcon,
  CheckCircleIcon,
  XCircleIcon,
  CaretRightIcon,
  BrainIcon,
  RobotIcon,
  CopyIcon,
  ChromeIcon,
  QuestionIcon,
} from '@/components/icons';
import { Shimmer } from './Shimmer';
import { MarkdownRenderer } from './MarkdownRenderer';
import { parseAllShowWidgets } from '@/lib/widget-parser';
import { WidgetRenderer } from './WidgetRenderer';
import { WidgetErrorBoundary } from './WidgetErrorBoundary';
import type { ToolUseInfo, ToolResultInfo } from '@/types';
import { renderToolResult } from './ToolResultRenderer';
import type { AgentProgressEventWithMeta } from '@/hooks/useStreamingAgentProgress';
import { SimpleDiffViewer, calculateDiff } from '@/components/diff/SimpleDiffViewer';
import { useTranslation } from '@/hooks/useTranslation';
import { useAdaptiveTypewriter } from '@/hooks/useAdaptiveTypewriter';
import { parseSubAgentToolResult } from '@/lib/subagent-result';

export interface ToolAction {
  id?: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  durationMs?: number | null;
}

export type ActionItem =
  | { kind: 'thinking'; content: string; isStreaming?: boolean }
  | { kind: 'tool'; tool: ToolAction; streamingToolOutput?: string }
  | { kind: 'text'; content: string }
  | { kind: 'widget'; content: string; sourceMessageId?: string; sourceLabel?: string };

interface ToolActionsGroupProps {
  tools?: ToolAction[];
  actions?: ActionItem[];
  isStreaming?: boolean;
  streamingToolOutput?: string;
  flat?: boolean;
  thinkingContent?: string;
  agentProgressEvents?: AgentProgressEventWithMeta[];
  /** Full wall-clock duration from user question to final response.
   *  When provided, used in the summary in place of summed tool durations
   *  so the user sees the true response time (including model thinking). */
  totalDurationMs?: number | null;
  liveStartedAt?: number | null;
}

interface ToolRendererDef {
  match: (name: string) => boolean;
  icon: Icon;
  /** i18n key for the verb shown next to the icon (e.g. "已编辑"/"Edited").
   *  Null when no label is shown (e.g. shell/bash where the command itself
   *  is the label). Translation happens at render time inside ToolActionRow
   *  because hooks can't be called at module top level. */
  labelKey: import('@/i18n').TranslationKey | null;
  getSummary: (input: unknown, name?: string) => string;
  renderDetail?: (tool: ToolAction, streamingOutput?: string) => React.ReactNode;
}

function extractFilename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function getFilePath(input: unknown): string {
  const inp = input as Record<string, unknown> | undefined;
  if (!inp) return '';
  const rawPath = inp.file_path || inp.path || inp.filePath || '';
  return typeof rawPath === 'string' ? rawPath : '';
}

function truncatePath(path: string, maxLen = 50): string {
  if (path.length <= maxLen) return path;
  return '...' + path.slice(path.length - maxLen + 3);
}

const TOOL_REGISTRY: ToolRendererDef[] = [
  {
    match: (n) => n.toLowerCase() === 'shell',
    icon: TerminalIcon,
    labelKey: null,
    getSummary: (input) => {
      const rawCmd = (input as Record<string, unknown>)?.command || (input as Record<string, unknown>)?.cmd || '';
      const cmd = typeof rawCmd === 'string' ? rawCmd : JSON.stringify(rawCmd);
      return cmd ? (cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd) : 'shell';
    },
  },
  {
    match: (n) => ['bash', 'execute', 'run', 'execute_command', 'run_command'].includes(n.toLowerCase()),
    icon: TerminalIcon,
    labelKey: null,
    getSummary: (input) => {
      const rawCmd = (input as Record<string, unknown>)?.command || (input as Record<string, unknown>)?.cmd || '';
      const cmd = typeof rawCmd === 'string' ? rawCmd : JSON.stringify(rawCmd);
      return cmd ? (cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd) : 'bash';
    },
  },
  {
    match: (n) => n.toLowerCase() === 'duya_cli' || n.toLowerCase() === 'duya-cli' || n.toLowerCase() === 'duyacli',
    icon: TerminalIcon,
    labelKey: 'streaming.toolAction.label.cli',
    getSummary: (input) => {
      // "Run duya status" / "运行 duya status"
      const argv = (input as Record<string, unknown>)?.argv;
      const args = Array.isArray(argv) ? argv.map(String) : [];
      return args.length > 0 ? `duya ${args.join(' ')}` : 'duya';
    },
  },
  {
    match: (n) => ['edit', 'edit_file', 'str_replace_editor'].includes(n.toLowerCase()),
    icon: NotePencilIcon,
    labelKey: 'streaming.toolAction.label.edit',
    getSummary: (input) => {
      const path = getFilePath(input);
      return path ? extractFilename(path) : 'file';
    },
  },
  {
    match: (n) => ['write', 'writefile', 'write_file', 'create_file', 'createfile'].includes(n.toLowerCase()),
    icon: NotePencilIcon,
    labelKey: 'streaming.toolAction.label.create',
    getSummary: (input) => {
      const path = getFilePath(input);
      return path ? extractFilename(path) : 'file';
    },
  },
  {
    match: (n) => ['read', 'readfile', 'read_file', 'read_multiple_files'].includes(n.toLowerCase()),
    icon: FileIcon,
    labelKey: 'streaming.toolAction.label.read',
    getSummary: (input) => {
      const path = getFilePath(input);
      return path ? extractFilename(path) : 'file';
    },
  },
  {
    match: (n) => ['search', 'glob', 'grep', 'find_files', 'search_files'].includes(n.toLowerCase()),
    icon: MagnifyingGlassIcon,
    labelKey: 'streaming.toolAction.label.search',
    getSummary: (input) => {
      const inp = input as Record<string, unknown> | undefined;
      const rawPattern = inp?.pattern || inp?.query || inp?.glob || '';
      const pattern = typeof rawPattern === 'string' ? rawPattern : JSON.stringify(rawPattern);
      return pattern ? `"${pattern.length > 50 ? pattern.slice(0, 47) + '...' : pattern}"` : 'search';
    },
  },
  {
    match: (n) => ['agent', 'subagent', 'sub_agent'].includes(n.toLowerCase()),
    icon: RobotIcon,
    labelKey: 'streaming.toolAction.label.agent',
    getSummary: (input) => {
      const inp = input as Record<string, unknown> | undefined;
      const name = inp?.name || inp?.description || '';
      const subagentType = inp?.subagent_type || '';
      if (name && typeof name === 'string') {
        return name.length > 50 ? name.slice(0, 47) + '...' : name;
      }
      if (subagentType && typeof subagentType === 'string') {
        return subagentType;
      }
      return 'Launch agent';
    },
  },
  {
    match: (n) => isBrowserTool(n),
    icon: ChromeIcon,
    labelKey: 'streaming.toolAction.label.browser',
    getSummary: (input, name) => {
      const inp = (input || {}) as Record<string, unknown>;
      if (typeof inp.title === 'string' && inp.title.trim()) return inp.title.trim();
      if (typeof inp.description === 'string' && inp.description.trim()) return inp.description.trim();
      if (typeof inp.url === 'string' && inp.url) return inp.url;
      if (typeof inp.operation === 'string' && inp.operation) return inp.operation as string;
      return name || 'browser';
    },
  },
  {
    // AskUserQuestion. Mirrors BashToolRow's pattern — a dedicated
    // AskUserQuestionResultRow renders both the collapsed header and the
    // expanded dark card. We register an entry so the registry can still
    // produce a sensible icon / summary if the row component ever falls
    // back to the generic renderer.
    match: (n) => n.toLowerCase() === 'askuserquestion',
    icon: QuestionIcon,
    labelKey: 'streaming.toolAction.label.askQuestion',
    getSummary: (input) => {
      const inp = (input || {}) as Record<string, unknown>;
      const firstQ = (inp.questions as Array<{ question?: string }> | undefined)?.[0];
      const q = firstQ?.question || '';
      return q ? (q.length > 60 ? q.slice(0, 57) + '...' : q) : 'question';
    },
  },
  {
    match: () => true,
    icon: WrenchIcon,
    labelKey: null,
    getSummary: (input, name?: string) => {
      const prefix = name || '';
      if (!input || typeof input !== 'object') return prefix;
      const str = JSON.stringify(input);
      const detail = str.length > 50 ? str.slice(0, 47) + '...' : str;
      return prefix ? `${prefix} ${detail}` : detail;
    },
  },
];

function getRenderer(name: string): ToolRendererDef {
  return TOOL_REGISTRY.find((r) => r.match(name)) || TOOL_REGISTRY[TOOL_REGISTRY.length - 1];
}

type ToolStatus = 'running' | 'success' | 'error';

function getStatus(tool: ToolAction): ToolStatus {
  if (tool.result === undefined) return 'running';
  return tool.isError ? 'error' : 'success';
}

function isLegacySubAgentToolAction(tool: ToolAction): boolean {
  const lowerName = tool.name.toLowerCase();
  if (lowerName !== 'task') return false;
  const input = tool.input as Record<string, unknown> | undefined;
  if (typeof input?.prompt === 'string' || typeof input?.subagent_type === 'string') {
    return true;
  }
  const parsed = parseSubAgentToolResult(tool.result);
  return Boolean(parsed?.sessionId || parsed?.background);
}

function StatusDot({ status }: { status: ToolStatus }) {
  return (
    <AnimatePresence mode="wait">
      {status === 'running' && (
        <motion.span
          key="running"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="inline-flex"
        >
          <SpinnerGapIcon size={14} className="shrink-0 animate-spin text-muted-foreground/50" />
        </motion.span>
      )}
      {status === 'success' && (
        <motion.span
          key="success"
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 400, damping: 20 }}
          className="inline-flex"
        >
          <CheckCircleIcon size={14} className="shrink-0 text-green-500" />
        </motion.span>
      )}
      {status === 'error' && (
        <motion.span
          key="error"
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 400, damping: 20 }}
          className="inline-flex"
        >
          <XCircleIcon size={14} className="shrink-0 text-red-500" />
        </motion.span>
      )}
    </AnimatePresence>
  );
}

const CONTEXT_TOOLS = new Set([
  'read', 'readfile', 'read_file', 'read_multiple_files',
  'glob', 'grep', 'ls', 'search', 'find_files', 'search_files',
  // 'web_search', // Disabled - use browser_tool instead
]);

function isContextTool(name: string): boolean {
  return CONTEXT_TOOLS.has(name.toLowerCase());
}

// Browser tools (chrome / browser / browsertool / browser_tool).
// Consecutive browser actions are collapsed into a single "已使用 浏览器"
// group rather than rendered as a wall of JSON dumps.
const BROWSER_TOOLS = new Set([
  'browser', 'browsertool', 'browser_tool', 'chrome',
]);

function isBrowserTool(name: string): boolean {
  const lower = name.toLowerCase();
  if (BROWSER_TOOLS.has(lower)) return true;
  // Match browser sub-actions like browser_navigate, browser_click,
  // browser_screenshot, etc. — agents often expose browser capability
  // as one base tool with an `operation` parameter, but they may also
  // expose it as a family of namespaced tools. Treating any name
  // starting with "browser_" as a browser tool keeps every consecutive
  // call inside the same BrowserGroup instead of leaking the last one
  // out as a standalone row.
  if (lower.startsWith('browser_') || lower.startsWith('browser-')) {
    return true;
  }
  return false;
}

// AskUserQuestion has a dedicated row layout (mirrors BashToolRow).
// The tool name is registered as 'AskUserQuestion' on the agent side
// (see ASK_USER_QUESTION_TOOL_NAME in packages/agent). Only one
// canonical name exists — no sub-action family to match.
const ASK_USER_QUESTION_TOOLS = new Set(['askuserquestion']);

function isAskUserQuestionTool(name: string): boolean {
  return ASK_USER_QUESTION_TOOLS.has(name.toLowerCase());
}

// Try to extract a snapshot-style field from a browser tool's result JSON.
// Returns the snapshot text or `null` if none is present.
export function extractBrowserSnapshot(result: string | undefined): string | null {
  if (!result) return null;
  try {
    const data = JSON.parse(result);
    if (typeof data?.compactSnapshot === 'string' && data.compactSnapshot.trim()) {
      return data.compactSnapshot;
    }
    if (typeof data?.snapshot === 'string' && data.snapshot.trim()) {
      return data.snapshot;
    }
    if (typeof data?.content === 'string' && data.content.trim()) {
      return data.content;
    }
  } catch {
    // not JSON — ignore
  }
  return null;
}

// Pull a human-friendly title for one browser action. Falls back to the
// operation name, the URL, or the tool name.
export function getBrowserActionTitle(input: unknown, toolName: string): string {
  const inp = (input || {}) as Record<string, unknown>;
  if (typeof inp.title === 'string' && inp.title.trim()) return inp.title.trim();
  if (typeof inp.description === 'string' && inp.description.trim()) return inp.description.trim();
  const op = inp.operation;
  if (typeof op === 'string' && op.trim()) {
    const opName = op.replace(/_/g, ' ');
    return opName.charAt(0).toUpperCase() + opName.slice(1);
  }
  if (typeof inp.url === 'string' && inp.url.trim()) return inp.url;
  return toolName || 'Browser action';
}

// Detect if the browser tool is running in fallback mode (extension not
// installed) so we can show a single warning banner at the top of the
// group rather than repeating the message per action.
export function isBrowserFallbackMode(tools: ToolAction[]): boolean {
  for (const t of tools) {
    if (!t.result) continue;
    try {
      const data = JSON.parse(t.result);
      if (data?.mode === 'fallback') return true;
      if (typeof data?.error === 'string' &&
          (data.error.includes('fallback') ||
           data.error.includes('Extension') ||
           data.error.includes('not available'))) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

const FILE_EDIT_TOOLS = new Set([
  'edit', 'edit_file', 'str_replace_editor',
]);

const FILE_CREATE_TOOLS = new Set([
  'write', 'writefile', 'write_file', 'create_file', 'createfile',
]);

type FileEditKind = 'edit' | 'create' | 'unknown';

interface FileEditStats {
  stats: { additions: number; removals: number };
  kind: FileEditKind;
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

type Segment =
  | { kind: 'context'; tools: ToolAction[] }
  | { kind: 'browser'; tools: ToolAction[] }
  | { kind: 'single'; tool: ToolAction };

function computeSegments(tools: ToolAction[]): Segment[] {
  const segments: Segment[] = [];
  let contextBuffer: ToolAction[] = [];
  let browserBuffer: ToolAction[] = [];

  const flushContext = () => {
    if (contextBuffer.length >= 3) {
      segments.push({ kind: 'context', tools: contextBuffer });
    } else {
      for (const t of contextBuffer) {
        segments.push({ kind: 'single', tool: t });
      }
    }
    contextBuffer = [];
  };

  const flushBrowser = () => {
    // Only collapse into a BrowserGroup when there are 2+ consecutive
    // browser actions. A single browser call has no reason to render
    // behind a "已使用 浏览器" header — the standalone ToolActionRow
    // already shows the icon + label + summary, which is exactly what
    // a single browser call should look like.
    if (browserBuffer.length >= 2) {
      segments.push({ kind: 'browser', tools: browserBuffer });
    } else {
      for (const t of browserBuffer) {
        segments.push({ kind: 'single', tool: t });
      }
    }
    browserBuffer = [];
  };

  for (const tool of tools) {
    if (isBrowserTool(tool.name)) {
      flushContext();
      browserBuffer.push(tool);
    } else if (isContextTool(tool.name)) {
      flushBrowser();
      contextBuffer.push(tool);
    } else {
      flushContext();
      flushBrowser();
      segments.push({ kind: 'single', tool });
    }
  }
  flushContext();
  flushBrowser();
  return segments;
}

function ContextGroup({ tools }: { tools: ToolAction[] }) {
  const [expanded, setExpanded] = useState(false);
  const hasRunning = tools.some((t) => t.result === undefined);
  const hasError = tools.some((t) => t.isError);
  const groupStatus: ToolStatus = hasRunning ? 'running' : hasError ? 'error' : 'success';

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-2 px-2 py-1 min-h-[28px] text-xs hover:bg-muted/30 rounded-sm transition-colors"
      >
        <MagnifyingGlassIcon size={14} className="shrink-0 text-muted-foreground" />
        <CaretRightIcon
          size={10}
          className={`shrink-0 text-muted-foreground/60 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="font-medium text-muted-foreground">
          {hasRunning ? `Gathering context (${tools.length})` : `Gathered context (${tools.length} files)`}
        </span>
        <span className="ml-auto">
          <StatusDot status={groupStatus} />
        </span>
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div className="ml-4 border-l-2 border-border/30 pl-2">
              {tools.map((tool, i) => (
                <ToolActionRow key={tool.id || `ctx-${i}`} tool={tool} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// =============================================================================
// BrowserGroup — collapses consecutive browser actions into a single
// "已使用 浏览器" toggle. The expanded body lists each browser action
// using the same `ToolActionRow` component used for standalone browser
// actions outside the group, so the inside / outside UI stays identical
// (icon, label, summary, status, expandable detail).
// =============================================================================

export function BrowserGroup({ tools }: { tools: ToolAction[] }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const hasRunning = tools.some((t) => t.result === undefined);
  const hasError = tools.some((t) => t.isError);
  const groupStatus: ToolStatus = hasRunning ? 'running' : hasError ? 'error' : 'success';

  return (
    <div className="browser-group">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-2 px-2 py-1 min-h-[28px] text-xs hover:bg-muted/30 rounded-sm transition-colors"
      >
        <CaretRightIcon
          size={10}
          className={`shrink-0 text-muted-foreground/60 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="font-medium text-muted-foreground">
          {tools.length === 1
            ? t('streaming.toolAction.usedBrowser')
            : t('streaming.toolAction.usedBrowserCount', { count: tools.length })}
        </span>
        <span className="ml-auto">
          <StatusDot status={groupStatus} />
        </span>
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div className="browser-group-body">
              {isBrowserFallbackMode(tools) && (
                <div className="browser-group-fallback">
                  <span className="font-medium text-[11px] text-amber-500">
                    {t('streaming.toolAction.fallbackTitle')}
                  </span>
                  <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                    {t('streaming.toolAction.fallbackDesc')}
                  </p>
                </div>
              )}
              {tools.map((tool, i) => (
                <ToolActionRow key={tool.id || `brw-${i}`} tool={tool} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ThinkingRow({ content, isStreaming }: { content: string; isStreaming?: boolean }) {
  const [expanded, setExpanded] = useState(!!isStreaming);
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

function TextRow({ content, isStreaming }: { content: string; isStreaming?: boolean }) {
  // When this is the live, growing text block, pace it with the adaptive
  // typewriter so the user sees the text stream in smoothly instead of
  // jumping in SSE chunk sizes. Older (stable) blocks render their full
  // content immediately — the typewriter's rAF loop is a no-op for them
  // because their target length is already caught up to displayed.
  const displayedContent = useAdaptiveTypewriter(content, !!isStreaming);
  const renderSource = isStreaming ? displayedContent : content;

  const hasWidgetFence = content.includes('```show-widget');

  if (!hasWidgetFence) {
    return (
      <MarkdownRenderer className="px-2 py-1.5 text-sm text-foreground/90 prose prose-sm dark:prose-invert max-w-none message-content">
        {renderSource}
      </MarkdownRenderer>
    );
  }

  const segments = parseAllShowWidgets(renderSource);
  const hasWidgets = segments.some(s => s.type === 'widget');

  if (!hasWidgets) {
    return (
      <MarkdownRenderer className="px-2 py-1.5 text-sm text-foreground/90 prose prose-sm dark:prose-invert max-w-none message-content">
        {renderSource}
      </MarkdownRenderer>
    );
  }

  return (
    <div className="px-2 py-1.5">
      {segments.map((seg, i) => {
        if (seg.type === 'text') {
          return (
            <MarkdownRenderer
              key={`t-${i}`}
              className="text-sm text-foreground/90 prose prose-sm dark:prose-invert max-w-none message-content"
            >
              {seg.content || ''}
            </MarkdownRenderer>
          );
        }
        if (seg.type === 'widget' && seg.data) {
          return (
            <WidgetErrorBoundary key={`w-${i}`} widgetCode={seg.data.widget_code}>
              <WidgetRenderer
                widgetCode={seg.data.widget_code}
                isStreaming={false}
                sourceLabel="Tool result"
              />
            </WidgetErrorBoundary>
          );
        }
        return null;
      })}
    </div>
  );
}

function BashToolRow({ tool, streamingToolOutput }: { tool: ToolAction; streamingToolOutput?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [hovered, setHovered] = useState(false);
  const { t, locale } = useTranslation();
  const rawCmd = (tool.input as Record<string, unknown>)?.command || '';
  const cmd = typeof rawCmd === 'string' ? rawCmd : JSON.stringify(rawCmd);
  const isRunning = tool.result === undefined;
  const outputText = isRunning ? streamingToolOutput : tool.result;
  const hasOutput = !!outputText && outputText.trim().length > 0;
  const status = getStatus(tool);
  const lineCount = outputText ? outputText.split('\n').length : 0;
  // Distinguish shell tool vs bash tool: shellTool -> "Shell", bashTool -> "Bash".
  const shellLabel = tool.name.toLowerCase() === 'shell' ? 'Shell' : 'Bash';

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  // "Ran command / 已运行命令" — bilingual. For running tools we
  // fall back to the generic "working" / "运行中" label.
  const separator = locale === 'zh' ? '，' : ', ';
  const baseLabel = isRunning
    ? t('streaming.workingFor')
    : locale === 'zh'
      ? '已运行命令'
      : 'Ran command';
  const durationStr = formatDuration(tool.durationMs ?? 0);
  // For zh: "已运行命令，耗时 2s" — uses the existing i18n key.
  // For en: "Ran command, 2s" — no verb repetition.
  const ranLabelFull = durationStr
    ? locale === 'zh'
      ? `${baseLabel}${separator}${t('streaming.actions.workedFor', { duration: durationStr })}`
      : `${baseLabel}${separator}${durationStr}`
    : baseLabel;

  const displayLines = (() => {
    if (!outputText) return null;
    if (isRunning) {
      const lines = outputText.split('\n');
      return lines.slice(-5).join('\n');
    }
    const lines = outputText.split('\n');
    if (lines.length > 20) {
      return lines.slice(0, 20).join('\n') + `\n… +${lines.length - 20} lines`;
    }
    return outputText;
  })();

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className="flex w-full items-center gap-2 px-2 py-1 min-h-[28px] text-xs hover:bg-muted/30 rounded-sm transition-colors"
      >
        <TerminalIcon size={14} className="shrink-0 text-muted-foreground" />
        <span
          className={`font-mono truncate flex-1 text-left transition-colors ${
            hovered ? 'text-foreground' : 'text-muted-foreground/60'
          }`}
        >
          {expanded ? ranLabelFull : cmd}
        </span>
        {!expanded && !isRunning && hasOutput && (
          <span className="text-[10px] text-muted-foreground/40 tabular-nums">
            {lineCount} lines
          </span>
        )}
        {!expanded && <StatusDot status={status} />}
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
            <div className="mx-1 my-1 rounded-lg tool-card p-3 relative">
              {/* Shell label */}
              <div className="text-[11px] tool-card-muted font-medium mb-1.5">{shellLabel}</div>

              {/* Command with copy button */}
              <div className="group relative font-mono text-[13px] tool-card-subtle leading-relaxed pr-7">
                <span className="tool-card-muted mr-1.5 select-none">$</span>
                <span className="break-all">{cmd}</span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleCopy(); }}
                  className="absolute right-0 top-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded tool-card-faint hover:tool-card-subtle hover:bg-black/5 dark:hover:bg-white/5"
                  title="Copy command"
                >
                  {copied ? <CheckCircleIcon size={14} className="text-green-500" /> : <CopyIcon size={14} />}
                </button>
              </div>

              {/* Output */}
              {displayLines ? (
                <div className="font-mono text-[12px] tool-card-muted whitespace-pre-wrap break-all max-h-[150px] overflow-auto leading-relaxed mt-1.5">
                  {displayLines}
                </div>
              ) : (
                <div className="text-[12px] tool-card-faint italic mt-1.5">No output</div>
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
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface DuyaCliResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  ok?: boolean;
  command?: string;
}

function parseDuyaCliResult(result: string | undefined): DuyaCliResult | null {
  if (!result) return null;
  try {
    const data = JSON.parse(result);
    if (typeof data === 'object' && data !== null) {
      return data as DuyaCliResult;
    }
  } catch {
    // Fall through: result might be a plain string. Treat it as stdout.
  }
  return { stdout: result };
}

/**
 * duya_cli tool row — runs a `duya <args>` subcommand and shows stdout / stderr
 * separately, mirroring the BashToolRow layout.
 */
function DuyaCliToolRow({ tool }: { tool: ToolAction }) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const { locale } = useTranslation();
  const status = getStatus(tool);
  const hasResult = tool.result !== undefined && tool.result !== '';

  const argv = (tool.input as Record<string, unknown>)?.argv;
  const args = Array.isArray(argv) ? argv.map(String) : [];
  const cmd = args.length > 0 ? `duya ${args.join(' ')}` : 'duya';
  const isRunning = tool.result === undefined;
  const parsed = hasResult ? parseDuyaCliResult(tool.result) : null;
  const exitCode = parsed?.exitCode;
  const stdout = parsed?.stdout ?? '';
  const okFlag = parsed?.ok;
  // When tool marks failure via ok=false or non-zero exit, treat as error even
  // if isError flag is missing. stderr is intentionally hidden from the
  // card — the failure is conveyed through the bottom-right badge instead.
  const isError = tool.isError || okFlag === false || (exitCode !== undefined && exitCode !== 0);
  const hasStdout = !!stdout && stdout.trim().length > 0;

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className="flex w-full items-center gap-2 px-2 py-1 min-h-[28px] text-xs hover:bg-muted/30 rounded-sm transition-colors"
      >
        <TerminalIcon size={14} className="shrink-0 text-muted-foreground" />
        {locale === 'zh' ? (
          <span className="text-muted-foreground shrink-0">执行</span>
        ) : (
          <span className="text-muted-foreground shrink-0">Run</span>
        )}
        <span
          className={`font-mono truncate flex-1 text-left transition-colors ${
            hovered ? 'text-foreground' : 'text-muted-foreground/60'
          }`}
        >
          {cmd}
        </span>
        {tool.durationMs != null && tool.durationMs > 0 && (
          <span className="text-muted-foreground/50 text-[11px] tabular-nums shrink-0 font-mono">
            {formatDuration(tool.durationMs)}
          </span>
        )}
        {!expanded && <StatusDot status={isError ? 'error' : status} />}
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
            <div className="mx-1 my-1 rounded-lg tool-card p-3 relative">
              <div className="font-mono text-[13px] tool-card-subtle leading-relaxed">
                <span className="break-all">{cmd}</span>
              </div>

              {hasStdout && (
                <>
                  <div className="mt-2 mb-1.5" style={{ borderTop: '1px solid var(--tool-card-divider)' }} />
                  <div className="font-mono text-[12px] tool-card-subtle whitespace-pre-wrap break-all max-h-[150px] overflow-auto leading-relaxed">
                    {stdout}
                  </div>
                </>
              )}

              {!hasStdout && !isRunning && (
                <div className="text-[12px] tool-card-faint italic mt-2">No output</div>
              )}

              <div className="mt-1 flex justify-end">
                {status === 'running' && (
                  <div className="flex items-center gap-1 text-[11px] text-amber-500">
                    <SpinnerGapIcon size={12} className="animate-spin" />
                    <span>Running</span>
                  </div>
                )}
                {!isRunning && isError && (
                  <div className="flex items-center gap-1 text-[11px] text-red-500">
                    <XCircleIcon size={12} />
                    <span>{exitCode != null ? `Failed (exit ${exitCode})` : 'Failed'}</span>
                  </div>
                )}
                {!isRunning && !isError && (
                  <div className="flex items-center gap-1 text-[11px] text-green-500">
                    <CheckCircleIcon size={12} />
                    <span>Success</span>
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

function SubAgentToolRow({
  tool,
  agentProgressEvents,
}: {
  tool: ToolAction;
  agentProgressEvents?: AgentProgressEventWithMeta[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const renderer = getRenderer(tool.name);
  const summary = renderer.getSummary(tool.input, tool.name);
  const parsedResult = React.useMemo(() => parseSubAgentToolResult(tool.result), [tool.result]);
  const displayResult = parsedResult?.error || parsedResult?.content || tool.result;
  const isError = tool.isError || !!parsedResult?.error;
  const status: ToolStatus = tool.result === undefined ? 'running' : isError ? 'error' : 'success';
  const isRunning = status === 'running';

  // Filter events for this sub-agent
  const subAgentEvents = React.useMemo(() => {
    const events = agentProgressEvents || [];
    const sessionId = parsedResult?.sessionId;
    if (sessionId) {
      const filteredBySession = events.filter((event) => event.sessionId === sessionId);
      if (filteredBySession.length > 0) return filteredBySession;
    }
    const taskId = parsedResult?.taskId;
    if (taskId) {
      const filteredByTask = events.filter((event) => event.agentId === taskId);
      if (filteredByTask.length > 0) return filteredByTask;
    }
    return events;
  }, [agentProgressEvents, parsedResult?.sessionId, parsedResult?.taskId]);
  const toolUseCount = subAgentEvents.filter((e) => e.type === 'tool_use').length;
  const toolResultCount = subAgentEvents.filter((e) => e.type === 'tool_result').length;
  const unresolvedTools = Math.max(0, toolUseCount - toolResultCount);
  const latestEvent = subAgentEvents[subAgentEvents.length - 1];
  const liveStatusText = (() => {
    if (!latestEvent) return null;
    if (latestEvent.type === 'started') return 'Started';
    if (latestEvent.type === 'thinking') return latestEvent.data || 'Thinking';
    if (latestEvent.type === 'tool_use') return `Running ${latestEvent.toolName || 'tool'}`;
    if (latestEvent.type === 'tool_result') return `Finished ${latestEvent.toolName || 'tool'}`;
    if (latestEvent.type === 'text') return latestEvent.data || 'Writing';
    if (latestEvent.type === 'done') return 'Completed';
    if (latestEvent.type === 'error') return 'Failed';
    return null;
  })();

  // Build progress steps from events
  const steps = React.useMemo(() => {
    const result: Array<{ type: string; title: string; status: 'running' | 'done' | 'error' }> = [];
    for (const event of subAgentEvents) {
      if (event.type === 'started') {
        result.push({ type: 'started', title: 'Started', status: 'running' });
      } else if (event.type === 'thinking') {
        const started = result.find((s) => s.type === 'started' && s.status === 'running');
        if (started) started.status = 'done';
        result.push({ type: 'thinking', title: 'Thinking', status: 'done' });
      } else if (event.type === 'tool_use') {
        const started = result.find((s) => s.type === 'started' && s.status === 'running');
        if (started) started.status = 'done';
        result.push({ type: 'tool', title: `Run ${event.toolName || 'Tool'}`, status: 'running' });
      } else if (event.type === 'tool_result') {
        // Mark last running tool as done
        const lastTool = result.filter((s) => s.type === 'tool').pop();
        if (lastTool) lastTool.status = 'done';
      } else if (event.type === 'done') {
        // Mark all running as done
        result.forEach((s) => { if (s.status === 'running') s.status = 'done'; });
      } else if (event.type === 'error') {
        result.push({ type: 'error', title: 'Failed', status: 'error' });
      }
    }
    if (tool.result !== undefined) {
      result.forEach((step) => {
        if (step.status === 'running') step.status = isError ? 'error' : 'done';
      });
      if (result.length === 0) {
        result.push({
          type: isError ? 'error' : 'done',
          title: parsedResult?.background ? 'Background agent launched' : isError ? 'Failed' : 'Completed',
          status: isError ? 'error' : 'done',
        });
      }
    }
    return result;
  }, [isError, parsedResult?.background, subAgentEvents, tool.result]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className="flex w-full items-center gap-2 px-2 py-1 min-h-[28px] text-xs hover:bg-muted/30 rounded-sm transition-colors"
      >
        <CaretRightIcon
          size={10}
          className={`shrink-0 text-muted-foreground/60 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
        />
        <RobotIcon size={14} className="shrink-0 text-muted-foreground" />
        <span className="font-medium text-muted-foreground shrink-0">Sub-agent</span>
        <span
          className={`font-mono truncate flex-1 text-left transition-colors ${
            hovered ? 'text-foreground' : 'text-muted-foreground/60'
          }`}
        >
          {summary}
        </span>
        {toolUseCount > 0 && (
          <span className="text-muted-foreground/60 text-[10px]">({toolUseCount} tools)</span>
        )}
        {unresolvedTools > 0 && (
          <span className="text-amber-500 text-[10px]">{unresolvedTools} pending</span>
        )}
        {tool.durationMs != null && tool.durationMs > 0 && (
          <span className="text-muted-foreground/50 text-[11px] tabular-nums shrink-0 font-mono">
            {formatDuration(tool.durationMs)}
          </span>
        )}
        <StatusDot status={status} />
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
            <div className="ml-4 mt-1 border-l-2 border-border/30 pl-3 py-2">
              {steps.length === 0 ? (
                <div className="text-[11px] text-muted-foreground/60">
                  {liveStatusText || (isRunning ? 'Initializing...' : 'Completed')}
                </div>
              ) : (
                <div className="space-y-1">
                  {steps.map((step, index) => (
                    <div key={index} className="flex items-center gap-2 text-[11px]">
                      <span className="text-muted-foreground/50">#{index + 1}</span>
                      <span
                        className={`inline-block h-1.5 w-1.5 rounded-full ${
                          step.status === 'running'
                            ? 'bg-amber-500 animate-pulse'
                            : step.status === 'error'
                            ? 'bg-red-500'
                            : 'bg-emerald-500'
                        }`}
                      />
                      <span className="text-muted-foreground/80">{step.title}</span>
                    </div>
                  ))}
                </div>
              )}
              {(parsedResult?.resolvedAgentType || parsedResult?.sessionId) && (
                <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] tool-card-faint">
                  {(parsedResult?.resolvedAgentType || parsedResult?.agentType) && (
                    <span className="rounded-full border border-tool-card-divider px-2 py-0.5" style={{ borderColor: 'var(--tool-card-divider)' }}>
                      {parsedResult?.resolvedAgentType || parsedResult?.agentType}
                    </span>
                  )}
                  {parsedResult?.sessionId && (
                    <span className="rounded-full border border-tool-card-divider px-2 py-0.5 font-mono" style={{ borderColor: 'var(--tool-card-divider)' }}>
                      {parsedResult.sessionId.slice(0, 8)}
                    </span>
                  )}
                </div>
              )}
              {displayResult && (
                <div className="mt-2 rounded-md tool-card p-2">
                  <MarkdownRenderer className="prose prose-sm dark:prose-invert max-w-none message-content max-h-[160px] overflow-y-auto pr-1 text-[12px] tool-card-subtle">
                    {displayResult}
                  </MarkdownRenderer>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Parse edit tool result to get old and new content
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
 * Parse line range from read tool result
 * Returns null if no line range found
 */
function parseReadLineRange(result: string): { start: number; end: number } | null {
  if (!result) return null;
  const match = result.match(/^File:\s*.+?\s*\nLines:\s*(\d+)-(\d+)\s*\n\n/);
  if (match) {
    return { start: parseInt(match[1]), end: parseInt(match[2]) };
  }
  return null;
}

/**
 * Read tool row - shows line range in toggle instead of duplicate file path
 */
function ReadToolRow({ tool }: { tool: ToolAction }) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const filePath = getFilePath(tool.input);
  const fileName = filePath.split(/[/\\]/).pop() || filePath;
  const status = getStatus(tool);
  const hasResult = tool.result !== undefined && tool.result !== '';

  // Parse line range from result
  const lineRange = hasResult ? parseReadLineRange(tool.result!) : null;

  // Build tool info for renderToolResult
  const toolInfo: ToolUseInfo = {
    id: tool.id || '',
    name: tool.name,
    input: tool.input,
  };

  const resultInfo: ToolResultInfo = {
    tool_use_id: tool.id || '',
    content: tool.result || '',
    is_error: tool.isError,
  };

  const renderedResult = hasResult ? renderToolResult(toolInfo, resultInfo) : null;

  return (
    <div>
      <button
        type="button"
        onClick={() => hasResult && setExpanded(prev => !prev)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={`flex w-full items-center gap-2 px-2 py-1 min-h-[28px] text-xs hover:bg-muted/30 rounded-sm transition-colors ${hasResult ? 'cursor-pointer' : 'cursor-default'}`}
      >
        {hasResult && (
          <CaretRightIcon
            size={10}
            className={`shrink-0 text-muted-foreground/60 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          />
        )}

        <FileIcon size={14} className="shrink-0 text-muted-foreground" />

        <span
          className={`font-mono truncate flex-1 text-left transition-colors ${
            hovered ? 'text-foreground' : 'text-muted-foreground/60'
          }`}
        >
          {fileName}
        </span>

        {/* Line range info - replaces duplicate file path */}
        {lineRange && (
          <span className="text-[11px] text-muted-foreground/50 tabular-nums shrink-0 font-mono">
            L{lineRange.start}-{lineRange.end}
          </span>
        )}

        {tool.durationMs != null && tool.durationMs > 0 && (
          <span className="text-muted-foreground/50 text-[11px] tabular-nums shrink-0 font-mono">
            {formatDuration(tool.durationMs)}
          </span>
        )}

        <StatusDot status={status} />
      </button>

      <AnimatePresence initial={false}>
        {expanded && hasResult && renderedResult && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div className="mx-1 my-1 rounded-lg tool-card p-3 relative">
              {renderedResult}

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

/**
 * AskUserQuestionResultRow — action-stream row for the AskUserQuestion tool.
 *
 * Mirrors the collapsed / expanded shape of BashToolRow and DuyaCliToolRow:
 *  - Collapsed: [icon] [AskUserQuestion] [first question's text] [status dot]
 *  - Expanded:  dark card with the tool label, the parsed answer pairs
 *               ("Q1 → A1 / Q2 → A2"), and a Success badge at the bottom.
 *
 * The result string is the LLM-facing format produced by
 * AskUserQuestionTool.formatAnswersForLLM():
 *   User has answered your questions: "Q1"="A1", "Q2"="A2". You can now ...
 *
 * Parsing extracts the "question"="answer" pairs via regex. On parse
 * failure (e.g. the format ever changes), we fall back to rendering the
 * raw result text inside the same dark card.
 */
function AskUserQuestionResultRow({ tool }: { tool: ToolAction }) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const status = getStatus(tool);
  const summary = (() => {
    const inp = (tool.input || {}) as Record<string, unknown>;
    const firstQ = (inp.questions as Array<{ question?: string }> | undefined)?.[0];
    return firstQ?.question || 'question';
  })();

  // Parse `"question"="answer"` pairs from formatAnswersForLLM output.
  const parsedAnswers = (() => {
    if (!tool.result) return [];
    const re = /"(.+?)"="((?:[^"\\]|\\.)*)"/g;
    const out: Array<{ q: string; a: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(tool.result)) !== null) {
      out.push({ q: m[1], a: m[2] });
    }
    return out;
  })();

  return (
    <div>
      <button
        type="button"
        onClick={() => tool.result !== undefined && setExpanded((prev) => !prev)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={`flex w-full items-center gap-2 px-2 py-1 min-h-[28px] text-xs rounded-sm transition-colors ${
          tool.result !== undefined ? 'hover:bg-muted/30 cursor-pointer' : 'cursor-default'
        }`}
      >
        {tool.result !== undefined && (
          <CaretRightIcon
            size={10}
            className={`shrink-0 text-muted-foreground/60 transition-transform duration-200 ${
              expanded ? 'rotate-90' : ''
            }`}
          />
        )}

        <QuestionIcon size={14} className="shrink-0 text-muted-foreground" />

        <span
          className={`font-mono truncate flex-1 text-left transition-colors ${
            hovered ? 'text-foreground' : 'text-muted-foreground/60'
          }`}
        >
          {summary}
        </span>

        {tool.durationMs != null && tool.durationMs > 0 && (
          <span className="text-muted-foreground/50 text-[11px] tabular-nums shrink-0 font-mono">
            {formatDuration(tool.durationMs)}
          </span>
        )}

        <StatusDot status={status} />
      </button>

      <AnimatePresence initial={false}>
        {expanded && tool.result !== undefined && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div className="mx-1 my-1 rounded-lg tool-card p-3 relative">
              {/* Tool label — same chrome as BashToolRow's "Shell"/"Bash" tag */}
              <div className="text-[11px] tool-card-muted font-medium mb-1.5">
                AskUserQuestion
              </div>

              {/* Answer pairs */}
              {parsedAnswers.length > 0 ? (
                <div className="space-y-1">
                  {parsedAnswers.map((pair, i) => (
                    <div key={i} className="font-mono text-[12px] tool-card-subtle leading-relaxed">
                      <span className="tool-card-muted mr-1.5 select-none">›</span>
                      <span className="break-words">{pair.q}</span>
                      <span className="tool-card-faint mx-1.5">→</span>
                      <span className="text-emerald-400 break-words">{pair.a}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="font-mono text-[12px] tool-card-subtle whitespace-pre-wrap break-all max-h-[150px] overflow-auto leading-relaxed">
                  {tool.result}
                </div>
              )}

              {/* Status badge - bottom right, matching BashToolRow */}
              <div className="mt-2 flex justify-end">
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

// =============================================================================
// MemoryToolRow — dedicated row for the `Memory` tool (see
// packages/agent/src/memory/tool.ts). The tool returns a JSON envelope:
//   { success, entries?, usage?, error?, message? }
//
// Collapsed:  [BrainIcon] [verb] [human-readable summary] [StatusDot]
// Expanded:   dark card with action-specific body
//   - list:    entries table (type tag · summary · timestamp · content)
//   - add:     saved summary + content
//   - replace: oldText (strikethrough) + new summary / content
//   - remove:  removed oldText
//   - error:   red-tinted error message
// Status badge in the card footer mirrors BashToolRow / AskUserQuestionResultRow.
// =============================================================================

const MEMORY_TYPE_TONE: Record<string, string> = {
  user: 'text-sky-400 bg-sky-400/10',
  feedback: 'text-amber-400 bg-amber-400/10',
  project: 'text-violet-400 bg-violet-400/10',
  reference: 'text-emerald-400 bg-emerald-400/10',
};

const MEMORY_VERB_BY_ACTION: Record<string, import('@/i18n').TranslationKey> = {
  list: 'streaming.toolAction.label.memoryList',
  add: 'streaming.toolAction.label.memoryAdd',
  replace: 'streaming.toolAction.label.memoryReplace',
  remove: 'streaming.toolAction.label.memoryRemove',
};

function formatMemorySummary(input: Record<string, unknown>): string {
  const action = typeof input.action === 'string' ? input.action : '';
  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  switch (action) {
    case 'list':
      return 'memory'; // count placeholder — overwritten when result arrives
    case 'add':
      return summary ? `Saved "${summary.length > 50 ? summary.slice(0, 47) + '…' : summary}"` : 'Saved memory';
    case 'replace':
      return summary ? `Updated "${summary.length > 50 ? summary.slice(0, 47) + '…' : summary}"` : 'Updated memory';
    case 'remove':
      return 'Removed memory';
    default:
      return action || 'memory';
  }
}

interface MemoryEntry {
  id?: string;
  summary?: string;
  content?: string;
  timestamp?: string;
  type?: string;
}

function parseMemoryResult(result: string | undefined): {
  ok: boolean;
  entries?: MemoryEntry[];
  usage?: string;
  error?: string;
  message?: string;
} {
  if (!result) return { ok: true };
  try {
    const data = JSON.parse(result);
    if (data && typeof data === 'object') {
      return {
        ok: data.success !== false,
        entries: Array.isArray(data.entries) ? data.entries : undefined,
        usage: typeof data.usage === 'string' ? data.usage : undefined,
        error: typeof data.error === 'string' ? data.error : undefined,
        message: typeof data.message === 'string' ? data.message : undefined,
      };
    }
  } catch {
    // not JSON — fall through
  }
  return { ok: true };
}

function MemoryEntryLine({ entry }: { entry: MemoryEntry }) {
  const tone = entry.type ? MEMORY_TYPE_TONE[entry.type] : undefined;
  const content = typeof entry.content === 'string' ? entry.content.trim() : '';
  return (
    <div className="border-l-2 border-border/40 pl-2.5 py-1">
      <div className="flex items-center gap-1.5 flex-wrap">
        {entry.type && tone && (
          <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${tone}`}>
            {entry.type}
          </span>
        )}
        <span className="text-[12px] tool-card-text break-words flex-1 min-w-0">
          {entry.summary || '(no summary)'}
        </span>
        {entry.timestamp && (
          <span className="text-[10px] tool-card-faint font-mono tabular-nums shrink-0">
            § {entry.timestamp}
          </span>
        )}
      </div>
      {content && (
        <div className="text-[11px] tool-card-muted mt-1 whitespace-pre-wrap break-words leading-relaxed">
          {content.length > 240 ? content.slice(0, 237) + '…' : content}
        </div>
      )}
    </div>
  );
}

function MemoryToolRow({ tool }: { tool: ToolAction }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const status = getStatus(tool);
  const hasResult = tool.result !== undefined && tool.result !== '';
  const inp = (tool.input || {}) as Record<string, unknown>;
  const action = typeof inp.action === 'string' ? inp.action : '';
  const target = typeof inp.target === 'string' ? inp.target : 'global';
  const subtarget = typeof inp.subtarget === 'string' ? inp.subtarget : 'memory';

  const parsed = hasResult ? parseMemoryResult(tool.result) : null;
  const entryCount = parsed?.entries?.length ?? 0;
  const isError = status === 'error' || (parsed?.ok === false);

  // Collapsed summary: prefer the live entry count for `list` so the user
  // sees "Read 3 memories" as soon as the result arrives.
  const summary = (() => {
    if (action === 'list' && parsed?.entries) {
      return entryCount === 1 ? '1 memory' : `${entryCount} memories`;
    }
    return formatMemorySummary(inp);
  })();

  const verbKey = MEMORY_VERB_BY_ACTION[action];
  const verb = verbKey ? t(verbKey) : t('streaming.toolAction.label.memory');

  // Sub-label inside the card header (e.g. "global · memory").
  const subLabel = target === 'project' ? 'project' : `global · ${subtarget}`;

  return (
    <div>
      <button
        type="button"
        onClick={() => hasResult && setExpanded((prev) => !prev)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={`flex w-full items-center gap-2 px-2 py-1 min-h-[28px] text-xs rounded-sm transition-colors ${
          hasResult ? 'hover:bg-muted/30 cursor-pointer' : 'cursor-default'
        }`}
      >
        {hasResult && (
          <CaretRightIcon
            size={10}
            className={`shrink-0 text-muted-foreground/60 transition-transform duration-200 ${
              expanded ? 'rotate-90' : ''
            }`}
          />
        )}
        <BrainIcon size={14} className="shrink-0 text-muted-foreground" />
        <span className="font-medium text-muted-foreground shrink-0">{verb}</span>
        <span
          className={`font-mono truncate flex-1 text-left transition-colors ${
            hovered ? 'text-foreground' : 'text-muted-foreground/60'
          }`}
        >
          {summary}
        </span>
        {tool.durationMs != null && tool.durationMs > 0 && (
          <span className="text-muted-foreground/50 text-[11px] tabular-nums shrink-0 font-mono">
            {formatDuration(tool.durationMs)}
          </span>
        )}
        <StatusDot status={isError ? 'error' : status} />
      </button>

      <AnimatePresence initial={false}>
        {expanded && hasResult && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div className="mx-1 my-1 rounded-lg tool-card p-3 relative">
              {/* Card header — same chrome as BashToolRow's "Shell" tag */}
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-[11px] tool-card-muted font-medium">Memory</span>
                <span className="text-[10px] tool-card-faint font-mono">{subLabel}</span>
              </div>

              {/* Body — dispatched by action */}
              {isError && parsed?.error ? (
                <div className="bg-red-500/10 rounded p-2 font-mono text-[11px] text-red-400 whitespace-pre-wrap max-h-[200px] overflow-auto">
                  {parsed.error}
                </div>
              ) : action === 'list' ? (
                <>
                  {parsed?.usage && (
                    <div className="text-[10px] tool-card-faint font-mono mb-1.5">
                      {parsed.usage}
                    </div>
                  )}
                  {entryCount === 0 ? (
                    <div className="text-[12px] tool-card-faint italic">No memories</div>
                  ) : (
                    <div className="space-y-1 max-h-[260px] overflow-auto pr-1">
                      {(parsed?.entries ?? []).map((entry, i) => (
                        <MemoryEntryLine key={entry.id ?? `entry-${i}`} entry={entry} />
                      ))}
                    </div>
                  )}
                </>
              ) : action === 'add' || action === 'replace' ? (
                <div className="space-y-1.5">
                  {typeof inp.oldText === 'string' && inp.oldText && (
                    <div className="text-[11px] tool-card-faint leading-relaxed">
                      <span className="tool-card-faint mr-1.5 select-none">−</span>
                      <span className="line-through break-words">{inp.oldText}</span>
                    </div>
                  )}
                  <div className="text-[12px] tool-card-text leading-relaxed">
                    <span className="text-emerald-500 mr-1.5 select-none">+</span>
                    <span className="break-words">
                      {typeof inp.summary === 'string' && inp.summary ? inp.summary : '(no summary)'}
                    </span>
                  </div>
                  {typeof inp.content === 'string' && inp.content && (
                    <div className="text-[11px] tool-card-muted mt-1 whitespace-pre-wrap break-words leading-relaxed border-l-2 border-emerald-500/30 pl-2">
                      {inp.content}
                    </div>
                  )}
                  {parsed?.message && (
                    <div className="text-[10px] tool-card-faint mt-1">{parsed.message}</div>
                  )}
                </div>
              ) : action === 'remove' ? (
                <div className="space-y-1.5">
                  {typeof inp.oldText === 'string' && inp.oldText && (
                    <div className="text-[11px] tool-card-muted leading-relaxed">
                      <span className="text-red-400 mr-1.5 select-none">−</span>
                      <span className="line-through break-words">{inp.oldText}</span>
                    </div>
                  )}
                  {parsed?.message && (
                    <div className="text-[10px] tool-card-faint">{parsed.message}</div>
                  )}
                </div>
              ) : (
                <div className="font-mono text-[11px] tool-card-muted whitespace-pre-wrap break-all max-h-[200px] overflow-auto">
                  {tool.result}
                </div>
              )}

              {/* Status badge — bottom right, matching BashToolRow */}
              <div className="mt-2 flex justify-end">
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
 * File edit / create tool row.
 *
 * Collapsed:  [verb] [blue clickable filename] [git-style +N -M]
 * Expanded:   diff card with SimpleDiffViewer
 *
 * Stats are computed from `input` as soon as the tool_use arrives,
 * then recomputed from `result` once the tool finishes — the row
 * stays visible (and updating) throughout streaming.
 */
function FileEditToolRow({ tool }: { tool: ToolAction }) {
  const { t, locale } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [fileHovered, setFileHovered] = useState(false);
  const filePath = getFilePath(tool.input);
  const fileName = filePath.split(/[/\\]/).pop() || filePath;
  const status = getStatus(tool);
  const hasResult = tool.result !== undefined && tool.result !== '';

  // Live diff stats — visible from tool_use onwards, updated when result arrives.
  const { stats, kind } = computeFileEditStats(tool);
  const isCreate = kind === 'create';

  // Verb shown next to the icon. "已编辑"/"Edited" vs "已创建"/"Created".
  const verbKey = isCreate ? 'streaming.toolAction.created' : 'streaming.toolAction.edited';
  const verb = t(verbKey as Parameters<typeof t>[0]);
  const openFileTitle = t('streaming.toolAction.openFile');

  // Open the file in the system default editor.
  // shell.openPath delegates to `start` / `open` / `xdg-open` per OS.
  const handleOpenFile = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      if (!filePath) return;
      if (window.electronAPI?.shell?.openPath) {
        void window.electronAPI.shell.openPath(filePath);
      } else if (typeof window !== 'undefined') {
        window.open(`file://${filePath}`, '_blank');
      }
    },
    [filePath],
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

  return (
    <div>
      <div
        role="button"
        tabIndex={canExpand ? 0 : -1}
        onClick={() => canExpand && setExpanded((prev) => !prev)}
        onKeyDown={(e) => {
          if (!canExpand) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((prev) => !prev);
          }
        }}
        className={`flex w-full items-center gap-2 px-2 py-1 min-h-[28px] text-xs rounded-sm transition-colors group ${
          canExpand ? 'cursor-pointer hover:bg-muted/30' : 'cursor-default'
        }`}
      >
        {canExpand && (
          <CaretRightIcon
            size={10}
            className={`shrink-0 text-muted-foreground/60 transition-transform duration-200 ${
              expanded ? 'rotate-90' : ''
            }`}
          />
        )}

        <NotePencilIcon size={14} className="shrink-0 text-muted-foreground" />

        {/* Action verb — 已编辑 / 已创建 / Edited / Created */}
        <span className="font-medium text-muted-foreground/80 shrink-0">
          {isCreate && status === 'running' ? (
            <Shimmer duration={1.5}>{verb}</Shimmer>
          ) : (
            verb
          )}
        </span>

        {/* Blue clickable filename — opens in system default editor */}
        <button
          type="button"
          onClick={handleOpenFile}
          onMouseEnter={() => setFileHovered(true)}
          onMouseLeave={() => setFileHovered(false)}
          title={filePath ? `${openFileTitle}\n${filePath}` : openFileTitle}
          className={`font-mono truncate min-w-0 max-w-full text-left transition-colors ${
            fileHovered
              ? 'text-blue-500 underline underline-offset-2'
              : 'text-blue-500/90 hover:text-blue-500'
          }`}
        >
          {fileName}
        </button>

        {/* Live git-style +N -M stats. Only render the counter chrome
            once at least one of the numbers is > 0 — keeps the row
            visually quiet before the agent commits to the edit. */}
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

        {tool.durationMs != null && tool.durationMs > 0 && (
          <span className="text-muted-foreground/50 text-[11px] tabular-nums shrink-0 font-mono">
            {formatDuration(tool.durationMs)}
          </span>
        )}

        <StatusDot status={status} />
      </div>

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

interface ToolActionRowProps {
  tool: ToolAction;
  streamingToolOutput?: string;
  agentProgressEvents?: AgentProgressEventWithMeta[];
}

function ToolActionRow({ tool, streamingToolOutput, agentProgressEvents }: ToolActionRowProps) {
  const { t } = useTranslation();
  const renderer = getRenderer(tool.name);
  const summary = renderer.getSummary(tool.input, tool.name);
  const filePath = getFilePath(tool.input);
  const status = getStatus(tool);
  const isDuyaCli = ['duya_cli', 'duya-cli', 'duyacli'].includes(tool.name.toLowerCase());
  const isBash = !isDuyaCli && renderer.icon === TerminalIcon;
  const lowerName = tool.name.toLowerCase();
  const isLegacySubAgent = isLegacySubAgentToolAction(tool);
  const isSubAgent = renderer.icon === RobotIcon || isLegacySubAgent;
  const isFileEdit = FILE_EDIT_TOOLS.has(lowerName) || FILE_CREATE_TOOLS.has(lowerName);
  const isRead = ['read', 'readfile', 'read_file'].includes(lowerName);
  const isAskUserQuestion = isAskUserQuestionTool(tool.name);
  const isMemory = lowerName === 'memory';
  const [expanded, setExpanded] = useState(false);

  if (isBash) {
    return <BashToolRow tool={tool} streamingToolOutput={streamingToolOutput} />;
  }

  if (isDuyaCli) {
    return <DuyaCliToolRow tool={tool} />;
  }

  if (isSubAgent) {
    return <SubAgentToolRow tool={tool} agentProgressEvents={agentProgressEvents} />;
  }

  if (isFileEdit) {
    return <FileEditToolRow tool={tool} />;
  }

  if (isRead) {
    return <ReadToolRow tool={tool} />;
  }

  if (isAskUserQuestion) {
    return <AskUserQuestionResultRow tool={tool} />;
  }

  if (isMemory) {
    return <MemoryToolRow tool={tool} />;
  }

  const hasResult = tool.result !== undefined && tool.result !== '';
  const isRunning = tool.result === undefined;

  // Build tool info for renderToolResult
  const toolInfo: ToolUseInfo = {
    id: tool.id || '',
    name: tool.name,
    input: tool.input,
  };

  const resultInfo: ToolResultInfo = {
    tool_use_id: tool.id || '',
    content: tool.result || '',
    is_error: tool.isError,
  };

  const renderedResult = hasResult ? renderToolResult(toolInfo, resultInfo) : null;
  const canExpand = hasResult && renderedResult !== null;
  const [hovered, setHovered] = useState(false);

  // Resolve the verb label (e.g. "已编辑" / "Edited") through i18n.
  // The registry stores a key rather than a string because hooks can't
  // run at module top level, so the translation is resolved here at
  // render time. Falls back to the key string when the entry is null
  // (e.g. shell/bash that show the command itself as the label).
  const label = renderer.labelKey ? t(renderer.labelKey) : null;

  return (
    <div>
      <button
        type="button"
        onClick={() => canExpand && setExpanded(prev => !prev)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={`flex w-full items-center gap-2 px-2 py-1 min-h-[28px] text-xs hover:bg-muted/30 rounded-sm transition-colors ${canExpand ? 'cursor-pointer' : 'cursor-default'}`}
      >
        {canExpand && (
          <CaretRightIcon
            size={10}
            className={`shrink-0 text-muted-foreground/60 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          />
        )}

        {createElement(renderer.icon, { size: 14, className: 'shrink-0 text-muted-foreground' })}

        {label && (
          <span className="font-medium text-muted-foreground shrink-0">{label}</span>
        )}

        <span
          className={`font-mono truncate flex-1 text-left transition-colors ${
            hovered ? 'text-foreground' : 'text-muted-foreground/60'
          }`}
        >
          {summary}
        </span>

        {filePath && (
          <span className="text-muted-foreground/40 text-[11px] font-mono truncate max-w-[200px] hidden sm:inline">
            {truncatePath(filePath)}
          </span>
        )}

        {tool.durationMs != null && tool.durationMs > 0 && (
          <span className="text-muted-foreground/50 text-[11px] tabular-nums shrink-0 font-mono">
            {formatDuration(tool.durationMs)}
          </span>
        )}

        <StatusDot status={status} />
      </button>

      <AnimatePresence initial={false}>
        {expanded && canExpand && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div className="mx-1 my-1 rounded-lg tool-card p-3 relative">
              {renderedResult}

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

function getRunningDescription(tools: ToolAction[]): string {
  const running = tools.filter((t) => t.result === undefined);
  if (running.length === 0) return '';
  const last = running[running.length - 1];
  return getRenderer(last.name).getSummary(last.input, last.name);
}

function renderActionItem(
  action: ActionItem,
  index: number,
  isStreaming?: boolean,
  isLastTextAction?: boolean,
): React.ReactNode {
  const key = `${action.kind}-${index}`;
  switch (action.kind) {
    case 'thinking':
      return <ThinkingRow key={key} content={action.content} isStreaming={action.isStreaming ?? isStreaming} />;
    case 'text':
      // Only the last (still-growing) text block needs the typewriter
      // pacing. Older blocks have stable content; the typewriter's rAF
      // loop would be a no-op for them but we'd rather not even mount
      // the extra state.
      return <TextRow key={key} content={action.content} isStreaming={isLastTextAction} />;
    case 'tool':
      return <ToolActionRow key={key} tool={action.tool} streamingToolOutput={action.streamingToolOutput} />;
    case 'widget':
      return (
        <WidgetErrorBoundary key={key} widgetCode={action.content}>
          <WidgetRenderer
            widgetCode={action.content}
            isStreaming={false}
            sourceMessageId={action.sourceMessageId}
            sourceLabel={action.sourceLabel}
          />
        </WidgetErrorBoundary>
      );
    default:
      return null;
  }
}

// Find the index of the last text action so the renderer can pass the
// `isLastTextAction` flag to it. The last text block is the one that's
// still growing as SSE text deltas arrive — it's the only block that
// actually needs the typewriter pacing.
function findLastTextIndex(actions: ActionItem[]): number {
  for (let i = actions.length - 1; i >= 0; i--) {
    if (actions[i].kind === 'text') return i;
  }
  return -1;
}

// Renders the `flat` body — preserves action order but collapses
// consecutive browser / context tools into groups.
function renderFlatActions(
  actions: ActionItem[],
  segments: Segment[],
  _segmentKeys: Array<{ segment: Segment; keys: string[] }>,
  isStreaming: boolean | undefined,
  streamingToolOutput: string | undefined,
  agentProgressEvents: AgentProgressEventWithMeta[] | undefined,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let toolIdx = 0;
  let segIdx = 0;
  const lastTextIdx = findLastTextIndex(actions);
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    if (action.kind === 'tool') {
      if (segIdx >= segments.length) {
        out.push(renderActionItem(action, i, isStreaming, i === lastTextIdx));
      } else {
        const seg = segments[segIdx];
        if (seg.kind === 'single' && seg.tool === action.tool) {
          const isLastRunning = !seg.tool.result;
          out.push(
            <ToolActionRow
              key={`tool-${toolIdx}`}
              tool={seg.tool}
              streamingToolOutput={isLastRunning ? streamingToolOutput : undefined}
              agentProgressEvents={agentProgressEvents}
            />,
          );
          toolIdx++;
          segIdx++;
        } else {
          if (seg.kind === 'context') {
            out.push(<ContextGroup key={`group-${toolIdx}`} tools={seg.tools} />);
            toolIdx += seg.tools.length;
          } else if (seg.kind === 'browser') {
            out.push(<BrowserGroup key={`group-${toolIdx}`} tools={seg.tools} />);
            toolIdx += seg.tools.length;
          } else {
            // single fallback (shouldn't reach here)
            out.push(renderActionItem(action, i, isStreaming, i === lastTextIdx));
            toolIdx++;
          }
          segIdx++;
          // After rendering a group, the remaining tools in the group are
          // already shown inside it. Skip past the next (groupSize - 1)
          // tool actions in `actions` so they aren't re-rendered as
          // standalone rows. Non-tool actions encountered in between are
          // still rendered in their original position.
          const groupSize =
            seg.kind === 'context' || seg.kind === 'browser'
              ? seg.tools.length
              : 1;
          let toolsToSkip = groupSize - 1;
          while (toolsToSkip > 0 && i + 1 < actions.length) {
            i++;
            if (actions[i].kind === 'tool') {
              toolsToSkip--;
            } else {
              out.push(renderActionItem(actions[i], i, isStreaming, i === lastTextIdx));
            }
          }
        }
      }
    } else {
      out.push(renderActionItem(action, i, isStreaming, i === lastTextIdx));
    }
  }
  return out;
}

function computeSummaryFromActions(
  actions: ActionItem[],
  isStreaming: boolean,
  t: (key: import('@/i18n').TranslationKey, params?: Record<string, string | number>) => string,
): string[] {
  const toolActions = actions.filter((a): a is ActionItem & { kind: 'tool' } => a.kind === 'tool');
  const runningCount = toolActions.filter((a) => a.tool.result === undefined).length;
  const doneCount = toolActions.length - runningCount;
  const summaryParts: string[] = [];
  if (runningCount > 0) summaryParts.push(t('streaming.actions.running', { count: runningCount }));
  if (doneCount > 0) summaryParts.push(t('streaming.actions.completed', { count: doneCount }));
  if (runningCount === 0 && isStreaming) summaryParts.push(t('streaming.actions.generating'));
  if (summaryParts.length === 0) summaryParts.push(`${actions.length} actions`);
  return summaryParts;
}

function getLastRunningToolAction(actions: ActionItem[]): ToolAction | undefined {
  for (let i = actions.length - 1; i >= 0; i--) {
    const action = actions[i];
    if (action.kind === 'tool' && action.tool.result === undefined) {
      return action.tool;
    }
  }
  return undefined;
}

function formatDuration(ms: number): string {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds.toFixed(0)}s`;
  }
  return `${seconds.toFixed(1)}s`;
}

const LiveDurationText = React.memo(function LiveDurationText({
  startedAt,
}: {
  startedAt: number;
}) {
  const [durationMs, setDurationMs] = useState(() => Math.max(0, Date.now() - startedAt));

  React.useEffect(() => {
    const tick = () => setDurationMs(Math.max(0, Date.now() - startedAt));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  return <>{formatDuration(durationMs)}</>;
});

const DurationSummaryText = React.memo(function DurationSummaryText({
  totalDurationMs,
  liveStartedAt,
}: {
  totalDurationMs: number;
  liveStartedAt?: number | null;
}) {
  const { t } = useTranslation();

  if (liveStartedAt) {
    return (
      <>
        {', '}
        {t('streaming.actions.workedFor', { duration: '' }).trimEnd()}
        {' '}
        <LiveDurationText startedAt={liveStartedAt} />
      </>
    );
  }

  if (totalDurationMs <= 0) return null;
  return <>{`, ${t('streaming.actions.workedFor', { duration: formatDuration(totalDurationMs) })}`}</>;
});

export function ToolActionsGroup({
  tools,
  actions: actionsProp,
  isStreaming = false,
  streamingToolOutput,
  flat = false,
  thinkingContent,
  agentProgressEvents,
  totalDurationMs: totalDurationMsProp,
  liveStartedAt,
}: ToolActionsGroupProps) {
  const { t } = useTranslation();
  // Build actions array from either new `actions` prop or legacy `tools` + `thinkingContent`
  const actions: ActionItem[] = React.useMemo(() => {
    if (actionsProp) return actionsProp;
    const result: ActionItem[] = [];
    if (thinkingContent) {
      result.push({ kind: 'thinking', content: thinkingContent, isStreaming });
    }
    for (const tool of (tools || [])) {
      result.push({ kind: 'tool', tool });
    }
    return result;
  }, [actionsProp, tools, thinkingContent, isStreaming]);

  const hasRunningTool = actions.some(
    (a) => a.kind === 'tool' && a.tool.result === undefined
  );
  const [userExpandedState, setUserExpandedState] = useState<boolean | null>(null);
  const expanded = userExpandedState !== null ? userExpandedState : (hasRunningTool || isStreaming);

  if (actions.length === 0) return null;

  const lastRunningTool = getLastRunningToolAction(actions);

  // Pre-group consecutive browser/context tools so the renderer can show
  // a single toggle per group instead of one toggle per action.
  const toolActions = React.useMemo(
    () => actions.filter((a): a is Extract<ActionItem, { kind: 'tool' }> => a.kind === 'tool'),
    [actions],
  );
  const segments = React.useMemo(
    () => computeSegments(toolActions.map((a) => a.tool)),
    [toolActions],
  );
  // Map each segment back to the matching action indices (for keys).
  const segmentActionKeys = React.useMemo(() => {
    const out: Array<{ segment: Segment; keys: string[] }> = [];
    let toolIdx = 0;
    for (const seg of segments) {
      const count = seg.kind === 'single' ? 1 : seg.tools.length;
      const keys: string[] = [];
      for (let k = 0; k < count; k++) {
        keys.push(`tool-${toolIdx}`);
        toolIdx++;
      }
      out.push({ segment: seg, keys });
    }
    return out;
  }, [segments]);

  const renderSegment = (seg: Segment, keys: string[]) => {
    if (seg.kind === 'single') {
      const isLastRunning = lastRunningTool?.id === seg.tool.id;
      return (
        <ToolActionRow
          key={keys[0]}
          tool={seg.tool}
          streamingToolOutput={isLastRunning ? streamingToolOutput : undefined}
          agentProgressEvents={agentProgressEvents}
        />
      );
    }
    if (seg.kind === 'context') {
      return <ContextGroup key={keys.join('-')} tools={seg.tools} />;
    }
    // browser
    return <BrowserGroup key={keys.join('-')} tools={seg.tools} />;
  };

  // For the indented body, we want to preserve the original action order
  // (thinking → tool → text → widget …). Walk `actions` and emit either
  // a grouped render unit (context/browser) or the original action item.
  const renderOrderedBody = () => {
    const out: React.ReactNode[] = [];
    let toolIdx = 0;
    let segIdx = 0;
    const lastTextIdx = findLastTextIndex(actions);
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      if (action.kind === 'tool') {
        if (segIdx >= segments.length) {
          out.push(renderActionItem(action, i, isStreaming, i === lastTextIdx));
        } else {
          const seg = segments[segIdx];
          if (seg.kind === 'single' && seg.tool === action.tool) {
            out.push(renderSegment(seg, [`tool-${toolIdx}`]));
            toolIdx++;
            segIdx++;
          } else if (seg.kind === 'context' || seg.kind === 'browser') {
            // group segment
            out.push(
              renderSegment(
                seg,
                seg.tools.map((_t, k) => `tool-${toolIdx + k}`),
              ),
            );
            toolIdx += seg.tools.length;
            segIdx++;
            // After rendering a group, the remaining tools in the group are
            // already shown inside it. Skip past the next (groupSize - 1)
            // tool actions in `actions` so they aren't re-rendered as
            // standalone rows. Non-tool actions encountered in between are
            // still rendered in their original position.
            let toolsToSkip = seg.tools.length - 1;
            while (toolsToSkip > 0 && i + 1 < actions.length) {
              i++;
              if (actions[i].kind === 'tool') {
                toolsToSkip--;
              } else {
                out.push(renderActionItem(actions[i], i, isStreaming, i === lastTextIdx));
              }
            }
          } else {
            // defensive — render as a single
            out.push(renderSegment(seg, [`tool-${toolIdx}`]));
            toolIdx++;
            segIdx++;
          }
        }
      } else {
        out.push(renderActionItem(action, i, isStreaming, i === lastTextIdx));
      }
    }
    return out;
  };

  if (flat) {
    return (
      <div className="w-[min(100%,48rem)]">
        <div className="border-l-2 border-border/50 pl-2 ml-1.5">
          {/* For flat mode, interleave non-tool actions with the grouped
              tool segments so the visual order is preserved. */}
          {renderFlatActions(actions, segments, segmentActionKeys, isStreaming, streamingToolOutput, agentProgressEvents)}
        </div>
      </div>
    );
  }

  const summaryParts = computeSummaryFromActions(actions, isStreaming, t);
  const runningDesc = lastRunningTool
    ? getRenderer(lastRunningTool.name).getSummary(lastRunningTool.input, lastRunningTool.name)
    : '';

  const totalDurationMs = React.useMemo(() => {
    // Prefer the explicit total duration (full response time) when provided.
    if (totalDurationMsProp != null && totalDurationMsProp > 0) {
      return totalDurationMsProp;
    }
    // Fall back to the sum of individual tool durations.
    let total = 0;
    for (const action of actions) {
      if (action.kind === 'tool' && action.tool.durationMs != null && action.tool.durationMs > 0) {
        total += action.tool.durationMs;
      }
    }
    return total;
  }, [actions, totalDurationMsProp]);

  const handleToggle = () => {
    setUserExpandedState((prev) => prev !== null ? !prev : !expanded);
  };

  return (
    <div className="w-[min(100%,48rem)]">
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center gap-2 py-1 text-xs rounded-sm hover:bg-muted/30 transition-colors"
      >
        <span className="text-muted-foreground/60 truncate">
          {summaryParts.join(' · ')}
          <DurationSummaryText
            totalDurationMs={totalDurationMs}
            liveStartedAt={isStreaming ? liveStartedAt : null}
          />
        </span>

        {runningDesc && (
          <span className="text-muted-foreground/40 text-[11px] font-mono truncate max-w-[40%]">
            {hasRunningTool ? <Shimmer duration={1.5}>{runningDesc}</Shimmer> : runningDesc}
          </span>
        )}

        <CaretRightIcon
          size={12}
          className={`shrink-0 text-muted-foreground/60 transition-transform duration-200 ml-auto ${expanded ? 'rotate-90' : ''}`}
        />
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            style={{ overflow: 'hidden', transformOrigin: 'top' }}
          >
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.12, ease: 'easeOut' }}
            >
              <div className="ml-1.5 mt-0.5 border-l-2 border-border/50 pl-2">
                {renderOrderedBody()}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function pairTools(
  toolUses: ToolUseInfo[],
  toolResults: ToolResultInfo[]
): ToolAction[] {
  const resultMap = new Map<string, ToolResultInfo>();
  for (const r of toolResults) {
    resultMap.set(r.tool_use_id, r);
  }

  const paired: ToolAction[] = [];

  for (const t of toolUses) {
    const result = resultMap.get(t.id);
    paired.push({
      id: t.id,
      name: t.name,
      input: t.input,
      result: result?.content,
      isError: result?.is_error,
      durationMs: result?.duration_ms,
    });
  }

  for (const r of toolResults) {
    if (!toolUses.some((u) => u.id === r.tool_use_id)) {
      paired.push({
        id: r.tool_use_id,
        name: 'tool_result',
        input: {},
        result: r.content,
        isError: r.is_error,
        durationMs: r.duration_ms,
      });
    }
  }

  return paired;
}
