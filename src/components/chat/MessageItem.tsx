'use client';

import React, { useState, useMemo } from 'react';
import type { Message, ToolUseInfo, ToolResultInfo } from '@/types';
import { ToolActionsGroup, pairTools, type ActionItem, type ToolAction } from './ToolActionsGroup';
import { MarkdownRenderer } from './MarkdownRenderer';
import { CopyIcon, CheckIcon, NotePencilIcon, ArrowCounterClockwiseIcon } from '@/components/icons';
import { FileAttachmentCard } from './FileAttachmentCard';
import { AttachmentPreviewModal } from './AttachmentPreviewModal';
import { parseMessageContentWithPasted, type PastedContentInfo } from '@/lib/message-content-parser';
import { parseAllShowWidgets } from '@/lib/widget-parser';
import { WidgetRenderer } from './WidgetRenderer';
import { WidgetErrorBoundary } from './WidgetErrorBoundary';
import { CompactBoundary } from './CompactBoundary';
import { CompactSummary } from './CompactSummary';
import { useConversationStore } from '@/stores/conversation-store';
import type { FileAttachment } from '@/types/message';

function formatMessageTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const oneWeekAgo = new Date(today);
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

  const timeStr = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  if (date >= today) {
    return timeStr;
  } else if (date >= yesterday) {
    return `Yesterday ${timeStr}`;
  } else if (date >= oneWeekAgo) {
    const weekday = date.toLocaleDateString('en-US', { weekday: 'long' });
    return `${weekday} ${timeStr}`;
  } else {
    const dateStr = date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    });
    return `${dateStr} ${timeStr}`;
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

function AssistantContent({
  text,
  pastedContents,
  sourceMessageId,
}: {
  text: string;
  pastedContents: PastedContentInfo[];
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

interface DiffSummaryProps {
  files: { name: string; path: string }[];
}

function DiffSummary({ files }: DiffSummaryProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen(prev => !prev)}
        className="flex items-center gap-1.5 text-[11px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
      >
        <NotePencilIcon size={10} className="shrink-0" />
        <span>Modified {files.length} file{files.length > 1 ? 's' : ''}</span>
      </button>
      {open && (
        <div className="ml-3 mt-0.5 space-y-0.5">
          {files.map(f => (
            <div key={f.path} className="flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground/40">
              <NotePencilIcon size={10} className="shrink-0" />
              <span className="truncate" title={f.path}>{f.name}</span>
            </div>
          ))}
        </div>
      )}
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

export function MessageItem({ message, toolResults = [], onToolResult, mergedMessages = [], onRewindToMessage }: MessageItemProps) {
  const [copied, setCopied] = useState(false);
  // Preview modal state
  const [previewAttachment, setPreviewAttachment] = useState<FileAttachment | null>(null);
  const [previewPastedContent, setPreviewPastedContent] = useState<{ id: string; content: string; preview: string } | null>(null);

  const isSubAgentSession = !!useConversationStore(s => s.parentSessionId);

  // Build tool result map for quick lookup
  const toolResultMap = useMemo(() => {
    const map = new Map<string, ToolResultInfo>();
    for (const r of toolResults) {
      map.set(r.tool_use_id, r);
    }
    return map;
  }, [toolResults]);

  // Parse main message content (including pasted content markers)
  // For user messages with displayContent, render the original prompt
  // instead of the full assembled context (pre-analysis + attachment text)
  const { text: mainText, pastedContents } = useMemo(() => {
    const displaySource = message.role === 'user' && message.displayContent !== undefined
      ? message.displayContent
      : message.content;
    const parsed = parseMessageContent(displaySource, message.msgType);
    const withPasted = parseMessageContentWithPasted(parsed.text);
    return {
      text: withPasted.text,
      pastedContents: withPasted.pastedContents,
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

    // Separate final text from actions:
    // If the last action is text, extract it as the final response text
    // (unless there are only text actions and no thinking/tools)
    const hasWidgetActions = mergedActions.some(a => a.kind === 'widget');
    const hasThinkingOrTool = mergedActions.some(a => a.kind === 'thinking' || a.kind === 'tool');
    let resultText = '';
    let resultActions = mergedActions;

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

    // If no thinking/tool at all, keep all text in actions and don't show separate finalText
    if (!hasThinkingOrTool) {
      resultText = '';
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
      const copyContent = message.role === 'user' && message.displayContent !== undefined
        ? message.displayContent
        : message.content;
      await navigator.clipboard.writeText(typeof copyContent === 'string' ? copyContent : JSON.stringify(copyContent, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  // Preview handlers
  const handleOpenAttachmentPreview = (attachment: FileAttachment) => {
    setPreviewAttachment(attachment);
    setPreviewPastedContent(null);
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

  const displayText = useMemo(() => {
    if (!hasPastedContents) return mainText;
    let cleaned = mainText;
    for (const pasted of allPastedContents) {
      if (cleaned.includes(pasted.fullContent)) {
        cleaned = cleaned.replace(pasted.fullContent, '').trim();
      }
    }
    return cleaned;
  }, [mainText, allPastedContents, hasPastedContents]);

  const hasAttachments = message.attachments && message.attachments.length > 0;
  const imageAttachments = message.attachments?.filter(a => a.type.startsWith('image/')) || [];
  const fileAttachments = message.attachments?.filter(a => !a.type.startsWith('image/')) || [];

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
          {/* File Attachments (PDF, DOCX, etc.) - Above message bubble */}
          {fileAttachments.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2 mb-2">
              {fileAttachments.map((attachment) => (
                <FileAttachmentCard
                  key={attachment.id}
                  id={attachment.id}
                  name={attachment.name}
                  thumbnail={attachment.thumbnail}
                  width={120}
                  onClick={() => handleOpenAttachmentPreview(attachment)}
                />
              ))}
            </div>
          )}
          {/* Image Attachments - Above message bubble */}
          {imageAttachments.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2 mb-2">
              {imageAttachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className="relative group/image cursor-pointer"
                  onClick={() => handleOpenAttachmentPreview(attachment)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleOpenAttachmentPreview(attachment); }}
                >
                  <img
                    src={attachment.displayUrl || attachment.url}
                    alt={attachment.name}
                    className="max-w-[200px] max-h-[150px] rounded-lg object-cover border border-border/50 hover:border-accent/50 transition-colors"
                    loading="lazy"
                  />
                  <div className="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-[10px] px-2 py-0.5 rounded-b-lg opacity-0 group-hover/image:opacity-100 transition-opacity truncate">
                    {attachment.name}
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* Pasted Content Attachments - Above message bubble */}
          {hasPastedContents && (
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
          {displayText && (
          <div
            className="rounded-2xl rounded-tr-sm px-4 py-2.5"
            style={{ backgroundColor: 'rgba(0, 0, 0, 0.06)' }}
          >
            <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--text)' }}>{displayText}</p>
          </div>
          )}
          <div className="flex justify-end items-center gap-2 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <span className="text-[11px] text-muted-foreground/60 tabular-nums">
              {formatMessageTime(message.timestamp)}
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

  const WRITE_TOOLS = new Set(['write', 'edit', 'writefile', 'write_file', 'create_file', 'createfile', 'str_replace_editor']);
  const modifiedFiles = allTools
    .filter(t => WRITE_TOOLS.has(t.name.toLowerCase()) && !t.isError)
    .map(t => {
      const inp = t.input as Record<string, unknown> | undefined;
      const filePath = (inp?.file_path || inp?.path || inp?.filePath || '') as string;
      const parts = filePath.split('/');
      return { path: filePath, name: parts[parts.length - 1] || filePath };
    })
    .filter(f => f.path);
  const uniqueModified = [...new Map(modifiedFiles.map(f => [f.path, f])).values()];

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
                flat={isSubAgentSession}
                totalDurationMs={totalRoundDurationMs}
              />
            )}
            <InterleavedContent actions={actions} sourceMessageId={message.id} />
            {finalText && (
              <AssistantContent text={finalText} pastedContents={allPastedContents} sourceMessageId={message.id} />
            )}
          </>
        ) : (
          <>
            {hasActions && (
              <ToolActionsGroup
                actions={actions}
                flat={isSubAgentSession}
                totalDurationMs={totalRoundDurationMs}
              />
            )}
            {finalText && (
              <AssistantContent text={finalText} pastedContents={allPastedContents} sourceMessageId={message.id} />
            )}
          </>
        )}

        {uniqueModified.length > 0 && <DiffSummary files={uniqueModified} />}

        <div className="flex items-center gap-2 mt-3 opacity-0 hover:opacity-100 transition-opacity">
          <button
            onClick={copyToClipboard}
            className="p-1.5 rounded hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground"
            title="Copy message"
          >
            {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
}
