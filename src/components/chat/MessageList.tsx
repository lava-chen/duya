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
  const [isInitialLoading, setIsInitialLoading] = useState(true);

  // Single scroll state: true = user is at bottom and wants auto-scroll
  const autoScrollRef = useRef(true);

  // Check if user is near bottom of scroll
  const checkScrollPosition = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const threshold = 100; // pixels from bottom
    const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
    onScrollStateChange?.(isNearBottom);
  }, [onScrollStateChange]);

  // Scroll event: notify external about scroll position
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      checkScrollPosition();
    };

    container.addEventListener('scroll', handleScroll);
    checkScrollPosition(); // Initial check

    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [checkScrollPosition]);

  // Scroll event: track whether user is at bottom for auto-scroll decisions
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleUserScroll = () => {
      const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      autoScrollRef.current = distFromBottom < 50;
    };

    container.addEventListener('scroll', handleUserScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleUserScroll);
    };
  }, []);

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
      setIsInitialLoading(true);
    }
  }, [sessionId]);

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
        className={`flex flex-col max-w-[800px] mx-auto px-4 ${isInitialLoading ? 'invisible' : ''}`}
      >
        {groupedMessages.map((group) => (
          <MessageItem
            key={group.message.id}
            message={group.message}
            toolResults={group.toolResults}
            mergedMessages={group.mergedMessages}
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
