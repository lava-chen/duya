// MessageList.tsx - Message list component (Claude Code style)

'use client';

import React, { useEffect, useRef, useMemo, useCallback, forwardRef, useImperativeHandle, useLayoutEffect, useState } from 'react';
import type { Message } from '@/types';
import { MessageItem } from './MessageItem';
import { ResearchModePanel } from './research-mode';
import { StreamingMessage } from './StreamingMessage';
import { useResearchSession } from '@/hooks/useResearchSession';

export interface MessageListRef {
  scrollToBottom: () => void;
}

interface MessageListProps {
  messages: Message[];
  isStreaming?: boolean;
  onForceStop?: () => void;
  hasMore?: boolean;
  onLoadMore?: () => void;
  onScrollStateChange?: (isNearBottom: boolean) => void;
  error?: string | null;
  sessionId: string;
  onRewindToMessage?: (messageId: string) => void;
}

interface GroupedMessage {
  message: Message;
  toolResults: import('@/types').ToolResultInfo[];
  // For merged messages from the same round (same seqIndex group)
  mergedMessages?: Message[];
}

const MESSAGE_ROW_OVERSCAN_PX = 1200;
const MIN_ESTIMATED_ROW_HEIGHT = 88;
const MAX_ESTIMATED_ROW_HEIGHT = 560;
const ALWAYS_RENDER_TRAILING_ROWS = 8;
const ACTIVE_NAV_UPDATE_INTERVAL_MS = 160;

function estimateContentLength(content: Message['content']): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;

  let length = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const typedBlock = block as Record<string, unknown>;
    const text = typeof typedBlock.text === 'string'
      ? typedBlock.text
      : typeof typedBlock.thinking === 'string'
        ? typedBlock.thinking
        : '';
    length += text.length;
  }
  return length;
}

function estimateMessageRowHeight(group: GroupedMessage): number {
  const allMessages = [group.message, ...(group.mergedMessages ?? [])];
  const contentLength = allMessages.reduce((total, msg) => total + estimateContentLength(msg.content), 0);
  const toolCount = allMessages.filter(msg => msg.msgType === 'tool_use' || msg.msgType === 'thinking').length
    + group.toolResults.length;
  const attachmentCount = allMessages.reduce((total, msg) => total + (msg.attachments?.length ?? 0), 0);
  const widgetCount = allMessages.filter(msg => msg.msgType === 'viz' || msg.vizSpec).length;

  const base = group.message.role === 'user' ? 92 : 116;
  const textHeight = Math.ceil(contentLength / 120) * 22;
  const toolHeight = toolCount * 64;
  const attachmentHeight = attachmentCount > 0 ? 128 : 0;
  const widgetHeight = widgetCount * 280;

  return Math.max(
    MIN_ESTIMATED_ROW_HEIGHT,
    Math.min(MAX_ESTIMATED_ROW_HEIGHT, base + textHeight + toolHeight + attachmentHeight + widgetHeight),
  );
}

function toolResultsEqual(
  a: import('@/types').ToolResultInfo[],
  b: import('@/types').ToolResultInfo[],
): boolean {
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

function messagesEqual(a: Message[] | undefined, b: Message[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

const LazyMessageRow = React.memo(function LazyMessageRow({
  group,
  scrollRoot,
  isAlwaysRendered,
  cachedHeight,
  onHeightChange,
  onRewindToMessage,
}: {
  group: GroupedMessage;
  scrollRoot: React.RefObject<HTMLDivElement | null>;
  isAlwaysRendered: boolean;
  cachedHeight?: number;
  onHeightChange: (messageId: string, height: number) => void;
  onRewindToMessage?: (messageId: string) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [isNearViewport, setIsNearViewport] = useState(isAlwaysRendered);
  const [measuredHeight, setMeasuredHeight] = useState<number | undefined>(cachedHeight);
  const shouldRender = isAlwaysRendered || isNearViewport;
  const estimatedHeight = measuredHeight ?? cachedHeight ?? estimateMessageRowHeight(group);

  useEffect(() => {
    if (isAlwaysRendered) {
      setIsNearViewport(true);
      return;
    }

    const row = rowRef.current;
    const root = scrollRoot.current;
    if (!row || !root || typeof IntersectionObserver === 'undefined') {
      setIsNearViewport(true);
      return;
    }

    const observer = new IntersectionObserver(
      entries => {
        setIsNearViewport(entries.some(entry => entry.isIntersecting));
      },
      {
        root,
        rootMargin: `${MESSAGE_ROW_OVERSCAN_PX}px 0px`,
        threshold: 0,
      },
    );

    observer.observe(row);
    return () => observer.disconnect();
  }, [group.message.id, isAlwaysRendered, scrollRoot]);

  useLayoutEffect(() => {
    if (!shouldRender) return;

    const row = rowRef.current;
    if (!row || typeof ResizeObserver === 'undefined') return;

    const measure = () => {
      const height = row.getBoundingClientRect().height;
      if (height <= 0) return;

      const roundedHeight = Math.ceil(height);
      setMeasuredHeight(prev => (prev == null || Math.abs(prev - roundedHeight) > 2 ? roundedHeight : prev));
      onHeightChange(group.message.id, roundedHeight);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [group.message.id, onHeightChange, shouldRender]);

  return (
    <div
      ref={rowRef}
      data-message-id={group.message.id}
      style={shouldRender ? undefined : { minHeight: estimatedHeight }}
    >
      {shouldRender ? (
        <MessageItem
          message={group.message}
          toolResults={group.toolResults}
          mergedMessages={group.mergedMessages}
          onRewindToMessage={onRewindToMessage}
        />
      ) : null}
    </div>
  );
}, (prev, next) => (
  prev.group.message === next.group.message
  && messagesEqual(prev.group.mergedMessages, next.group.mergedMessages)
  && toolResultsEqual(prev.group.toolResults, next.group.toolResults)
  && prev.isAlwaysRendered === next.isAlwaysRendered
  && prev.cachedHeight === next.cachedHeight
  && prev.onRewindToMessage === next.onRewindToMessage
));

interface MessageNavigatorItem {
  id: string;
  targetMessageId: string;
  userPreview: string;
  assistantPreview: string;
  files: string[];
  hiddenFileCount: number;
  isActive: boolean;
}

function roleOrder(message: Message): number {
  switch (message.role) {
    case 'user':
      return 0;
    case 'assistant':
      return 1;
    case 'tool':
      return 2;
    default:
      return 3;
  }
}

function sortMessagesForConversation(messages: Message[]): Message[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const aSeq = a.message.seqIndex;
      const bSeq = b.message.seqIndex;

      if (aSeq != null && bSeq != null) {
        const seqDelta = aSeq - bSeq;
        if (seqDelta !== 0) return seqDelta;

        const roleDelta = roleOrder(a.message) - roleOrder(b.message);
        if (roleDelta !== 0) return roleDelta;
      } else {
        const timeDelta = a.message.timestamp - b.message.timestamp;
        if (timeDelta !== 0) return timeDelta;
      }

      return a.index - b.index;
    })
    .map(({ message }) => message);
}

function textFromContent(content: Message['content'] | Message['displayContent']): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const typedBlock = block as Record<string, unknown>;
    if (typedBlock.type === 'text' && typeof typedBlock.text === 'string') {
      parts.push(typedBlock.text);
    }
  }
  return parts.join('\n');
}

function compactPreview(text: string, fallback: string): string {
  const cleaned = text
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return fallback;
  return cleaned.length > 140 ? `${cleaned.slice(0, 139).trimEnd()}...` : cleaned;
}

function fileNameFromPathForNav(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.split('/').filter(Boolean).pop() || path;
}

function collectPathLikeValues(value: unknown, files: Set<string>): void {
  if (!value) return;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 260 || /\n/.test(trimmed)) return;
    if (
      /[\\/]/.test(trimmed)
      || /\.(tsx?|jsx?|css|json|md|mdx|ya?ml|toml|py|rs|go|java|c|cpp|h|hpp|sql|html|svg|png|jpe?g|gif|webp|pdf|docx?|xlsx?|pptx?)$/i.test(trimmed)
    ) {
      files.add(trimmed);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectPathLikeValues(item, files);
    return;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const [key, childValue] of Object.entries(record)) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes('path')
        || lowerKey.includes('file')
        || lowerKey === 'cwd'
        || lowerKey === 'pattern'
      ) {
        collectPathLikeValues(childValue, files);
      }
    }
  }
}

function collectMessageFiles(message: Message, files: Set<string>): void {
  for (const attachment of message.attachments || []) {
    files.add(attachment.path || attachment.name);
  }

  if (message.msgType === 'tool_use') {
    if (message.toolInput) {
      try {
        collectPathLikeValues(JSON.parse(message.toolInput), files);
      } catch {
        collectPathLikeValues(message.toolInput, files);
      }
    }
    return;
  }

  if (!Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (!block || typeof block !== 'object') continue;
    const typedBlock = block as Record<string, unknown>;
    if (typedBlock.type === 'tool_use') {
      collectPathLikeValues(typedBlock.input, files);
    }
  }
}

function collectToolNames(message: Message, names: string[]): void {
  if (message.msgType === 'tool_use') {
    names.push(message.toolName || message.name || 'tool');
    return;
  }

  if (!Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (!block || typeof block !== 'object') continue;
    const typedBlock = block as Record<string, unknown>;
    if (typedBlock.type === 'tool_use') {
      names.push(typeof typedBlock.name === 'string' ? typedBlock.name : 'tool');
    }
  }
}

function findAssistantGroupForUser(groupedMessages: GroupedMessage[], startIndex: number): GroupedMessage | null {
  for (let index = startIndex + 1; index < groupedMessages.length; index += 1) {
    const group = groupedMessages[index];
    if (group.message.role === 'user') return null;
    if (group.message.role === 'assistant') return group;
  }
  return null;
}

function buildNavigatorItems(groupedMessages: GroupedMessage[], activeMessageId: string | null): MessageNavigatorItem[] {
  const items: MessageNavigatorItem[] = [];

  for (let index = 0; index < groupedMessages.length; index += 1) {
    const group = groupedMessages[index];
    if (group.message.role !== 'user') continue;

    const nextAssistantGroup = findAssistantGroupForUser(groupedMessages, index);
    const assistantMessages = nextAssistantGroup
      ? [nextAssistantGroup.message, ...(nextAssistantGroup.mergedMessages || [])]
      : [];
    const files = new Set<string>();
    const toolNames: string[] = [];

    collectMessageFiles(group.message, files);
    for (const msg of assistantMessages) {
      collectMessageFiles(msg, files);
      collectToolNames(msg, toolNames);
    }

    const userSource = group.message.displayContent !== undefined && !(typeof group.message.displayContent === 'string' && group.message.displayContent.length === 0)
      ? group.message.displayContent
      : group.message.content;
    const assistantText = assistantMessages
      .map(msg => textFromContent(msg.content))
      .filter(Boolean)
      .join('\n');
    const assistantFallback = toolNames.length > 0
      ? `Used ${Array.from(new Set(toolNames)).slice(0, 4).join(', ')}`
      : nextAssistantGroup ? 'Agent activity' : 'No agent reply yet';

    const allFiles = Array.from(files).filter(Boolean);

    items.push({
      id: group.message.id,
      targetMessageId: group.message.id,
      userPreview: compactPreview(textFromContent(userSource), 'User message'),
      assistantPreview: compactPreview(assistantText, assistantFallback),
      files: allFiles.slice(0, 3),
      hiddenFileCount: Math.max(0, allFiles.length - 3),
      isActive: activeMessageId === group.message.id,
    });
  }

  return items;
}

function ChatMessageNavigator({
  items,
  onJump,
}: {
  items: MessageNavigatorItem[];
  onJump: (messageId: string) => void;
}) {
  if (items.length <= 3) return null;

  return (
    <nav className="chat-message-navigator" aria-label="Message navigation">
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          className={`chat-message-navigator-dot ${item.isActive ? 'active' : ''}`}
          onClick={() => onJump(item.targetMessageId)}
          aria-label={`Jump to message ${index + 1}`}
        >
          <span className="chat-message-navigator-mark" aria-hidden="true" />
          <span className="chat-message-navigator-card">
            <span className="chat-message-navigator-title">{item.userPreview}</span>
            <span className="chat-message-navigator-text">{item.assistantPreview}</span>
            {item.files.length > 0 && (
              <span className="chat-message-navigator-files">
                {item.files.map(file => (
                  <span key={file} className="chat-message-navigator-file" title={file}>
                    {fileNameFromPathForNav(file)}
                  </span>
                ))}
                {item.hiddenFileCount > 0 && (
                  <span className="chat-message-navigator-file chat-message-navigator-file-more">
                    +{item.hiddenFileCount}
                  </span>
                )}
              </span>
            )}
          </span>
        </button>
      ))}
    </nav>
  );
}

export const MessageList = forwardRef<MessageListRef, MessageListProps>(function MessageList({
  messages,
  isStreaming = false,
  onForceStop,
  hasMore = false,
  onLoadMore,
  onScrollStateChange,
  error,
  sessionId,
  onRewindToMessage,
}, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const prevMessagesLengthRef = useRef(messages.length);
  const wasStreamingRef = useRef(false);
  const userMessageIdRef = useRef<string | null>(null);
  const prevSessionIdRef = useRef(sessionId);
  const hasScrolledOnMountRef = useRef(false);
  const rowHeightsRef = useRef(new Map<string, number>());
  const lastActiveNavUpdateRef = useRef(0);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);

  // Single scroll state: true = user is at bottom and wants auto-scroll
  const autoScrollRef = useRef(true);

  const handleRowHeightChange = useCallback((messageId: string, height: number) => {
    const previousHeight = rowHeightsRef.current.get(messageId);
    if (previousHeight == null || Math.abs(previousHeight - height) > 2) {
      rowHeightsRef.current.set(messageId, height);
    }
  }, []);

  const updateScrollState = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const isNearBottom = distFromBottom < 100;
    autoScrollRef.current = distFromBottom < 50;
    onScrollStateChange?.(isNearBottom);
  }, [onScrollStateChange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let frameId = 0;
    const handleScroll = () => {
      if (frameId) return;
      frameId = requestAnimationFrame(() => {
        frameId = 0;
        updateScrollState();
      });
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    updateScrollState();

    return () => {
      if (frameId) cancelAnimationFrame(frameId);
      container.removeEventListener('scroll', handleScroll);
    };
  }, [updateScrollState]);

  // ResizeObserver: during streaming, auto-scroll when content grows and user is at bottom
  useEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;

    const ro = new ResizeObserver(() => {
      if (isStreaming && autoScrollRef.current) {
        requestAnimationFrame(() => {
          const container = containerRef.current;
          if (!container) return;
          container.scrollTop = container.scrollHeight;
        });
      }
    });

    ro.observe(inner);
    return () => ro.disconnect();
  }, [isStreaming]);

  // Group assistant messages with their tool results
  // Merge messages from the same round (same seqIndex or consecutive assistant messages)
  const groupedMessages = useMemo(() => {
    const result: GroupedMessage[] = [];
    const toolResultMap = new Map<string, import('@/types').ToolResultInfo>();
    const matchedToolResultIds = new Set<string>();
    const orderedMessages = sortMessagesForConversation(messages);

    // First pass: collect all tool results
    for (const msg of orderedMessages) {
      if (msg.role === 'tool' && msg.tool_call_id) {
        const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        toolResultMap.set(msg.tool_call_id, {
          tool_use_id: msg.tool_call_id,
          content: contentStr,
          is_error: msg.status === 'error' || (typeof contentStr === 'string' && contentStr.includes('<tool_error>')),
          duration_ms: msg.durationMs,
        });
      }
      if (msg.msgType === 'tool_result' && msg.parentToolCallId) {
        toolResultMap.set(msg.parentToolCallId, {
          tool_use_id: msg.parentToolCallId,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          is_error: msg.status === 'error',
          duration_ms: msg.durationMs,
        });
      }
    }

    // Second pass: group messages into rounds
    // A round = user message + all consecutive assistant messages until next user message
    // This handles multi-turn thinking -> tool -> thinking -> tool -> text cycles
    let currentAssistantGroup: GroupedMessage | null = null;

    for (const msg of orderedMessages) {
      // Skip pure tool results (they'll be attached to their tool_use)
      if (msg.msgType === 'tool_result') continue;
      if (msg.role === 'tool') continue;

      if (msg.role === 'user') {
        // End current assistant group if any
        if (currentAssistantGroup) {
          result.push(currentAssistantGroup);
          currentAssistantGroup = null;
        }
        // User messages are rendered separately
        result.push({ message: msg, toolResults: [] });
      } else if (msg.role === 'assistant') {
        if (!currentAssistantGroup) {
          // First assistant message in this round
          currentAssistantGroup = {
            message: msg,
            toolResults: [],
            mergedMessages: [],
          };
        } else if (
          currentAssistantGroup.message.seqIndex != null
          && msg.seqIndex != null
          && currentAssistantGroup.message.seqIndex !== msg.seqIndex
        ) {
          result.push(currentAssistantGroup);
          currentAssistantGroup = {
            message: msg,
            toolResults: [],
            mergedMessages: [],
          };
        } else {
          // Merge subsequent assistant messages into the same round
          currentAssistantGroup.mergedMessages!.push(msg);
        }

        // Collect tool results for this assistant message
        if (msg.msgType === 'tool_use' && msg.tool_call_id) {
          const toolResult = toolResultMap.get(msg.tool_call_id);
          if (toolResult) {
            currentAssistantGroup.toolResults.push(toolResult);
            matchedToolResultIds.add(msg.tool_call_id);
          }
        } else {
          const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          try {
            const blocks = JSON.parse(content);
            if (Array.isArray(blocks)) {
              for (const block of blocks) {
                if (block.type === 'tool_use' && block.id) {
                  const toolResult = toolResultMap.get(block.id);
                  if (toolResult) {
                    currentAssistantGroup.toolResults.push(toolResult);
                    matchedToolResultIds.add(block.id);
                  }
                }
              }
            }
          } catch {
            // Content is not JSON, skip
          }
        }
      }
    }

    // Push the last assistant group
    if (currentAssistantGroup) {
      result.push(currentAssistantGroup);
    }

    // Handle orphan tool results
    for (const [toolUseId, toolResult] of toolResultMap) {
      if (!matchedToolResultIds.has(toolUseId)) {
        result.push({
          message: {
            id: `orphan-result-${toolUseId}`,
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            msgType: 'tool_use',
            tool_call_id: toolUseId,
            name: toolResult.is_error ? 'Error' : 'Tool',
          },
          toolResults: [toolResult],
        });
      }
    }

    return result;
  }, [messages]);

  const navigatorItems = useMemo(
    () => buildNavigatorItems(groupedMessages, activeMessageId),
    [groupedMessages, activeMessageId]
  );

  const shouldRenderStreamingMessage = isStreaming;
  const researchSnapshot = useResearchSession(sessionId);
  const shouldRenderResearchPanel = researchSnapshot.mode === 'research'
    && (researchSnapshot.active
      || researchSnapshot.stage === 'complete'
      || researchSnapshot.stage === 'error'
      || researchSnapshot.planQuestions.length > 0
      || !!researchSnapshot.reportText);

  // Track session changes and reset scroll state
  useEffect(() => {
    const isSessionChanged = prevSessionIdRef.current !== sessionId;
    if (isSessionChanged) {
      prevSessionIdRef.current = sessionId;
      userMessageIdRef.current = null;
      prevMessagesLengthRef.current = 0;
      wasStreamingRef.current = false;
      hasScrolledOnMountRef.current = false;
      autoScrollRef.current = true;
      rowHeightsRef.current.clear();
      lastActiveNavUpdateRef.current = 0;
      setActiveMessageId(null);
      setIsInitialLoading(true);
    }
  }, [sessionId]);

  const updateActiveMessage = useCallback(() => {
    const container = containerRef.current;
    if (!container || navigatorItems.length === 0) return;

    const containerTop = container.getBoundingClientRect().top;
    let bestId = navigatorItems[0].targetMessageId;
    let bestDistance = Number.POSITIVE_INFINITY;
    const viewportLimit = container.clientHeight + 160;

    for (const item of navigatorItems) {
      const el = container.querySelector(`[data-message-id="${item.targetMessageId}"]`);
      if (!el) continue;
      const top = el.getBoundingClientRect().top - containerTop;
      if (top < -160 || top > viewportLimit) continue;
      const distance = Math.abs(top - 72);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestId = item.targetMessageId;
      }
    }

    setActiveMessageId(prev => (prev === bestId ? prev : bestId));
  }, [navigatorItems]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let frame = 0;
    const handleScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const now = Date.now();
        if (now - lastActiveNavUpdateRef.current < ACTIVE_NAV_UPDATE_INTERVAL_MS) return;
        lastActiveNavUpdateRef.current = now;
        updateActiveMessage();
      });
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    updateActiveMessage();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      container.removeEventListener('scroll', handleScroll);
    };
  }, [updateActiveMessage]);

  const scrollToMessage = useCallback((messageId: string) => {
    const container = containerRef.current;
    if (!container) return;

    const el = container.querySelector(`[data-message-id="${messageId}"]`);
    if (el) {
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      setActiveMessageId(messageId);
      autoScrollRef.current = false;
    }
  }, []);

  // Scroll to bottom when messages are first loaded (after session switch or initial load)
  // Use useLayoutEffect to run after DOM mutations but before paint
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Only scroll when we have messages and haven't scrolled yet for this session
    if (messages.length > 0 && !hasScrolledOnMountRef.current) {
      // Scroll immediately without animation to prevent visible scrolling
      const lastMessageEl = container.querySelector('[data-message-id]:last-of-type');
      if (lastMessageEl) {
        lastMessageEl.scrollIntoView({ block: 'end', behavior: 'instant' as ScrollBehavior });
      } else {
        container.scrollTop = container.scrollHeight;
      }
      hasScrolledOnMountRef.current = true;
      // Show content after scroll is done — layout is correct now
      setIsInitialLoading(false);
    } else if (messages.length === 0 && shouldRenderResearchPanel) {
      // Restored research sessions can have no chat messages loaded yet, but
      // still need to show the durable research card rebuilt from DB state.
      hasScrolledOnMountRef.current = true;
      setIsInitialLoading(false);
    }
  }, [messages.length, sessionId, shouldRenderResearchPanel]);

  // Scroll to bottom (exposed to parent)
  const scrollToBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    autoScrollRef.current = true;
  }, []);

  useImperativeHandle(ref, () => ({
    scrollToBottom,
  }), [scrollToBottom]);

  // Handle message additions
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Messages loaded from empty (initial load or after session change) — handled by useLayoutEffect
    const wasEmpty = prevMessagesLengthRef.current === 0;
    const hasMessagesNow = messages.length > 0;
    if (wasEmpty && hasMessagesNow) {
      prevMessagesLengthRef.current = messages.length;
      return;
    }

    // New user message detected — scroll it to viewport (nearest edge, not forced top)
    if (messages.length > prevMessagesLengthRef.current) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.role === 'user' && userMessageIdRef.current !== lastMsg.id) {
        userMessageIdRef.current = lastMsg.id;
        requestAnimationFrame(() => {
          const el = container.querySelector(`[data-message-id="${lastMsg.id}"]`);
          if (el) {
            el.scrollIntoView({ block: 'nearest', behavior: 'instant' as ScrollBehavior });
          } else {
            const lastEl = container.querySelector('[data-message-id]:last-of-type');
            if (lastEl) {
              lastEl.scrollIntoView({ block: 'end', behavior: 'instant' as ScrollBehavior });
            } else {
              container.scrollTop = container.scrollHeight;
            }
          }
        });
      } else if (autoScrollRef.current) {
        // Non-user message added — scroll to bottom only if user is already there
        const lastEl = container.querySelector('[data-message-id]:last-of-type');
        if (lastEl) {
          lastEl.scrollIntoView({ block: 'end', behavior: 'instant' as ScrollBehavior });
        } else {
          container.scrollTop = container.scrollHeight;
        }
      }
    }

    // Streaming just started — scroll to bottom
    if (isStreaming && !wasStreamingRef.current) {
      const lastEl = container.querySelector('[data-message-id]:last-of-type');
      if (lastEl) {
        lastEl.scrollIntoView({ block: 'end', behavior: 'instant' as ScrollBehavior });
      } else {
        container.scrollTop = container.scrollHeight;
      }
    }

    prevMessagesLengthRef.current = messages.length;
    wasStreamingRef.current = isStreaming;
  }, [messages, isStreaming]);



  return (
    <div ref={containerRef} className="message-list-scroll h-full overflow-y-auto scrollbar-thin pb-32">
      <ChatMessageNavigator items={navigatorItems} onJump={scrollToMessage} />

      {hasMore && (
        <div className="flex justify-center p-4">
          <button
            onClick={onLoadMore}
            className="px-4 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors rounded-lg hover:bg-muted/30"
          >
            Load earlier messages
          </button>
        </div>
      )}

      <div
        ref={innerRef}
        className={`flex flex-col max-w-[800px] mx-auto w-full px-4 ${isInitialLoading ? 'invisible' : ''}`}
      >
        {groupedMessages.map((group, index) => (
          <LazyMessageRow
            key={group.message.id}
            group={group}
            scrollRoot={containerRef}
            isAlwaysRendered={index >= groupedMessages.length - ALWAYS_RENDER_TRAILING_ROWS}
            cachedHeight={rowHeightsRef.current.get(group.message.id)}
            onHeightChange={handleRowHeightChange}
            onRewindToMessage={onRewindToMessage}
          />
        ))}

        {/* Error message display */}
        {error && (
          <div className="my-4 p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-600">
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="font-medium">Error</span>
            </div>
            <p className="mt-1 text-sm text-red-600/80">{error}</p>
          </div>
        )}

        {shouldRenderResearchPanel && (
          <ResearchModePanel
            sessionId={sessionId}
            snapshot={researchSnapshot}
            onForceStop={onForceStop}
          />
        )}

        {shouldRenderStreamingMessage && !shouldRenderResearchPanel && (
          <StreamingMessage
            sessionId={sessionId}
            onForceStop={onForceStop}
          />
        )}
      </div>
    </div>
  );
});
