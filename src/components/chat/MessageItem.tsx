'use client';

import React, { useState, useMemo } from 'react';
import type { Message, ToolUseInfo, ToolResultInfo } from '@/types';
import { ToolActionsGroup, pairTools, type ActionItem, type ToolAction } from './ToolActionsGroup';
import { MarkdownRenderer } from './MarkdownRenderer';
import {
  CopyIcon,
  CheckIcon,
  NotePencilIcon,
  ArrowCounterClockwiseIcon,
  FileTextIcon,
  ExternalLinkIcon,
  CaretDownIcon,
} from '@/components/icons';
import { FileAttachmentCard } from './FileAttachmentCard';
import { AttachmentBar } from './AttachmentBar';
import { AttachmentPreviewModal } from './AttachmentPreviewModal';
import { parseMessageContentWithPasted, type PastedContentInfo } from '@/lib/message-content-parser';
import { decodeMessageAttachments } from '@/lib/decode-message-attachments';
import { parseAllShowWidgets } from '@/lib/widget-parser';
import { WidgetRenderer } from './WidgetRenderer';
import { WidgetErrorBoundary } from './WidgetErrorBoundary';
import { CompactBoundary } from './CompactBoundary';
import { CompactSummary } from './CompactSummary';
import { useConversationStore } from '@/stores/conversation-store';
import type { FileAttachment } from '@/types/message';
import { useTranslation } from '@/hooks/useTranslation';
import { calculateDiff } from '@/components/diff/SimpleDiffViewer';
import {
  fileKindLabel,
  fileNameFromPath,
  isDeliverableFile,
  openLocalArtifactTarget,
  openLocalFileTarget,
} from '@/lib/chat-file-links';
import {
  browserReferenceDisplaySummary,
  parseBrowserReferenceDisplayContent,
  type BrowserReferenceDisplayData,
} from '@/lib/browser-reference-display';

function formatMessageTime(timestamp: number, t: (key: import('@/i18n').TranslationKey, params?: Record<string, string | number>) => string, locale: 'en' | 'zh' = 'en'): string {
  const date = new Date(timestamp);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const oneWeekAgo = new Date(today);
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

  // Locale-aware time formatting: zh uses 24-hour with 上午/下午, en uses 12-hour AM/PM.
  const timeStr = date.toLocaleTimeString(locale === 'zh' ? 'zh-CN' : 'en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: locale !== 'zh',
  });

  if (date >= today) {
    return timeStr;
  } else if (date >= yesterday) {
    return t('time.formatWithYesterday', { label: t('time.yesterday'), time: timeStr });
  } else if (date >= oneWeekAgo) {
    const weekdayIndex = date.getDay();
    const weekdayKey = [
      'time.weekdaySunday',
      'time.weekdayMonday',
      'time.weekdayTuesday',
      'time.weekdayWednesday',
      'time.weekdayThursday',
      'time.weekdayFriday',
      'time.weekdaySaturday',
    ][weekdayIndex] as import('@/i18n').TranslationKey;
    return t('time.formatWithYesterday', { label: t(weekdayKey), time: timeStr });
  } else {
    const dateStr = date.toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    });
    return t('time.formatWithDate', { date: dateStr, time: timeStr });
  }
}

interface MessageItemProps {
  message: Message;
  toolResults?: ToolResultInfo[];
  onToolResult?: (toolUseId: string, approved: boolean) => void;
  // Messages merged from the same round (thinking + tool_use + text)
  mergedMessages?: Message[];
  onRewindToMessage?: (messageId: string) => void;
}

function parseMessageContent(content: string | unknown[], msgType?: string): {
  text: string;
  toolUses: ToolUseInfo[];
  thinkingContent?: string;
} {
  const toolUses: ToolUseInfo[] = [];
  let text = '';
  let thinkingContent: string | undefined;

  if (msgType === 'thinking') {
    return { text: '', toolUses, thinkingContent: typeof content === 'string' ? content : JSON.stringify(content) };
  }

  if (msgType === 'tool_use') {
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>;
          if (b.type === 'tool_use') {
            toolUses.push({
              id: b.id as string,
              name: b.name as string,
              input: b.input as Record<string, unknown> || {},
            });
          }
        }
      }
    } else {
      // Backward compat: string content for tool_use (unlikely after parsing)
      toolUses.push({ id: '', name: '', input: {} });
    }
    return { text, toolUses, thinkingContent };
  }

  if (Array.isArray(content)) {
    const textParts: string[] = [];

    content.forEach(block => {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && b.text) {
          textParts.push(b.text as string);
        } else if (b.type === 'tool_use') {
          toolUses.push({
            id: b.id as string,
            name: b.name as string,
            input: b.input as Record<string, unknown> || {},
          });
        } else if (b.type === 'thinking' && b.thinking) {
          const rawThinking = b.thinking;
          thinkingContent = typeof rawThinking === 'string' ? rawThinking : JSON.stringify(rawThinking);
        }
      }
    });

    text = textParts.join('');
    return { text, toolUses, thinkingContent };
  }

  if (typeof content === 'string') {
    text = content;
    return { text, toolUses };
  }

  return { text, toolUses };
}

/**
 * Extract plain Markdown text from a message's content (string or Anthropic-style
 * content blocks). For arrays, joins all `text` blocks — used for clipboard copy
 * so we never leak raw block JSON to the user.
 */
function extractMarkdownFromBlocks(content: string | unknown[]): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    }
  }
  return parts.join('');
}

function AssistantContent({
  text,
  sourceMessageId,
}: {
  text: string;
  sourceMessageId?: string;
}) {
  const hasWidgetFence = text.includes('```show-widget');

  if (!hasWidgetFence) {
    return <MarkdownRenderer>{text}</MarkdownRenderer>;
  }

  const segments = parseAllShowWidgets(text);
  const hasWidgets = segments.some(s => s.type === 'widget');

  if (!hasWidgets) {
    return <MarkdownRenderer>{text}</MarkdownRenderer>;
  }

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === 'text') {
          return (
            <MarkdownRenderer key={`t-${i}`}>
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
                sourceMessageId={sourceMessageId}
                sourceLabel="Chat message"
              />
            </WidgetErrorBoundary>
          );
        }
        return null;
      })}
    </>
  );
}

function InterleavedContent({ actions, sourceMessageId }: { actions: ActionItem[]; sourceMessageId?: string }) {
  return (
    <>
      {actions.map((action, i) => {
        switch (action.kind) {
          case 'text':
            return (
              <MarkdownRenderer key={`t-${i}`}>
                {action.content}
              </MarkdownRenderer>
            );
          case 'widget':
            return (
              <WidgetErrorBoundary key={`w-${i}`} widgetCode={action.content}>
                <WidgetRenderer
                  widgetCode={action.content}
                  isStreaming={false}
                  sourceMessageId={action.sourceMessageId ?? sourceMessageId}
                  sourceLabel={action.sourceLabel ?? 'Chat message'}
                />
              </WidgetErrorBoundary>
            );
          case 'thinking':
            return null;
          case 'tool':
            return null;
          default:
            return null;
        }
      })}
    </>
  );
}

interface FileChangeSummary {
  path: string;
  name: string;
  additions: number;
  removals: number;
  kind: 'edit' | 'create';
}

interface ArtifactSummary {
  path: string;
  name: string;
  kindLabel: string;
}

function getToolInputPath(input: unknown): string {
  const inp = input as Record<string, unknown> | undefined;
  const rawPath = inp?.file_path || inp?.path || inp?.filePath || '';
  return typeof rawPath === 'string' ? rawPath : '';
}

function parseEditResultForSummary(result: string): { oldContent: string; newContent: string } | null {
  const changedMatch = result.match(/Changed:\n([\s\S]+?)\n\nTo:\n([\s\S]+)$/);
  if (changedMatch) {
    return {
      oldContent: changedMatch[1] || '',
      newContent: changedMatch[2] || '',
    };
  }

  try {
    const data = JSON.parse(result);
    if (typeof data?.content === 'string') {
      return {
        oldContent: typeof data.previous_content === 'string' ? data.previous_content : '',
        newContent: data.content,
      };
    }
    if (typeof data?.old_string === 'string' || typeof data?.new_string === 'string') {
      return {
        oldContent: typeof data.old_string === 'string' ? data.old_string : '',
        newContent: typeof data.new_string === 'string' ? data.new_string : '',
      };
    }
  } catch {
    return null;
  }

  return null;
}

function computeToolFileChange(tool: ToolAction): FileChangeSummary | null {
  const path = getToolInputPath(tool.input);
  if (!path || tool.isError) return null;

  const input = tool.input as Record<string, unknown> | undefined;
  const lowerName = tool.name.toLowerCase();
  const isCreate = ['write', 'writefile', 'write_file', 'create_file', 'createfile'].includes(lowerName);
  let additions = 0;
  let removals = 0;

  if (tool.result) {
    const parsed = parseEditResultForSummary(tool.result);
    if (parsed) {
      const stats = calculateDiff(parsed.oldContent, parsed.newContent).stats;
      additions = stats.additions;
      removals = stats.removals;
    }
  } else if (typeof input?.old_string === 'string' && typeof input?.new_string === 'string') {
    const stats = calculateDiff(input.old_string, input.new_string).stats;
    additions = stats.additions;
    removals = stats.removals;
  } else if (typeof input?.content === 'string') {
    additions = input.content.split('\n').filter(line => line !== '').length;
  }

  return {
    path,
    name: fileNameFromPath(path),
    additions,
    removals,
    kind: isCreate ? 'create' : 'edit',
  };
}

function buildFileChangeSummaries(tools: ToolAction[]): FileChangeSummary[] {
  const summaries = new Map<string, FileChangeSummary>();

  for (const tool of tools) {
    const lowerName = tool.name.toLowerCase();
    const isFileChangeTool = [
      'edit', 'edit_file', 'str_replace_editor',
      'write', 'writefile', 'write_file', 'create_file', 'createfile',
    ].includes(lowerName);
    if (!isFileChangeTool) continue;

    const change = computeToolFileChange(tool);
    if (!change) continue;

    const existing = summaries.get(change.path);
    if (existing) {
      existing.additions += change.additions;
      existing.removals += change.removals;
      if (existing.kind !== 'create') existing.kind = change.kind;
    } else {
      summaries.set(change.path, change);
    }
  }

  return Array.from(summaries.values());
}

function buildArtifactSummaries(changes: FileChangeSummary[]): ArtifactSummary[] {
  return changes
    .filter(change => change.kind === 'create' && isDeliverableFile(change.path))
    .map(change => ({
      path: change.path,
      name: change.name,
      kindLabel: fileKindLabel(change.path),
    }));
}

function ArtifactCard({ artifact, cwd }: { artifact: ArtifactSummary; cwd?: string | null }) {
  return (
    <button
      type="button"
      className="group flex w-full items-center gap-3 rounded-lg border border-border/70 bg-surface/70 px-4 py-3 text-left transition-colors hover:border-accent/40 hover:bg-surface-hover"
      onClick={() => openLocalArtifactTarget(artifact.path, cwd)}
      title={artifact.path}
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
        <FileTextIcon size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-foreground">{artifact.name}</span>
        <span className="block text-xs text-muted-foreground">{artifact.kindLabel}</span>
      </span>
      <ExternalLinkIcon size={16} className="shrink-0 text-muted-foreground/50 transition-colors group-hover:text-accent" />
    </button>
  );
}

function openBrowserReferenceInPanel(reference: BrowserReferenceDisplayData): void {
  window.dispatchEvent(new CustomEvent('duya:open-browser-panel', {
    detail: { url: reference.url },
  }));
}

function browserReferenceField(reference: BrowserReferenceDisplayData, field: string): string {
  const match = reference.content.match(new RegExp(`^- ${field}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim() ?? '';
}

function cleanBrowserReferenceLabel(label: string): string {
  return label
    .replace(/\.__duya_browser_pick_hover__/g, '')
    .replace(/\.__duya_[\w-]+__/g, '')
    .replace(/__duya_[\w-]+__/g, '')
    .replace(/\.+$/g, '')
    .trim();
}

function truncateBrowserReferenceText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function BrowserReferenceCard({ reference }: { reference: BrowserReferenceDisplayData }) {
  const selectedText = browserReferenceField(reference, 'Text');
  const selector = browserReferenceField(reference, 'Selector');
  const label = cleanBrowserReferenceLabel(reference.label);
  const pageTitle = reference.title || reference.url;
  const headline = reference.kind === 'screenshot'
    ? 'Browser screenshot'
    : (selectedText ? truncateBrowserReferenceText(selectedText, 56) : 'Selected UI element');
  const meta = reference.kind === 'screenshot'
    ? pageTitle
    : [pageTitle, label].filter(Boolean).join(' · ');

  return (
    <button
      type="button"
      className="browser-reference-card"
      onClick={() => openBrowserReferenceInPanel(reference)}
      title={reference.url}
    >
      <span className="browser-reference-card-mark" aria-hidden="true">
        {reference.kind === 'screenshot' ? 'IMG' : 'UI'}
      </span>
      <span className="browser-reference-card-body">
        <span className="browser-reference-card-kicker">
          {reference.kind === 'screenshot' ? 'Screenshot reference' : 'UI element reference'}
        </span>
        <span className="browser-reference-card-title">
          {headline}
        </span>
        <span className="browser-reference-card-meta">
          {meta}
        </span>
        {reference.kind === 'element' && selector && (
          <span className="browser-reference-card-selector">{selector}</span>
        )}
      </span>
      <span className="browser-reference-card-open" aria-hidden="true">
        <ExternalLinkIcon size={14} />
      </span>
    </button>
  );
}

function EditSummaryCard({ changes, cwd }: { changes: FileChangeSummary[]; cwd?: string | null }) {
  const [open, setOpen] = useState(false);
  const { locale } = useTranslation();
  const reviewLabel = locale === 'zh' ? '审查' : 'Review';
  const editedLabel = locale === 'zh' ? `已编辑 ${changes.length} 个文件` : `Edited ${changes.length} file${changes.length > 1 ? 's' : ''}`;
  const visible = open ? changes : changes.slice(0, 3);
  const totals = changes.reduce(
    (acc, change) => ({
      additions: acc.additions + change.additions,
      removals: acc.removals + change.removals,
    }),
    { additions: 0, removals: 0 },
  );

  return (
    <div className="rounded-lg border border-border/70 bg-surface/70 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(prev => !prev)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-hover"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <NotePencilIcon size={20} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-foreground">
            {editedLabel}
          </span>
          <span className="flex items-center gap-2 text-xs font-mono">
            <span className="text-green-500">+{totals.additions}</span>
            <span className="text-red-500">-{totals.removals}</span>
          </span>
        </span>
        <span className="rounded-md border border-border/60 px-2.5 py-1 text-xs font-medium text-foreground">
          {reviewLabel}
        </span>
        <CaretDownIcon
          size={16}
          className={`shrink-0 text-muted-foreground/60 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      <div className="border-t border-border/60">
        {visible.map(change => (
          <button
            type="button"
            key={change.path}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors hover:bg-surface-hover"
            onClick={() => openLocalFileTarget(change.path, cwd)}
            title={change.path}
          >
            <span className="min-w-0 flex-1 truncate text-foreground">{change.path}</span>
            <span className="shrink-0 font-mono text-xs text-green-500">+{change.additions}</span>
            <span className="shrink-0 font-mono text-xs text-red-500">-{change.removals}</span>
          </button>
        ))}
        {!open && changes.length > visible.length && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex w-full items-center gap-1 px-4 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            {locale === 'zh'
              ? `再显示 ${changes.length - visible.length} 个文件`
              : `Show ${changes.length - visible.length} more file${changes.length - visible.length > 1 ? 's' : ''}`}
            <CaretDownIcon size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

function MessageSummaryCards({
  artifacts,
  changes,
  cwd,
}: {
  artifacts: ArtifactSummary[];
  changes: FileChangeSummary[];
  cwd?: string | null;
}) {
  const { locale } = useTranslation();
  if (artifacts.length === 0 && changes.length === 0) return null;

  return (
    <div className="mt-4 w-[min(100%,48rem)] space-y-3">
      {artifacts.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-semibold text-foreground">
            {locale === 'zh' ? '产物汇总' : 'Artifacts'}
          </div>
          <div className="space-y-2">
            {artifacts.map(artifact => (
              <ArtifactCard key={artifact.path} artifact={artifact} cwd={cwd} />
            ))}
          </div>
        </div>
      )}
      {/* Edited-files summary intentionally hidden for now. */}
    </div>
  );
}

function messageToActionItems(
  msg: Message,
  toolResultMap: Map<string, ToolResultInfo>
): ActionItem[] {
  const actions: ActionItem[] = [];

  if (msg.msgType === 'viz' && msg.vizSpec) {
    actions.push({ kind: 'widget', content: msg.vizSpec, sourceMessageId: msg.id, sourceLabel: 'Chat visualization' });
    return actions;
  }

  if (msg.msgType === 'thinking') {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    if (content.trim()) {
      actions.push({ kind: 'thinking', content });
    }
    return actions;
  }

  if (msg.msgType === 'tool_use' && msg.toolName) {
    const toolUseId = msg.tool_call_id || msg.id;
    const result = toolUseId ? toolResultMap.get(toolUseId) : undefined;
    actions.push({
      kind: 'tool',
      tool: {
        id: toolUseId,
        name: msg.toolName,
        input: msg.toolInput ? JSON.parse(msg.toolInput) : {},
        result: result?.content,
        isError: result?.is_error,
        durationMs: result?.duration_ms ?? msg.durationMs,
      },
    });
    return actions;
  }

  // Parse array content (Anthropic-style blocks)
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && b.text && String(b.text).trim()) {
        actions.push({ kind: 'text', content: String(b.text) });
      } else if (b.type === 'tool_use') {
        if (b.name === 'show_widget') {
          const widgetCode = (b.input as Record<string, unknown>)?.widget_code;
          if (typeof widgetCode === 'string' && widgetCode.trim()) {
            actions.push({ kind: 'widget', content: widgetCode, sourceMessageId: msg.id, sourceLabel: 'Chat visualization' });
          }
          continue;
        }
        const toolId = String(b.id || '');
        const result = toolId ? toolResultMap.get(toolId) : undefined;
        actions.push({
          kind: 'tool',
          tool: {
            id: toolId,
            name: String(b.name || ''),
            input: (b.input as Record<string, unknown>) || {},
            result: result?.content,
            isError: result?.is_error,
            durationMs: result?.duration_ms,
          },
        });
      } else if (b.type === 'thinking' && b.thinking) {
        const rawThinking = b.thinking;
        const thinkingStr = typeof rawThinking === 'string' ? rawThinking : JSON.stringify(rawThinking);
        if (thinkingStr.trim()) {
          actions.push({ kind: 'thinking', content: thinkingStr });
        }
      }
    }
    return actions;
  }

  // String content is plain text (JSON arrays already parsed in ipc-client)
  if (typeof msg.content === 'string') {
    const withPasted = parseMessageContentWithPasted(msg.content);
    if (withPasted.text.trim()) {
      actions.push({ kind: 'text', content: withPasted.text });
    }
    return actions;
  }

  return actions;
}

function sortMessagesByOrder(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => {
    if (a.seqIndex != null && b.seqIndex != null) {
      return a.seqIndex - b.seqIndex;
    }
    return a.timestamp - b.timestamp;
  });
}

function toolResultsEqual(a: ToolResultInfo[] = [], b: ToolResultInfo[] = []): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (
      left.tool_use_id !== right.tool_use_id
      || left.content !== right.content
      || left.is_error !== right.is_error
      || left.duration_ms !== right.duration_ms
      || JSON.stringify(left.metadata ?? null) !== JSON.stringify(right.metadata ?? null)
    ) {
      return false;
    }
  }
  return true;
}

function messagesEqual(a: Message[] = [], b: Message[] = []): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function messageItemPropsEqual(prev: MessageItemProps, next: MessageItemProps): boolean {
  return prev.message === next.message
    && toolResultsEqual(prev.toolResults, next.toolResults)
    && messagesEqual(prev.mergedMessages, next.mergedMessages)
    && prev.onToolResult === next.onToolResult
    && prev.onRewindToMessage === next.onRewindToMessage;
}

function MessageItemComponent({ message, toolResults = [], onToolResult, mergedMessages = [], onRewindToMessage }: MessageItemProps) {
  const [copied, setCopied] = useState(false);
  // Preview modal state
  const [previewAttachment, setPreviewAttachment] = useState<FileAttachment | null>(null);
  const [previewPastedContent, setPreviewPastedContent] = useState<{ id: string; content: string; preview: string } | null>(null);

  const { t, locale } = useTranslation();
  const activeThreadId = useConversationStore(s => s.activeThreadId);
  const threads = useConversationStore(s => s.threads);
  const workingDirectory = threads.find(thread => thread.id === activeThreadId)?.workingDirectory;

  // Build tool result map for quick lookup
  const toolResultMap = useMemo(() => {
    const map = new Map<string, ToolResultInfo>();
    for (const r of toolResults) {
      map.set(r.tool_use_id, r);
    }
    return map;
  }, [toolResults]);

  // Parse main message content (including pasted content markers).
// For user messages with displayContent, render the original prompt
// instead of the full assembled context (pre-analysis + attachment text).
//
// Plan 220 Phase 3: route through `decodeMessageAttachments` so legacy
// `<pasted-content>` and `[[duya-browser-ref:...]]` markers found in
// `content` are promoted to typed attachments and stripped from the
// returned text. New messages never hit this path because the write
// side no longer emits markers.
const { text: mainText, pastedContents, refAttachments } = useMemo(() => {
    const displaySource =
      message.role === 'user' &&
      message.displayContent !== undefined &&
      !(typeof message.displayContent === 'string' && message.displayContent.length === 0)
        ? message.displayContent
        : message.content;
    const parsed = parseMessageContent(displaySource, message.msgType);
    const decoded = decodeMessageAttachments(parsed.text, message.attachments);
    return {
      text: decoded.text,
      pastedContents: decoded.attachments
        .filter(
          (a): a is FileAttachment & { kind: 'pasted-text' } => a.kind === 'pasted-text',
        )
        .map((a) => ({
          id: a.id,
          preview: a.previewText ?? '',
          fullContent: a.text ?? '',
        })),
      // Plan 220: all non-file/image kinds (pasted-text, terminal-ref,
      // browser-ref, file-tree-ref) render through AttachmentBar in
      // history mode for visual consistency with the input view.
      // `kind === undefined` is excluded here so legacy file/image
      // attachments (persisted before the discriminator existed) are
      // rendered by FileAttachmentCard above the bubble, not as chips.
      refAttachments: decoded.attachments.filter(
        (a) => a.kind !== 'file' && a.kind !== 'image' && a.kind !== undefined,
      ),
    };
  }, [message.content, message.displayContent, message.msgType, message.role]);

  // Build ordered action items from all messages in this round
  const { actions, finalText, allPastedContents } = useMemo(() => {
    const allMessages = sortMessagesByOrder([message, ...mergedMessages]);
    const rawActions: ActionItem[] = [];
    const allPasted: PastedContentInfo[] = [...pastedContents];

    for (const msg of allMessages) {
      const msgActions = messageToActionItems(msg, toolResultMap);
      rawActions.push(...msgActions);

      // Also collect pasted contents from merged messages only (not the main message)
      if (msg.id !== message.id && typeof msg.content === 'string' && msg.msgType !== 'thinking' && msg.msgType !== 'tool_use') {
        const withPasted = parseMessageContentWithPasted(msg.content);
        allPasted.push(...withPasted.pastedContents);
      }
    }

    // Merge consecutive text actions into a single text action
    // to prevent markdown fragmentation when text is split across multiple messages
    const mergedActions: ActionItem[] = [];
    for (const action of rawActions) {
      if (action.kind === 'text') {
        const last = mergedActions[mergedActions.length - 1];
        if (last && last.kind === 'text') {
          last.content += '\n' + action.content;
        } else {
          mergedActions.push({ ...action });
        }
      } else {
        mergedActions.push(action);
      }
    }

    // Separate final text from work actions. Text-only assistant rounds are
    // normal replies, not "actions"; mixed rounds keep in-progress text inside
    // the action log and lift only the trailing response text.
    const hasWidgetActions = mergedActions.some(a => a.kind === 'widget');
    const hasThinkingOrTool = mergedActions.some(a => a.kind === 'thinking' || a.kind === 'tool');
    let resultText = '';
    let resultActions = mergedActions;

    if (!hasThinkingOrTool && !hasWidgetActions) {
      const plainTexts = mergedActions
        .filter((action): action is ActionItem & { kind: 'text' } => action.kind === 'text')
        .map(action => action.content);

      return {
        actions: [],
        finalText: plainTexts.join('\n'),
        allPastedContents: allPasted,
      };
    }

    if (hasThinkingOrTool && mergedActions.length > 0) {
      // Collect trailing text actions into finalText
      const trailingTexts: string[] = [];
      while (resultActions.length > 0) {
        const last = resultActions[resultActions.length - 1];
        if (last.kind === 'text') {
          trailingTexts.unshift(last.content);
          resultActions = resultActions.slice(0, -1);
        } else {
          break;
        }
      }
      if (trailingTexts.length > 0) {
        resultText = trailingTexts.join('\n');
      }
    }

    return {
      actions: resultActions,
      finalText: resultText,
      allPastedContents: allPasted,
    };
  }, [message, mergedMessages, toolResultMap, pastedContents]);

  // Full wall-clock duration for the entire assistant round.
  // The agent records the end-to-end time (stream start -> final text) on the
  // final assistant message; intermediate deltas don't carry it. Take the max
  // non-null value across the round so the user sees the real response time
  // (including model thinking and gaps between tool calls).
  const totalRoundDurationMs = useMemo(() => {
    const allMessages = sortMessagesByOrder([message, ...mergedMessages]);
    let max = 0;
    for (const msg of allMessages) {
      if (msg.durationMs != null && msg.durationMs > max) {
        max = msg.durationMs;
      }
    }
    return max > 0 ? max : null;
  }, [message, mergedMessages]);

  const copyToClipboard = async () => {
    try {
      let copyContent: string;
      if (message.role === 'user') {
        const source = message.displayContent !== undefined && !(typeof message.displayContent === 'string' && message.displayContent.length === 0)
          ? message.displayContent
          : message.content;
        if (typeof source === 'string') {
          const parsed = parseBrowserReferenceDisplayContent(source);
          copyContent = [
            parsed.text,
            ...parsed.references.map(browserReferenceDisplaySummary),
          ].filter(Boolean).join('\n\n');
        } else {
          copyContent = extractMarkdownFromBlocks(source);
        }
      } else {
        // Assistant: prefer the visible final text. If a round is still in
        // progress (no finalText yet), fall back to joining the text blocks
        // in content so we never leak raw JSON like [{"type":"text",...},...].
        if (finalText && finalText.trim()) {
          copyContent = finalText;
        } else {
          copyContent = extractMarkdownFromBlocks(message.content);
        }
      }
      await navigator.clipboard.writeText(copyContent || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  // Preview handlers
  const handleOpenAttachmentPreview = (attachment: FileAttachment) => {
    setPreviewAttachment(attachment);
    setPreviewPastedContent(null);
  };

  // Plan 220: unified preview handler for all ref attachment kinds
  // (pasted-text, terminal-ref, browser-ref, file-tree-ref). Pastes
  // route through the pasted-content preview modal; other kinds route
  // through the attachment preview modal.
  const handleOpenRefPreview = (att: FileAttachment) => {
    if (att.kind === 'pasted-text') {
      setPreviewPastedContent({
        id: att.id,
        content: att.text ?? '',
        preview: att.previewText ?? att.name,
      });
      setPreviewAttachment(null);
    } else {
      handleOpenAttachmentPreview(att);
    }
  };

  const handleOpenPastedPreview = (content: PastedContentInfo) => {
    setPreviewPastedContent({ id: content.id, content: content.fullContent, preview: content.preview });
    setPreviewAttachment(null);
  };

  const handleClosePreview = () => {
    setPreviewAttachment(null);
    setPreviewPastedContent(null);
  };

  const isUser = message.role === 'user';
  const hasPastedContents = allPastedContents.length > 0;
  // P2-β: surface the "Stopped" badge when App.tsx.handleInterrupt
  // (Esc / chat:interrupt) marked this message as interrupted. The
  // flag is local-only — never persisted to DB.
  const isInterrupted = !isUser && message.metadata?.interrupted === true;

  // System-generated task-notification messages are injected as role:'user'
  // for the LLM (LLM APIs have no native system role for this), but they
  // carry raw <task-notification> XML that must not surface as a chat
  // bubble for the human reader. Hide them. Detection prefers the typed
  // metadata flag set by DuyaAgent; the string-prefix sniff is a fallback
  // for messages that predate the metadata flag.
  const isTaskNotification = message.isTaskNotification === true ||
    (isUser && typeof message.content === 'string' &&
     message.content.trimStart().startsWith('<task-notification>'));
  if (isTaskNotification) {
    return null;
  }

  // Strip any pasted full content that may have leaked into the
  // main text. Only run when the LLM-facing combined content is
  // actually being parsed (i.e. the first paste sits at the head
  // of the string, followed by a `\n\n` separator that joins it
  // to the user's typed text). Otherwise the parser has already
  // produced a clean text, and a naive substring match could
  // accidentally eat user-typed text that happens to start with
  // a pasted fragment.
  const displayText = useMemo(() => {
    if (!hasPastedContents) return mainText;
    let cleaned = mainText;
    for (const pasted of allPastedContents) {
      if (cleaned === pasted.fullContent) {
        return '';
      }
      if (cleaned.startsWith(pasted.fullContent + '\n\n')) {
        cleaned = cleaned.slice(pasted.fullContent.length).trimStart();
      } else if (cleaned.endsWith('\n\n' + pasted.fullContent)) {
        cleaned = cleaned.slice(0, cleaned.length - pasted.fullContent.length).trimEnd();
      }
    }
    return cleaned;
  }, [mainText, allPastedContents, hasPastedContents]);

  const userBrowserReferences = useMemo(() => {
    if (!isUser || !displayText) {
      return { text: displayText, references: [] as BrowserReferenceDisplayData[] };
    }
    return parseBrowserReferenceDisplayContent(displayText);
  }, [displayText, isUser]);

  const hasAttachments = message.attachments && message.attachments.length > 0;
  // Render image attachments alongside file attachments. Pasted images
  // store a data URL on `url` (no `thumbnail`/`displayUrl`), so pass
  // `url` through as a preview-source fallback for image kinds.
  // `kind === undefined` covers legacy attachments persisted before
  // Plan 220 introduced the discriminator — they are all file/image.
  const fileAttachments = message.attachments?.filter(
    (a) => a.kind === 'file' || a.kind === 'image' || a.kind === undefined,
  ) || [];

  if (message.isCompactBoundary) {
    return (
      <CompactBoundary
        compactedMessageCount={message.compactedMessageCount || 0}
        timestamp={message.timestamp}
      />
    );
  }

  if (message.isCompactSummary) {
    const summaryContent = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((b: any) => b.text || '').join('')
        : '';
    return (
      <CompactSummary
        content={summaryContent}
        compactedMessageCount={message.compactedMessageCount || 0}
      />
    );
  }

  if (isUser) {
    return (
      <div data-message-id={message.id} className="flex justify-end py-3 px-4 group">
        <div className="max-w-[85%] lg:max-w-[75%] flex flex-col items-end">
          {/* File & Image Attachments (PDF, DOCX, PNG, etc.) - Above message bubble */}
          {fileAttachments.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2 mb-2">
              {fileAttachments.map((attachment) => (
                <FileAttachmentCard
                  key={attachment.id}
                  id={attachment.id}
                  name={attachment.name}
                  thumbnail={
                    attachment.displayUrl
                    || attachment.thumbnail
                    || (attachment.kind === 'image' ? attachment.url : undefined)
                  }
                  url={attachment.url}
                  width={120}
                  onClick={() => handleOpenAttachmentPreview(attachment)}
                />
              ))}
            </div>
          )}
          {/* Plan 220: Unified reference attachment cards (pasted-text,
              terminal-ref, browser-ref, file-tree-ref). Replaces the
              bespoke pasted-content list and BrowserReferenceCard. */}
          {refAttachments.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2 mb-2">
              <AttachmentBar
                attachments={refAttachments}
                mode="history"
                onPreview={handleOpenRefPreview}
              />
            </div>
          )}
          {/* Legacy pasted-content cards (from markers in old messages).
              Kept as a fallback for allPastedContents that didn't make
              it through decodeMessageAttachments (e.g. merged messages
              from compacted history). */}
          {hasPastedContents && refAttachments.length === 0 && (
            <div className="flex flex-wrap justify-end gap-2 mb-2">
              {allPastedContents.map((content) => (
                <div
                  key={content.id}
                  className="message-pasted-content-item cursor-pointer hover:border-accent-soft hover:bg-surface-hover transition-all"
                  onClick={() => handleOpenPastedPreview(content)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleOpenPastedPreview(content); }}
                >
                  <div className="message-pasted-content-preview">
                    {content.preview}
                  </div>
                  <div className="message-pasted-content-label">
                    PASTED
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* Legacy browser-ref cards (from markers in old messages). */}
          {userBrowserReferences.references.length > 0 && refAttachments.length === 0 && (
            <div className="flex w-full flex-col gap-2 mb-2">
              {userBrowserReferences.references.map((reference, index) => (
                <BrowserReferenceCard
                  key={`${reference.kind}-${reference.url}-${index}`}
                  reference={reference}
                />
              ))}
            </div>
          )}
          {userBrowserReferences.text && (
          <div
            className="rounded-2xl rounded-tr-sm px-4 py-2.5"
            style={{ backgroundColor: 'rgba(0, 0, 0, 0.06)' }}
          >
            <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--text)' }}>{userBrowserReferences.text}</p>
          </div>
          )}
          <div className="flex justify-end items-center gap-2 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <span className="text-[11px] text-muted-foreground/60 tabular-nums">
              {formatMessageTime(message.timestamp, t, locale)}
            </span>
            <button
              onClick={copyToClipboard}
              className="p-1 rounded hover:bg-muted/50 transition-colors text-muted-foreground"
              title="Copy message"
            >
              {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
            </button>
            {onRewindToMessage && (
              <button
                onClick={() => onRewindToMessage(message.id)}
                className="p-1 rounded hover:bg-muted/50 transition-colors text-muted-foreground"
                title="回退到此处"
              >
                <ArrowCounterClockwiseIcon size={12} />
              </button>
            )}
          </div>
        </div>

        {/* Preview Modal */}
        <AttachmentPreviewModal
          attachment={previewAttachment}
          pastedContent={previewPastedContent}
          onClose={handleClosePreview}
        />
      </div>
    );
  }

  // Collect all tools for modified files summary
  const allTools: ToolAction[] = useMemo(() => {
    const tools: ToolAction[] = [];
    for (const action of actions) {
      if (action.kind === 'tool') {
        tools.push(action.tool);
      }
    }
    return tools;
  }, [actions]);

  const fileChangeSummaries = buildFileChangeSummaries(allTools);
  const artifactSummaries = buildArtifactSummaries(fileChangeSummaries);

  const hasActions = actions.length > 0;
  const hasWidgets = actions.some(a => a.kind === 'widget');
  const hasToolActions = actions.some(a => a.kind === 'tool' || a.kind === 'thinking');
  const toolOnlyActions = actions.filter(a => a.kind !== 'widget');

  return (
    <div data-message-id={message.id} className="py-3 px-4">
      <div className="w-full">
        {hasWidgets ? (
          <>
            {hasToolActions && (
              <ToolActionsGroup
                actions={toolOnlyActions}
                totalDurationMs={totalRoundDurationMs}
              />
            )}
            <InterleavedContent actions={actions} sourceMessageId={message.id} />
            {finalText && (
              <AssistantContent text={finalText} sourceMessageId={message.id} />
            )}
          </>
        ) : (
          <>
            {hasActions && (
              <ToolActionsGroup
                actions={actions}
                totalDurationMs={totalRoundDurationMs}
              />
            )}
            {finalText && (
              <AssistantContent text={finalText} sourceMessageId={message.id} />
            )}
          </>
        )}

        <MessageSummaryCards
          artifacts={artifactSummaries}
          changes={fileChangeSummaries}
          cwd={workingDirectory}
        />

        <div className="flex items-center gap-2 mt-3">
          {isInterrupted && (
            <span
              className="inline-flex items-center gap-1 text-[11px] text-amber-500"
              title={t('streaming.interruptedTooltip')}
            >
              <span aria-hidden="true">⏹</span>
              <span>{t('streaming.interrupted')}</span>
            </span>
          )}
          <span className="text-[11px] text-muted-foreground/60 tabular-nums">
            {formatMessageTime(message.timestamp, t, locale)}
          </span>
          <button
            onClick={copyToClipboard}
            className="p-1.5 rounded hover:bg-muted/50 transition-colors text-muted-foreground/60 hover:text-foreground"
            title="Copy message"
          >
            {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
}

export const MessageItem = React.memo(MessageItemComponent, messageItemPropsEqual);
