'use client';

import React, { useState, useMemo } from 'react';
import type { Message, ToolUseInfo, ToolResultInfo } from '@/types';
import { ToolActionsGroup, pairTools, type ActionItem, type ToolAction } from './ToolActionsGroup';
import { MarkdownRenderer } from './MarkdownRenderer';
import { CopyIcon, CheckIcon, NotePencilIcon } from '@/components/icons';
import { parseMessageContentWithPasted, type PastedContentInfo } from '@/lib/message-content-parser';
import { parseAllShowWidgets } from '@/lib/widget-parser';
import { WidgetRenderer } from './WidgetRenderer';
import { WidgetErrorBoundary } from './WidgetErrorBoundary';

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
    if (typeof content === 'string') {
      try {
        const parsed = JSON.parse(content);
        toolUses.push({ id: '', name: '', input: parsed });
      } catch {
        toolUses.push({ id: '', name: '', input: {} });
      }
    } else {
      toolUses.push({ id: '', name: '', input: content as unknown as Record<string, unknown> || {} });
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
    if (content.trim().startsWith('[')) {
      try {
        const blocks = JSON.parse(content);
        if (Array.isArray(blocks)) {
          const textParts: string[] = [];

          blocks.forEach(block => {
            if (block.type === 'text' && block.text) {
              textParts.push(block.text);
            } else if (block.type === 'tool_use') {
              toolUses.push({
                id: block.id,
                name: block.name,
                input: block.input || {},
              });
            } else if (block.type === 'thinking' && block.thinking) {
              const rawThinking = block.thinking;
              thinkingContent = typeof rawThinking === 'string' ? rawThinking : JSON.stringify(rawThinking);
            }
          });

          text = textParts.join('');
          return { text, toolUses, thinkingContent };
        }
      } catch {
        // If JSON parsing fails, treat as plain text
      }
    }

    text = content;
    return { text, toolUses };
  }

  return { text, toolUses };
}

function AssistantContent({ text, pastedContents }: { text: string; pastedContents: PastedContentInfo[] }) {
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
              />
            </WidgetErrorBoundary>
          );
        }
        return null;
      })}
    </>
  );
}

function InterleavedContent({ actions }: { actions: ActionItem[] }) {
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
    actions.push({ kind: 'widget', content: msg.vizSpec });
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
            actions.push({ kind: 'widget', content: widgetCode });
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

  // Parse string content that might be JSON array
  if (typeof msg.content === 'string') {
    if (msg.content.trim().startsWith('[')) {
      try {
        const blocks = JSON.parse(msg.content);
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            if (block.type === 'text' && block.text && String(block.text).trim()) {
              actions.push({ kind: 'text', content: String(block.text) });
            } else if (block.type === 'tool_use') {
              if (block.name === 'show_widget') {
                const widgetCode = (block.input as Record<string, unknown>)?.widget_code;
                if (typeof widgetCode === 'string' && widgetCode.trim()) {
                  actions.push({ kind: 'widget', content: widgetCode });
                }
                continue;
              }
              const toolId = String(block.id || '');
              const result = toolId ? toolResultMap.get(toolId) : undefined;
              actions.push({
                kind: 'tool',
                tool: {
                  id: toolId,
                  name: String(block.name || ''),
                  input: block.input || {},
                  result: result?.content,
                  isError: result?.is_error,
                  durationMs: result?.duration_ms,
                },
              });
            } else if (block.type === 'thinking' && block.thinking) {
              const rawThinking = block.thinking;
              const thinkingStr = typeof rawThinking === 'string' ? rawThinking : JSON.stringify(rawThinking);
              if (thinkingStr.trim()) {
                actions.push({ kind: 'thinking', content: thinkingStr });
              }
            }
          }
          return actions;
        }
      } catch {
        // Not JSON array, treat as plain text
      }
    }

    // Plain text
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

export function MessageItem({ message, toolResults = [], onToolResult, mergedMessages = [] }: MessageItemProps) {
  const [copied, setCopied] = useState(false);

  // Build tool result map for quick lookup
  const toolResultMap = useMemo(() => {
    const map = new Map<string, ToolResultInfo>();
    for (const r of toolResults) {
      map.set(r.tool_use_id, r);
    }
    return map;
  }, [toolResults]);

  // Parse main message content (including pasted content markers)
  const { text: mainText, pastedContents } = useMemo(() => {
    const parsed = parseMessageContent(message.content, message.msgType);
    const withPasted = parseMessageContentWithPasted(parsed.text);
    return {
      text: withPasted.text,
      pastedContents: withPasted.pastedContents,
    };
  }, [message.content, message.msgType]);

  // Build ordered action items from all messages in this round
  const { actions, finalText, allPastedContents } = useMemo(() => {
    const allMessages = sortMessagesByOrder([message, ...mergedMessages]);
    const rawActions: ActionItem[] = [];
    const allPasted: PastedContentInfo[] = [...pastedContents];

    for (const msg of allMessages) {
      const msgActions = messageToActionItems(msg, toolResultMap);
      rawActions.push(...msgActions);

      // Also collect pasted contents from text-type messages
      if (typeof msg.content === 'string' && msg.msgType !== 'thinking' && msg.msgType !== 'tool_use') {
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

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(typeof message.content === 'string' ? message.content : JSON.stringify(message.content, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  const isUser = message.role === 'user';
  const hasPastedContents = allPastedContents.length > 0;
  const hasAttachments = message.attachments && message.attachments.length > 0;
  const imageAttachments = message.attachments?.filter(a => a.type.startsWith('image/')) || [];

  if (isUser) {
    return (
      <div data-message-id={message.id} className="flex justify-end py-3 px-4 group">
        <div className="max-w-[85%] lg:max-w-[75%] flex flex-col items-end">
          {/* Image Attachments - Above message bubble */}
          {imageAttachments.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2 mb-2">
              {imageAttachments.map((attachment) => (
                <div key={attachment.id} className="relative group/image">
                  <img
                    src={attachment.url}
                    alt={attachment.name}
                    className="max-w-[200px] max-h-[150px] rounded-lg object-cover border border-border/50"
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
                <div key={content.id} className="message-pasted-content-item">
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
          <div
            className="rounded-2xl rounded-tr-sm px-4 py-2.5"
            style={{ backgroundColor: 'rgba(0, 0, 0, 0.06)' }}
          >
            <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--text)' }}>{mainText}</p>
          </div>
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
          </div>
        </div>
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
      <div className={hasWidgets ? 'max-w-[95%]' : 'max-w-[90%] lg:max-w-[85%]'}>
        {hasWidgets ? (
          <>
            {hasToolActions && (
              <ToolActionsGroup
                actions={toolOnlyActions}
              />
            )}
            <InterleavedContent actions={actions} />
            {finalText && (
              <AssistantContent text={finalText} pastedContents={allPastedContents} />
            )}
          </>
        ) : (
          <>
            {hasActions && (
              <ToolActionsGroup
                actions={actions}
              />
            )}
            {finalText && (
              <AssistantContent text={finalText} pastedContents={allPastedContents} />
            )}
          </>
        )}

        {uniqueModified.length > 0 && <DiffSummary files={uniqueModified} />}

        <div className="flex items-center gap-2 mt-3 opacity-0 hover:opacity-100 transition-opacity">
          {message.durationMs != null && message.durationMs > 0 && (
            <span className="text-[11px] text-muted-foreground/60 tabular-nums">
              {message.durationMs < 1000
                ? `${message.durationMs}ms`
                : `${(message.durationMs / 1000).toFixed(1)}s`}
            </span>
          )}
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
