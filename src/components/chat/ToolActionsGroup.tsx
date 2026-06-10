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
  label: string;
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
    label: '',
    getSummary: (input) => {
      const rawCmd = (input as Record<string, unknown>)?.command || (input as Record<string, unknown>)?.cmd || '';
      const cmd = typeof rawCmd === 'string' ? rawCmd : JSON.stringify(rawCmd);
      return cmd ? (cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd) : 'shell';
    },
  },
  {
    match: (n) => ['bash', 'execute', 'run', 'execute_command', 'run_command'].includes(n.toLowerCase()),
    icon: TerminalIcon,
    label: '',
    getSummary: (input) => {
      const rawCmd = (input as Record<string, unknown>)?.command || (input as Record<string, unknown>)?.cmd || '';
      const cmd = typeof rawCmd === 'string' ? rawCmd : JSON.stringify(rawCmd);
      return cmd ? (cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd) : 'bash';
    },
  },
  {
    match: (n) => n.toLowerCase() === 'duya_cli' || n.toLowerCase() === 'duya-cli' || n.toLowerCase() === 'duyacli',
    icon: TerminalIcon,
    label: 'CLI',
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
    label: 'Edit',
    getSummary: (input) => {
      const path = getFilePath(input);
      return path ? extractFilename(path) : 'file';
    },
  },
  {
    match: (n) => ['write', 'writefile', 'write_file', 'create_file', 'createfile'].includes(n.toLowerCase()),
    icon: NotePencilIcon,
    label: 'Create',
    getSummary: (input) => {
      const path = getFilePath(input);
      return path ? extractFilename(path) : 'file';
    },
  },
  {
    match: (n) => ['read', 'readfile', 'read_file', 'read_multiple_files'].includes(n.toLowerCase()),
    icon: FileIcon,
    label: 'Read',
    getSummary: (input) => {
      const path = getFilePath(input);
      return path ? extractFilename(path) : 'file';
    },
  },
  {
    match: (n) => ['search', 'glob', 'grep', 'find_files', 'search_files'].includes(n.toLowerCase()),
    icon: MagnifyingGlassIcon,
    label: 'Search',
    getSummary: (input) => {
      const inp = input as Record<string, unknown> | undefined;
      const rawPattern = inp?.pattern || inp?.query || inp?.glob || '';
      const pattern = typeof rawPattern === 'string' ? rawPattern : JSON.stringify(rawPattern);
      return pattern ? `"${pattern.length > 50 ? pattern.slice(0, 47) + '...' : pattern}"` : 'search';
    },
  },
  {
    match: (n) => ['agent', 'task', 'subagent', 'sub_agent'].includes(n.toLowerCase()),
    icon: RobotIcon,
    label: 'Agent',
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
    match: () => true,
    icon: WrenchIcon,
    label: '',
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
  | { kind: 'single'; tool: ToolAction };

function computeSegments(tools: ToolAction[]): Segment[] {
  const segments: Segment[] = [];
  let contextBuffer: ToolAction[] = [];

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

  for (const tool of tools) {
    if (isContextTool(tool.name)) {
      contextBuffer.push(tool);
    } else {
      flushContext();
      segments.push({ kind: 'single', tool });
    }
  }
  flushContext();
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

function TextRow({ content }: { content: string }) {
  const hasWidgetFence = content.includes('```show-widget');

  if (!hasWidgetFence) {
    return (
      <MarkdownRenderer className="px-2 py-1.5 text-sm text-foreground/90 prose prose-sm dark:prose-invert max-w-none message-content">
        {content}
      </MarkdownRenderer>
    );
  }

  const segments = parseAllShowWidgets(content);
  const hasWidgets = segments.some(s => s.type === 'widget');

  if (!hasWidgets) {
    return (
      <MarkdownRenderer className="px-2 py-1.5 text-sm text-foreground/90 prose prose-sm dark:prose-invert max-w-none message-content">
        {content}
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
            <div className="mx-1 my-1 rounded-lg bg-[#2d2d2d] p-3 relative">
              {/* Shell label */}
              <div className="text-[11px] text-neutral-400 font-medium mb-1.5">{shellLabel}</div>

              {/* Command with copy button */}
              <div className="group relative font-mono text-[13px] text-neutral-200 leading-relaxed pr-7">
                <span className="text-neutral-400 mr-1.5 select-none">$</span>
                <span className="break-all">{cmd}</span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleCopy(); }}
                  className="absolute right-0 top-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded text-neutral-500 hover:text-neutral-300 hover:bg-white/5"
                  title="Copy command"
                >
                  {copied ? <CheckCircleIcon size={14} className="text-green-500" /> : <CopyIcon size={14} />}
                </button>
              </div>

              {/* Output */}
              {displayLines ? (
                <div className="font-mono text-[12px] text-neutral-400 whitespace-pre-wrap break-all max-h-[150px] overflow-auto leading-relaxed mt-1.5">
                  {displayLines}
                </div>
              ) : (
                <div className="text-[12px] text-neutral-500 italic mt-1.5">No output</div>
              )}

              {/* Status badge - bottom right */}
              <div className="mt-1.5 flex justify-end">
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
            <div className="mx-1 my-1 rounded-lg bg-[#2d2d2d] p-3 relative">
              <div className="font-mono text-[13px] text-neutral-200 leading-relaxed">
                <span className="break-all">{cmd}</span>
              </div>

              {hasStdout && (
                <>
                  <div className="border-t border-white/10 mt-2 mb-1.5" />
                  <div className="font-mono text-[12px] text-neutral-300 whitespace-pre-wrap break-all max-h-[150px] overflow-auto leading-relaxed">
                    {stdout}
                  </div>
                </>
              )}

              {!hasStdout && !isRunning && (
                <div className="text-[12px] text-neutral-500 italic mt-2">No output</div>
              )}

              <div className="mt-1.5 flex justify-end">
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
  const status = getStatus(tool);
  const isRunning = tool.result === undefined;

  // Filter events for this sub-agent
  const subAgentEvents = agentProgressEvents || [];
  const toolUseCount = subAgentEvents.filter((e) => e.type === 'tool_use').length;
  const toolResultCount = subAgentEvents.filter((e) => e.type === 'tool_result').length;
  const unresolvedTools = Math.max(0, toolUseCount - toolResultCount);

  // Build progress steps from events
  const steps = React.useMemo(() => {
    const result: Array<{ type: string; title: string; status: 'running' | 'done' | 'error' }> = [];
    for (const event of subAgentEvents) {
      if (event.type === 'thinking') {
        result.push({ type: 'thinking', title: 'Thinking', status: 'done' });
      } else if (event.type === 'tool_use') {
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
    return result;
  }, [subAgentEvents]);

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
        <span className="font-medium text-muted-foreground shrink-0">Agent</span>
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
                  {isRunning ? 'Initializing...' : 'No progress data'}
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
              {tool.result && (
                <div className="mt-2 text-[11px] text-muted-foreground/70 whitespace-pre-wrap">
                  {tool.result}
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
            <div className="mx-1 my-1 rounded-lg bg-[#2d2d2d] p-3 relative">
              {renderedResult}

              {/* Status badge - bottom right */}
              <div className="mt-1.5 flex justify-end">
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
            <div className="mx-1 my-1 rounded-lg bg-[#2d2d2d] p-3 relative">
              <SimpleDiffViewer
                oldContent={diffPayload.oldContent}
                newContent={diffPayload.newContent}
                maxHeight={400}
              />

              {/* Status badge - bottom right */}
              <div className="mt-1.5 flex justify-end">
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
  const renderer = getRenderer(tool.name);
  const summary = renderer.getSummary(tool.input, tool.name);
  const filePath = getFilePath(tool.input);
  const status = getStatus(tool);
  const isDuyaCli = ['duya_cli', 'duya-cli', 'duyacli'].includes(tool.name.toLowerCase());
  const isBash = !isDuyaCli && renderer.icon === TerminalIcon;
  const isSubAgent = renderer.icon === RobotIcon;
  const lowerName = tool.name.toLowerCase();
  const isFileEdit = FILE_EDIT_TOOLS.has(lowerName) || FILE_CREATE_TOOLS.has(lowerName);
  const isRead = ['read', 'readfile', 'read_file'].includes(lowerName);
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

        {renderer.label && (
          <span className="font-medium text-muted-foreground shrink-0">{renderer.label}</span>
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
            <div className="mx-1 my-1 rounded-lg bg-[#2d2d2d] p-3 relative">
              {renderedResult}

              {/* Status badge - bottom right */}
              <div className="mt-1.5 flex justify-end">
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
  isStreaming?: boolean
): React.ReactNode {
  const key = `${action.kind}-${index}`;
  switch (action.kind) {
    case 'thinking':
      return <ThinkingRow key={key} content={action.content} isStreaming={action.isStreaming ?? isStreaming} />;
    case 'text':
      return <TextRow key={key} content={action.content} />;
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

  if (flat) {
    const lastRunningTool = getLastRunningToolAction(actions);
    return (
      <div className="w-[min(100%,48rem)]">
        <div className="border-l-2 border-border/50 pl-2 ml-1.5">
          {actions.map((action, i) => {
            if (action.kind === 'tool') {
              const isLastRunning = lastRunningTool?.id === action.tool.id;
              return (
                <ToolActionRow
                  key={`tool-${i}`}
                  tool={action.tool}
                  streamingToolOutput={isLastRunning ? streamingToolOutput : undefined}
                  agentProgressEvents={agentProgressEvents}
                />
              );
            }
            return renderActionItem(action, i, isStreaming);
          })}
        </div>
      </div>
    );
  }

  const summaryParts = computeSummaryFromActions(actions, isStreaming, t);
  const lastRunningTool = getLastRunningToolAction(actions);
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
                {actions.map((action, i) => {
                  if (action.kind === 'tool') {
                    const isLastRunning = lastRunningTool?.id === action.tool.id;
                    return (
                      <ToolActionRow
                        key={`tool-${i}`}
                        tool={action.tool}
                        streamingToolOutput={isLastRunning ? streamingToolOutput : undefined}
                        agentProgressEvents={agentProgressEvents}
                      />
                    );
                  }
                  return renderActionItem(action, i, isStreaming);
                })}
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
