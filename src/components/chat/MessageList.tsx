// MessageList.tsx - Message list component (Claude Code style)

'use client';

import React, { useEffect, useRef, useMemo, useCallback, forwardRef, useImperativeHandle, useLayoutEffect, useState } from 'react';
import type { Message } from '@/types';
import { MessageItem } from './MessageItem';
import { StreamingMessage } from './StreamingMessage';
import { NextStepSuggestions } from './NextStepSuggestions';
import { Button } from '@/components/ui/Button';
import { ChevronDownIcon } from '@/components/icons';
import { WorkflowRunStream } from '@/components/workflow/WorkflowRunCard';
import { useFocusModeStore, selectFocusEnabled } from '@/stores/focus-mode-store';

export interface MessageListRef {
  scrollToBottom: () => void;
}

interface MessageListProps {
  messages: Message[];
  isStreaming?: boolean;
  isFinalizing?: boolean;
  onForceStop?: () => void;
  hasMore?: boolean;
  onLoadMore?: () => void;
  onScrollStateChange?: (isNearBottom: boolean) => void;
  error?: string | null;
  sessionId: string;
  onEditSend?: (messageId: string, text: string) => void;
  /** Predicted follow-up prompts shown as cards at the end of the stream. */
  nextStepSuggestions?: string[];
  onNextStepSelect?: (value: string) => void;
}

interface GroupedMessage {
  message: Message;
  toolResults: import('@/types').ToolResultInfo[];
  // For merged messages from the same round (same seqIndex group)
  mergedMessages?: Message[];
}

const MESSAGE_ROW_OVERSCAN_PX = 600;
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

function hasRenderableAssistantContent(message: Message): boolean {
  if (message.msgType === 'tool_use' || message.msgType === 'thinking' || message.msgType === 'viz') {
    return true;
  }
  if (message.tool_call_id || message.toolName || message.vizSpec) return true;
  return estimateContentLength(message.content) > 0;
}

/**
 * System-injected user rows — background task notifications, wake-run
 * prompts, approval decision echoes, routine dues, agent DM wake cues,
 * spawned-session completion notices (`[session:completed]` / `[session:failed]`,
 * written by notifySpawnCompletion) — are model context, not user chat.
 * The runtime pushes them onto the streamed message array as role 'user'
 * (they are never durable; the persistence filter drops them), and
 * MessageItem hides the notification shapes. Grouping must treat them the
 * same way: they neither break the current assistant round nor render as
 * their own row. Letting them through produced the "one collapsed 已处理
 * segment per think→tool cycle" transcript bug (2026-09-24): every injected
 * notification cut the single continuous round into a separate group with
 * its own timestamp footer.
 */
function isSystemInjectedUserMessage(message: Message): boolean {
  if (message.isTaskNotification) return true;
  if (message.source === 'system') return true;
  const text = textFromContent(message.content).trimStart();
  return (
    text.startsWith('<task-notification>')
    || text.startsWith('[system] ')
    || text.startsWith('[agent] ')
    || text.startsWith('[routine] ')
    || text.startsWith('[session:')
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

/**
 * Group sorted messages into UI "rounds" (a user message plus its assistant
 * replies, with tool results attached). Extracted from the component so an
 * append-only increment can reuse frozen rows instead of re-grouping the
 * whole transcript (and re-serializing every tool result) on each update.
 */
function buildGroupedMessages(orderedMessages: Message[]): GroupedMessage[] {
  const result: GroupedMessage[] = [];
  const toolResultMap = new Map<string, import('@/types').ToolResultInfo>();
  const matchedToolResultIds = new Set<string>();

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

    // Skip system-injected user rows (task notifications, wake prompts,
    // approval echoes): model context that must neither break the current
    // assistant round nor render as a user bubble. See
    // isSystemInjectedUserMessage for the full rationale.
    if (msg.role === 'user' && isSystemInjectedUserMessage(msg)) continue;

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
        // First assistant message after a user message.
        currentAssistantGroup = {
          message: msg,
          toolResults: [],
          mergedMessages: [],
        };
      } else {
        // Merge every consecutive assistant message into the same
        // round. Previously we split on seqIndex changes, which
        // produced one "N completed" summary per round when the
        // agent ran multiple think→tool→think→tool cycles for a
        // single user request. From the user's point of view that
        // is still one continuous piece of work; they want a
        // single collapsed row ("任务耗时 X") that expands to show
        // all steps and the final answer.
        //
        // A new user message already breaks the group above, so
        // unrelated user turns cannot be merged. If the persistence
        // layer ever emits assistant messages with no user turn in
        // between that should NOT be grouped, that should be fixed
        // in persistence (e.g. by giving them distinct session
        // boundaries), not here.
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
        // Array content is the common case — iterate blocks directly
        // instead of the previous JSON.stringify → JSON.parse round trip,
        // which re-serialized every assistant message on each re-group.
        const blocks = Array.isArray(msg.content)
          ? msg.content
          : (() => {
              try {
                return JSON.parse(msg.content as string) as unknown;
              } catch {
                return null;
              }
            })();
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_use') {
              const blockId = (block as Record<string, unknown>).id;
              if (typeof blockId === 'string') {
                const toolResult = toolResultMap.get(blockId);
                if (toolResult) {
                  currentAssistantGroup.toolResults.push(toolResult);
                  matchedToolResultIds.add(blockId);
                }
              }
            }
          }
        }
      }
    }
  }

  // Push the last assistant group
  if (currentAssistantGroup) {
    result.push(currentAssistantGroup);
  }

  // Handle orphan tool results — tool_results whose matching tool_use
  // isn't in the loaded message set (e.g. truncated history, legacy
  // import). Synthesize a minimal tool_use-shaped message so the
  // existing ToolActionsGroup → ToolActionRow pipeline can render
  // the result. Use `tool_result` as the toolName (matches the
  // convention in pairTools) so it routes to the registry catch-all
  // (WrenchIcon) instead of masquerading as a nonexistent "Error" or
  // "Tool" tool that would leak misleading verbs into group summaries.
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
          toolName: 'tool_result',
        } as Message,
        toolResults: [toolResult],
      });
    }
  }

  // A few persistence paths create empty assistant placeholders after an
  // interrupted stream. They render only a timestamp/copy icon, producing
  // the stray time labels visible in the transcript.
  return result.filter((group) => (
    group.message.role !== 'assistant'
    || group.toolResults.length > 0
    || [group.message, ...(group.mergedMessages ?? [])]
      .some(hasRenderableAssistantContent)
  ));
}

/**
 * Length of the reference-identical prefix shared by the cached sorted list
 * and the freshly sorted one. Message objects are only ever replaced
 * in-place by the store on an edit (rewind, edit-and-resend, session
 * switch); streaming updates swap the tail message object for a new
 * reference while keeping everything before it identical, so a long common
 * prefix means only the tail round needs re-grouping.
 */
function commonPrefixLength(prev: Message[], next: Message[]): number {
  const n = Math.min(prev.length, next.length);
  let index = 0;
  while (index < n && prev[index] === next[index]) index += 1;
  return index;
}

/** Index of the last user message in an already-sorted list, or -1. */
function lastUserIndexSorted(ordered: Message[]): number {
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    if (ordered[index].role === 'user') return index;
  }
  return -1;
}

const LazyMessageRow = React.memo(function LazyMessageRow({
  group,
  scrollRoot,
  rowDomId,
  isAlwaysRendered,
  cachedHeight,
  onHeightChange,
  isEditable,
  onEditSend,
  focusMode,
  isLiveRun,
}: {
  group: GroupedMessage;
  scrollRoot: React.RefObject<HTMLDivElement | null>;
  rowDomId: string;
  isAlwaysRendered: boolean;
  cachedHeight?: number;
  onHeightChange: (messageId: string, height: number) => void;
  isEditable?: boolean;
  onEditSend?: (messageId: string, text: string) => void;
  focusMode?: boolean;
  /** Plan 447: round belongs to the turn currently being streamed —
   *  render the tool group in the live presentation instead of the
   *  finished collapsed summary. */
  isLiveRun?: boolean;
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
      id={rowDomId}
      data-message-id={group.message.id}
      className="transition-[min-height] duration-200 ease-out"
      style={shouldRender
        ? undefined
        : {
            // Off-screen rows: skip layout/paint/composite for this subtree.
            // The browser uses `contain-intrinsic-size` as the placeholder
            // height so the scrollbar position stays correct without us
            // reserving a forced min-height (which would still cost layout).
            contentVisibility: 'auto',
            containIntrinsicSize: `auto ${estimatedHeight}px`,
          }}
    >
      {shouldRender ? (
        <MessageItem
          message={group.message}
          toolResults={group.toolResults}
          mergedMessages={group.mergedMessages}
          isEditable={isEditable}
          onEditSend={onEditSend}
          focusMode={focusMode}
          isLiveRun={isLiveRun}
        />
      ) : null}
    </div>
  );
}, (prev, next) => (
  prev.group.message === next.group.message
  && messagesEqual(prev.group.mergedMessages, next.group.mergedMessages)
  && toolResultsEqual(prev.group.toolResults, next.group.toolResults)
  && prev.rowDomId === next.rowDomId
  && prev.isAlwaysRendered === next.isAlwaysRendered
  && prev.cachedHeight === next.cachedHeight
  && prev.isEditable === next.isEditable
  && prev.onEditSend === next.onEditSend
  && prev.focusMode === next.focusMode
  && prev.isLiveRun === next.isLiveRun
));

interface MessageNavigatorItem {
  id: string;
  targetMessageId: string;
  userPreview: string;
  assistantPreview: string;
  files: string[];
  hiddenFileCount: number;
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

type NavigatorCache = Map<string, { deps: Message[]; item: MessageNavigatorItem }>;

function buildNavigatorItems(groupedMessages: GroupedMessage[], cache?: NavigatorCache): MessageNavigatorItem[] {
  const items: MessageNavigatorItem[] = [];

  for (let index = 0; index < groupedMessages.length; index += 1) {
    const group = groupedMessages[index];
    if (group.message.role !== 'user') continue;

    const nextAssistantGroup = findAssistantGroupForUser(groupedMessages, index);
    const assistantMessages = nextAssistantGroup
      ? [nextAssistantGroup.message, ...(nextAssistantGroup.mergedMessages || [])]
      : [];

    // Frozen rounds keep message references stable across tail re-groups,
    // so a reference-identical deps check lets every historical turn reuse
    // its preview instead of re-running the regex/recursive file walk over
    // the whole transcript on each streaming update.
    const cachedEntry = cache?.get(group.message.id);
    if (
      cachedEntry
      && cachedEntry.deps.length === assistantMessages.length + 1
      && cachedEntry.deps[0] === group.message
      && assistantMessages.every((msg, i) => cachedEntry.deps[i + 1] === msg)
    ) {
      items.push(cachedEntry.item);
      continue;
    }
    const files = new Set<string>();
    const toolNames: string[] = [];

    collectMessageFiles(group.message, files);
    for (const msg of assistantMessages) {
      collectMessageFiles(msg, files);
      collectToolNames(msg, toolNames);
    }

    const userSource = group.message.displayContent !== undefined
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

    const item: MessageNavigatorItem = {
      id: group.message.id,
      targetMessageId: group.message.id,
      userPreview: compactPreview(textFromContent(userSource), 'User message'),
      assistantPreview: compactPreview(assistantText, assistantFallback),
      files: allFiles.slice(0, 3),
      hiddenFileCount: Math.max(0, allFiles.length - 3),
    };
    cache?.set(group.message.id, { deps: [group.message, ...assistantMessages], item });
    items.push(item);
  }

  return items;
}

/**
 * Phase-grouping constants.
 * - MAX_VISIBLE_DOTS: cap on how many nav dots render (each is 28×8px + 3px margin ≈ 39px tall).
 *   20 dots ≈ 780px of rail — enough to cover most sessions without overflow.
 * - RAIL_VISIBILITY_WINDOW: fraction of items near the active message that are always shown
 *   (even when capped). Set to 0.3 so the 30% of items around the active turn are never
 *   hidden behind the "expand" indicator.
 */
const MAX_VISIBLE_DOTS = 20;
const RAIL_VISIBILITY_WINDOW = 0.3;

function ChatMessageNavigator({
  items,
  activeMessageId,
  onJump,
}: {
  items: MessageNavigatorItem[];
  activeMessageId: string | null;
  onJump: (messageId: string) => void;
}) {
  if (items.length <= 3) return null;

  // Determine which indices to render when capped.
  const total = items.length;
  const capped = total > MAX_VISIBLE_DOTS;
  const windowSize = Math.max(2, Math.floor(total * RAIL_VISIBILITY_WINDOW));

  let visibleIndices: number[];
  if (!capped) {
    visibleIndices = items.map((_, i) => i);
  } else {
    // Find the active item's position.
    const activeIndex = activeMessageId
      ? items.findIndex((item) => item.targetMessageId === activeMessageId)
      : -1;

    if (activeIndex === -1) {
      // No active item: show first, last, and evenly spread in between.
      const step = Math.ceil(total / MAX_VISIBLE_DOTS);
      visibleIndices = [];
      for (let i = 0; i < total; i += step) visibleIndices.push(i);
      // Always include the last item if not already included.
      if (visibleIndices[visibleIndices.length - 1] !== total - 1) {
        visibleIndices.push(total - 1);
      }
    } else {
      // Always show items around the active one (within windowSize).
      const nearActive = new Set<number>();
      for (
        let i = Math.max(0, activeIndex - windowSize);
        i <= Math.min(total - 1, activeIndex + windowSize);
        i++
      ) {
        nearActive.add(i);
      }
      // Fill remaining slots with evenly-spread indices from the non-near regions.
      const remainingSlots = MAX_VISIBLE_DOTS - nearActive.size;
      const nonNearIndices = items
        .map((_, i) => i)
        .filter((i) => !nearActive.has(i));
      const step = Math.max(1, Math.ceil(nonNearIndices.length / remainingSlots));
      const farIndices: number[] = [];
      for (let i = 0; i < nonNearIndices.length; i += step) {
        farIndices.push(nonNearIndices[i]);
      }
      // Merge and sort: nearActive + farIndices (evenly spread from edges).
      const allVisible = [...nearActive, ...farIndices].sort((a, b) => a - b);
      visibleIndices = allVisible;
    }
  }

  return (
    <nav className="chat-message-navigator" aria-label="Message navigation">
      {items.map((item, index) => {
        const isVisible = visibleIndices.includes(index);
        if (!isVisible) return null;
        return (
          <Button
            key={item.id}
            type="button"
            variant="ghost"
            size="sm"
            className={`chat-message-navigator-dot ${item.targetMessageId === activeMessageId ? 'active' : ''}`}
            onClick={() => onJump(item.targetMessageId)}
            aria-label={`Jump to message ${index + 1}`}
          >
            <span className="chat-message-navigator-mark" aria-hidden="true" />
            <span className="chat-message-navigator-card">
              <span className="chat-message-navigator-title">{item.userPreview}</span>
              <span className="chat-message-navigator-text">{item.assistantPreview}</span>
              {item.files.length > 0 && (
                <span className="chat-message-navigator-files">
                  {item.files.map((file) => (
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
          </Button>
        );
      })}
    </nav>
  );
}

export const MessageList = forwardRef<MessageListRef, MessageListProps>(function MessageList({
  messages,
  isStreaming = false,
  isFinalizing = false,
  onForceStop,
  hasMore = false,
  onLoadMore,
  onScrollStateChange,
  error,
  sessionId,
  onEditSend,
  nextStepSuggestions,
  onNextStepSelect,
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
  // Append-cache for the incremental grouped-message fast path. Holds the
  // last sorted input and its grouped output so an append-only transcript
  // update reuses frozen rows instead of re-grouping from scratch.
  const groupCacheRef = useRef<{ sorted: Message[]; groups: GroupedMessage[] } | null>(null);
  // Ref to always access the latest scrollToBottom without causing useLayoutEffect re-runs
  const scrollToBottomRef = useRef<() => void>(() => {});
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  // True while the user has scrolled away from the bottom — drives the
  // bottom fade overlay (same logic as BotDirectChatView's scroll fade).
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  // Per-session Focus display mode (slash popover toggle).
  const focusMode = useFocusModeStore((s) => selectFocusEnabled(s, sessionId));

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
    setIsScrolledUp(!isNearBottom);
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
      if (autoScrollRef.current) {
        requestAnimationFrame(() => {
          const container = containerRef.current;
          if (!container) return;
          container.scrollTop = container.scrollHeight;
        });
      }
    });

    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  // Sort once so the grouping increment can compare append-only prefixes and
  // reuse frozen rows instead of re-sorting the whole transcript per update.
  const sortedMessages = useMemo(() => sortMessagesForConversation(messages), [messages]);

  // Group assistant messages with their tool results
  // Merge messages from the same round (same seqIndex or consecutive assistant messages)
  const groupedMessages = useMemo<GroupedMessage[]>(() => {
    const cached = groupCacheRef.current;

    // Tail-only fast path: when every message before the last user message
    // is reference-identical to the cached run, those rows are frozen (an
    // appended or content-updated assistant message only ever merges into
    // the round that follows the last user message — never earlier ones).
    // Reuse those rows and re-group only the tail, keeping the common
    // streaming update O(tail round) instead of re-serializing every tool
    // result across the whole transcript. Unlike a strict append test, the
    // common-prefix check also covers in-place tail content updates, which
    // keep the array length constant and previously forced a full re-group
    // on every streaming tick (the "laggy transcript" bug, 2026-09-25).
    if (cached) {
      const lastUserIndex = lastUserIndexSorted(sortedMessages);
      if (lastUserIndex > 0 && commonPrefixLength(cached.sorted, sortedMessages) >= lastUserIndex) {
        const indexOfMsg = new Map<Message, number>();
        sortedMessages.forEach((msg, index) => indexOfMsg.set(msg, index));
        let keepCount = 0;
        let reusable = true;
        for (const group of cached.groups) {
          const index = indexOfMsg.get(group.message);
          if (index === undefined) {
            // Synthetic orphan rows are regenerated per re-group; bail out
            // rather than risk dropping or duplicating them.
            reusable = false;
            break;
          }
          if (index >= lastUserIndex) break;
          keepCount += 1;
        }
        if (reusable) {
          const tailGroups = buildGroupedMessages(sortedMessages.slice(lastUserIndex));
          const groups = [...cached.groups.slice(0, keepCount), ...tailGroups];
          groupCacheRef.current = { sorted: sortedMessages, groups };
          return groups;
        }
      }
    }

    // Any non-trivial change (rewind, edit-and-resend, session switch, or an
    // insertion before the last user message such as a queued turn)
    // re-groups everything from scratch.
    const groups = buildGroupedMessages(sortedMessages);
    groupCacheRef.current = { sorted: sortedMessages, groups };
    return groups;
  }, [sortedMessages, messages]);

  // Only the last user message in the conversation is editable.
  const lastUserMessageId = useMemo(() => {
    for (let i = groupedMessages.length - 1; i >= 0; i -= 1) {
      if (groupedMessages[i].message.role === 'user') {
        return groupedMessages[i].message.id;
      }
    }
    return null;
  }, [groupedMessages]);

  const navigatorCacheRef = useRef<NavigatorCache>(new Map());
  const navigatorItems = useMemo(
    () => buildNavigatorItems(groupedMessages, navigatorCacheRef.current),
    [groupedMessages],
  );

  const shouldRenderStreamingMessage = isStreaming;

  // Plan 447: index of the last user group in the transcript. Assistant
  // rounds after it belong to the turn currently being generated; while
  // `isStreaming`, they render in the live presentation (see LazyMessageRow).
  const activeRunBoundaryIndex = useMemo(() => {
    for (let i = groupedMessages.length - 1; i >= 0; i--) {
      if (groupedMessages[i].message.role === 'user') return i;
    }
    return -1;
  }, [groupedMessages]);

  // Plan 532: count user messages added while the user is scrolled away
  // from the bottom. Drives the unread badge on the jump-to-latest button
  // so the user knows how many new turns have landed since they froze.
  const [unreadTurns, setUnreadTurns] = useState(0);
  const lastSeenUserCountRef = useRef(0);

  // Keep the counter in sync with the actual user-message count.
  useEffect(() => {
    const totalUsers = groupedMessages.filter((g) => g.message.role === 'user').length;
    const seen = lastSeenUserCountRef.current;
    if (totalUsers > seen) {
      // If the user is at the bottom, the new turn is already visible — no badge.
      if (autoScrollRef.current) {
        lastSeenUserCountRef.current = totalUsers;
        if (unreadTurns !== 0) setUnreadTurns(0);
      } else {
        const delta = totalUsers - seen;
        lastSeenUserCountRef.current = totalUsers;
        setUnreadTurns((prev) => prev + delta);
      }
    } else if (totalUsers < seen) {
      // Session switch / rewind resets both refs and the badge.
      lastSeenUserCountRef.current = totalUsers;
      if (unreadTurns !== 0) setUnreadTurns(0);
    }
  }, [groupedMessages, unreadTurns]);

  const handleJumpToLatest = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    autoScrollRef.current = true;
    setIsScrolledUp(false);
    setUnreadTurns(0);
  }, []);

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
      navigatorCacheRef.current.clear();
      lastActiveNavUpdateRef.current = 0;
      lastSeenUserCountRef.current = 0;
      setUnreadTurns(0);
      setActiveMessageId(null);
      setIsInitialLoading(true);
    }
  }, [sessionId]);

  const updateActiveMessage = useCallback(() => {
    const container = containerRef.current;
    if (!container || navigatorItems.length === 0) return;

    const containerTop = container.getBoundingClientRect().top;
    const readingLineOffset = 180; // reading position inside the message list viewport
    let bestId: string | null = null;

    for (const item of navigatorItems) {
      const el = document.getElementById(`message-row-${sessionId}-${item.targetMessageId}`);
      if (!el || !container.contains(el)) continue;
      const top = el.getBoundingClientRect().top - containerTop;
      if (bestId === null) bestId = item.targetMessageId;
      if (top <= readingLineOffset) {
        bestId = item.targetMessageId;
      } else {
        break;
      }
    }

    if (bestId === null) return;
    setActiveMessageId(prev => (prev === bestId ? prev : bestId));
  }, [navigatorItems, sessionId]);

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

    const target = document.getElementById(`message-row-${sessionId}-${messageId}`);
    if (target && container.contains(target)) {
      const el = target;
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      setActiveMessageId(messageId);
      autoScrollRef.current = false;
    }
  }, [sessionId]);

  // Scroll to bottom (exposed to parent)
  const scrollToBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    autoScrollRef.current = true;
  }, []);

  // Keep ref in sync so useLayoutEffect below always calls the latest
  useEffect(() => {
    scrollToBottomRef.current = scrollToBottom;
  }, [scrollToBottom]);

  // Plan 532: Scroll to bottom when messages are first loaded.
  //
  // Two timing hazards force us to do this in stages instead of one shot:
  //
  //   1. LazyMessageRow (line ~320) uses IntersectionObserver + the
  //      `contentVisibility: auto` placeholder. At mount time only the
  //      trailing `ALWAYS_RENDER_TRAILING_ROWS` rows are in the DOM, so
  //      `container.scrollHeight` is far smaller than the eventual height
  //      of the full transcript.
  //   2. The IO callback fires asynchronously (microtask + next frame) and
  //      each newly-realised row mutates `scrollHeight`. Without a follow-up
  //      scroll, the user lands partway up and the rest of the rows render
  //      above the visible area — which is exactly the "scrolls to top and
  //      you can't scroll down" complaint that motivates this plan.
  //
  // Strategy: do the synchronous jump immediately so the user sees content
  // pinned to the bottom on the first frame, then schedule one rAF follow-up
  // to catch the rows that IO realised after commit. The follow-up is gated
  // by `autoScrollRef` so it never fights a user who is actively scrolling.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (messages.length > 0 && !hasScrolledOnMountRef.current) {
      hasScrolledOnMountRef.current = true;
      // Synchronous first paint — place the visible content at the bottom.
      container.scrollTop = container.scrollHeight;
      autoScrollRef.current = true;
      setIsInitialLoading(false);

      // rAF follow-up: catch LazyMessageRow IO callbacks that landed after
      // commit. We re-read scrollHeight on the next frame and, if the user
      // is still pinned to the bottom, snap to the new bottom. Idempotent —
      // ResizeObserver continues to handle streaming growth past this point.
      const rafId = requestAnimationFrame(() => {
        const el = containerRef.current;
        if (!el || !autoScrollRef.current) return;
        el.scrollTop = el.scrollHeight;
      });
      return () => cancelAnimationFrame(rafId);
    }
    return undefined;
  }, [messages.length]);

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

    // Plan 532: aligned with BotDirectChatView (plan 491 P0.4) — never use
    // `scrollIntoView({ block: 'nearest' })` to "rescue" the viewport when the
    // user is scrolled away. That call scrolls the container so the target
    // sits at the nearest viewport edge, which the user perceives as the
    // list jumping several hundred pixels upward. Instead:
    //   - If user is at the bottom (`autoScrollRef === true`), just snap down.
    //   - If user is scrolled away, do nothing — they have the jump-to-latest
    //     button (and unread badge) to come back on their own terms.
    if (messages.length > prevMessagesLengthRef.current) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.role === 'user') {
        // Record the user-message id so the counter stays monotonic across
        // re-renders; no scroll action here.
        userMessageIdRef.current = lastMsg.id;
      } else if (autoScrollRef.current) {
        // Non-user (assistant/tool) delta — only follow if user is already
        // pinned to the bottom.
        scrollToBottom();
      }
    }

    // Streaming just started — scroll to bottom
    if (isStreaming && !wasStreamingRef.current) {
      scrollToBottom();
    }

    prevMessagesLengthRef.current = messages.length;
    wasStreamingRef.current = isStreaming;
  }, [messages, isStreaming, scrollToBottom, sessionId]);



  return (
    <div className="relative h-full isolate">
    <div ref={containerRef} className="message-list-scroll h-full overflow-y-auto pb-32 scrollbar-thin">
      <ChatMessageNavigator
        items={navigatorItems}
        activeMessageId={activeMessageId}
        onJump={scrollToMessage}
      />

      {hasMore && (
        <div className="flex justify-center p-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={onLoadMore}
            className="hover:bg-muted/30"
          >
            Load earlier messages
          </Button>
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
            rowDomId={`message-row-${sessionId}-${group.message.id}`}
            isAlwaysRendered={index >= groupedMessages.length - ALWAYS_RENDER_TRAILING_ROWS}
            cachedHeight={rowHeightsRef.current.get(group.message.id)}
            onHeightChange={handleRowHeightChange}
            isEditable={group.message.role === 'user' && group.message.id === lastUserMessageId}
            onEditSend={onEditSend}
            focusMode={focusMode}
            // Plan 447: rounds after the last user message belong to the turn
            // being streamed — render them in the live presentation so a
            // mid-run refresh doesn't snap them to the collapsed final state.
            isLiveRun={isStreaming && index > activeRunBoundaryIndex}
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

        {shouldRenderStreamingMessage && (
          <StreamingMessage
            sessionId={sessionId}
            onForceStop={onForceStop}
            isFinalizing={isFinalizing}
          />
        )}

        {/* Live workflow run cards — plan 552: rendered inline at the tail of
            the current turn so a run launched by the assistant shows its
            ZCode-style card in-stream. Renders nothing when no run is active. */}
        <WorkflowRunStream sessionId={sessionId} />

        {/* Compaction status is rendered inline where it happened via the
            live streaming `compact` action row (and durably via the
            persisted `isCompactSummary` message). */}

        {/* End-of-turn next-step suggestion cards */}
        {!isStreaming && onNextStepSelect && nextStepSuggestions && nextStepSuggestions.length > 0 && (
          <NextStepSuggestions
            suggestions={nextStepSuggestions}
            onSelect={onNextStepSelect}
          />
        )}
      </div>
    </div>

    {/* Bottom fade — dissolves the scroll boundary while scrolled up
        (BotDirectChatView parity). Sibling of the scroll container so it
        stays pinned to the visible bottom edge and never blocks clicks. */}
    {isScrolledUp && (
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 z-30 h-14 bg-gradient-to-t from-[var(--main-bg)] to-transparent animate-in fade-in duration-200"
      />
    )}

    {/* Jump-to-latest button — appears when the user is scrolled away from
        the bottom. Mirrors BotDirectChatView's `.bot-chat-jump-to-latest`
        so the two transcript UIs feel identical. The optional unread badge
        shows how many user turns landed while the user was frozen. */}
    {isScrolledUp && (
      <button
        type="button"
        onClick={handleJumpToLatest}
        className="absolute bottom-4 left-1/2 -translate-x-1/2 z-40 inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-solid)] px-3 py-1.5 text-xs font-medium text-[var(--muted)] shadow-sm hover:bg-[var(--surface-hover)] hover:text-[var(--text)] transition-colors animate-in fade-in slide-in-from-bottom-2 duration-200"
        aria-label="Jump to latest message"
      >
        <ChevronDownIcon size={14} strokeWidth={2.25} />
        <span>Jump to latest</span>
        {unreadTurns > 0 && (
          <span
            className="ml-0.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[10px] font-semibold text-white"
            aria-label={`${unreadTurns} new turn${unreadTurns === 1 ? '' : 's'}`}
          >
            {unreadTurns > 99 ? '99+' : unreadTurns}
          </span>
        )}
      </button>
    )}
    </div>
  );
});
