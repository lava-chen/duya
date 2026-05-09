'use client';

import React, { useState, createElement } from 'react';
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
  | { kind: 'widget'; content: string };

interface ToolActionsGroupProps {
  tools?: ToolAction[];
  actions?: ActionItem[];
  isStreaming?: boolean;
  streamingToolOutput?: string;
  flat?: boolean;
  thinkingContent?: string;
  agentProgressEvents?: AgentProgressEventWithMeta[];
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
    match: (n) => ['bash', 'execute', 'run', 'shell', 'execute_command', 'run_command'].includes(n.toLowerCase()),
    icon: TerminalIcon,
    label: '',
    getSummary: (input) => {
      const rawCmd = (input as Record<string, unknown>)?.command || (input as Record<string, unknown>)?.cmd || '';
      const cmd = typeof rawCmd === 'string' ? rawCmd : JSON.stringify(rawCmd);
      return cmd ? (cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd) : 'bash';
    },
  },
  {
    match: (n) => ['write', 'edit', 'writefile', 'write_file', 'create_file', 'createfile', 'str_replace_editor'].includes(n.toLowerCase()),
    icon: NotePencilIcon,
    label: 'Edit',
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
  const rawCmd = (tool.input as Record<string, unknown>)?.command || '';
  const cmd = typeof rawCmd === 'string' ? rawCmd : JSON.stringify(rawCmd);
  const isRunning = tool.result === undefined;
  const outputText = isRunning ? streamingToolOutput : tool.result;
  const hasOutput = !!outputText && outputText.trim().length > 0;
  const status = getStatus(tool);
  const lineCount = outputText ? outputText.split('\n').length : 0;

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
        className="flex w-full items-center gap-2 px-2 py-1 min-h-[28px] text-xs hover:bg-muted/30 rounded-sm transition-colors"
      >
        <TerminalIcon size={14} className="shrink-0 text-muted-foreground" />
        <span className="font-mono text-muted-foreground/60 truncate flex-1 text-left">
          {cmd}
        </span>
        {!isRunning && hasOutput && (
          <span className="text-[10px] text-muted-foreground/40 tabular-nums">
            {lineCount} lines
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
            <div className="ml-6 mt-1 rounded bg-muted/40 px-2 py-1.5 font-mono text-[11px] text-muted-foreground/80 max-h-[300px] overflow-auto whitespace-pre-wrap break-all">
              {displayLines ? (
                <div className={isRunning ? 'text-muted-foreground/50' : 'text-muted-foreground/60'}>
                  {displayLines}
                </div>
              ) : (
                <span className="text-muted-foreground/30 italic">No output</span>
              )}
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
        className="flex w-full items-center gap-2 px-2 py-1 min-h-[28px] text-xs hover:bg-muted/30 rounded-sm transition-colors"
      >
        <CaretRightIcon
          size={10}
          className={`shrink-0 text-muted-foreground/60 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
        />
        <RobotIcon size={14} className="shrink-0 text-muted-foreground" />
        <span className="font-medium text-muted-foreground shrink-0">Agent</span>
        <span className="font-mono text-muted-foreground/60 truncate flex-1 text-left">
          {summary}
        </span>
        {toolUseCount > 0 && (
          <span className="text-muted-foreground/60 text-[10px]">({toolUseCount} tools)</span>
        )}
        {unresolvedTools > 0 && (
          <span className="text-amber-500 text-[10px]">{unresolvedTools} pending</span>
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
        className={`flex w-full items-center gap-2 px-2 py-1 min-h-[28px] text-xs hover:bg-muted/30 rounded-sm transition-colors ${hasResult ? 'cursor-pointer' : 'cursor-default'}`}
      >
        {hasResult && (
          <CaretRightIcon
            size={10}
            className={`shrink-0 text-muted-foreground/60 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          />
        )}

        <FileIcon size={14} className="shrink-0 text-muted-foreground" />

        <span className="font-mono text-muted-foreground/60 truncate flex-1 text-left">
          {fileName}
        </span>

        {/* Line range info - replaces duplicate file path */}
        {lineRange && (
          <span className="text-[11px] text-muted-foreground/50 tabular-nums shrink-0">
            Lines {lineRange.start}-{lineRange.end}
          </span>
        )}

        {tool.durationMs != null && tool.durationMs > 0 && (
          <span className="text-muted-foreground/50 text-[11px] tabular-nums shrink-0">
            {tool.durationMs < 1000
              ? `${tool.durationMs}ms`
              : `${(tool.durationMs / 1000).toFixed(1)}s`}
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
            <div className="ml-4 mt-1 border-l-2 border-border/30 pl-3 py-2">
              {renderedResult}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Edit tool row with +n -m stats
 */
function EditToolRow({ tool }: { tool: ToolAction }) {
  const [expanded, setExpanded] = useState(false);
  const filePath = getFilePath(tool.input);
  const fileName = filePath.split(/[/\\]/).pop() || filePath;
  const status = getStatus(tool);
  const hasResult = tool.result !== undefined && tool.result !== '';

  // Calculate diff stats
  const diffData = hasResult ? parseEditResult(tool.result!) : null;
  const stats = diffData ? calculateDiff(diffData.oldContent, diffData.newContent).stats : { additions: 0, removals: 0 };

  return (
    <div>
      <button
        type="button"
        onClick={() => hasResult && setExpanded(prev => !prev)}
        className={`flex w-full items-center gap-2 px-2 py-1 min-h-[28px] text-xs hover:bg-muted/30 rounded-sm transition-colors ${hasResult ? 'cursor-pointer' : 'cursor-default'}`}
      >
        {hasResult && (
          <CaretRightIcon
            size={10}
            className={`shrink-0 text-muted-foreground/60 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          />
        )}

        <NotePencilIcon size={14} className="shrink-0 text-muted-foreground" />
        <span className="font-medium text-muted-foreground shrink-0">Edit</span>

        <span className="font-mono text-muted-foreground/60 truncate flex-1 text-left">
          {fileName}
        </span>

        {/* Diff stats */}
        {hasResult && (
          <div className="flex items-center gap-1.5 shrink-0 text-[11px] font-mono">
            {stats.additions > 0 && (
              <span className="text-green-500 font-medium">+{stats.additions}</span>
            )}
            {stats.removals > 0 && (
              <span className="text-red-500 font-medium">-{stats.removals}</span>
            )}
          </div>
        )}

        {tool.durationMs != null && tool.durationMs > 0 && (
          <span className="text-muted-foreground/50 text-[11px] tabular-nums shrink-0">
            {tool.durationMs < 1000
              ? `${tool.durationMs}ms`
              : `${(tool.durationMs / 1000).toFixed(1)}s`}
          </span>
        )}

        <StatusDot status={status} />
      </button>

      <AnimatePresence initial={false}>
        {expanded && hasResult && diffData && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div className="ml-4 mt-1 border-l-2 border-border/30 pl-3 py-2">
              <SimpleDiffViewer
                oldContent={diffData.oldContent}
                newContent={diffData.newContent}
                maxHeight={400}
              />
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
  const isBash = renderer.icon === TerminalIcon;
  const isSubAgent = renderer.icon === RobotIcon;
  const isEdit = ['edit', 'edit_file', 'str_replace_editor'].includes(tool.name.toLowerCase());
  const isRead = ['read', 'readfile', 'read_file'].includes(tool.name.toLowerCase());
  const [expanded, setExpanded] = useState(false);

  if (isBash) {
    return <BashToolRow tool={tool} streamingToolOutput={streamingToolOutput} />;
  }

  if (isSubAgent) {
    return <SubAgentToolRow tool={tool} agentProgressEvents={agentProgressEvents} />;
  }

  if (isEdit) {
    return <EditToolRow tool={tool} />;
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

  return (
    <div>
      <button
        type="button"
        onClick={() => canExpand && setExpanded(prev => !prev)}
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

        <span className="font-mono text-muted-foreground/60 truncate flex-1 text-left">
          {summary}
        </span>

        {filePath && (
          <span className="text-muted-foreground/40 text-[11px] font-mono truncate max-w-[200px] hidden sm:inline">
            {truncatePath(filePath)}
          </span>
        )}

        {tool.durationMs != null && tool.durationMs > 0 && (
          <span className="text-muted-foreground/50 text-[11px] tabular-nums shrink-0">
            {tool.durationMs < 1000
              ? `${tool.durationMs}ms`
              : `${(tool.durationMs / 1000).toFixed(1)}s`}
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
            <div className="ml-4 mt-1 border-l-2 border-border/30 pl-3 py-2">
              {renderedResult}
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
    default:
      return null;
  }
}

function computeSummaryFromActions(actions: ActionItem[], isStreaming?: boolean): string[] {
  const toolActions = actions.filter((a): a is ActionItem & { kind: 'tool' } => a.kind === 'tool');
  const runningCount = toolActions.filter((a) => a.tool.result === undefined).length;
  const doneCount = toolActions.length - runningCount;
  const summaryParts: string[] = [];
  if (runningCount > 0) summaryParts.push(`${runningCount} running`);
  if (doneCount > 0) summaryParts.push(`${doneCount} completed`);
  if (runningCount === 0 && isStreaming) summaryParts.push('generating response');
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

export function ToolActionsGroup({
  tools,
  actions: actionsProp,
  isStreaming = false,
  streamingToolOutput,
  flat = false,
  thinkingContent,
  agentProgressEvents,
}: ToolActionsGroupProps) {
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

  const summaryParts = computeSummaryFromActions(actions, isStreaming);
  const lastRunningTool = getLastRunningToolAction(actions);
  const runningDesc = lastRunningTool
    ? getRenderer(lastRunningTool.name).getSummary(lastRunningTool.input, lastRunningTool.name)
    : '';

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
