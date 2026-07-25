import { useEffect, useRef, useState } from 'react';
import { subscribeToStreamingEvents, type StreamingEvent } from '@/lib/stream-session-manager';
import type { ActionItem } from '@/components/chat/ToolActionsGroup';

function streamingEventsToActions(events: StreamingEvent[]): ActionItem[] {
  const actions: ActionItem[] = [];

  // Pre-pass: build an id -> tool_result map so the tool_use branch can
  // look up its matching result in O(1) instead of O(n) per use (which
  // was the dominant cost during multi-tool streaming turns — see
  // plan 236 Phase 1).
  const toolResultById = new Map<string, Extract<StreamingEvent, { type: 'tool_result' }>['toolResult']>();
  for (const event of events) {
    if (event.type === 'tool_result') {
      toolResultById.set(event.toolResult.tool_use_id, event.toolResult);
    }
  }

  for (const event of events) {
    switch (event.type) {
      case 'text':
        // Each text event's `content` is the local text accumulated since
        // the last non-text event (see stream-session-manager — it appends
        // deltas to the trailing text event and only creates a new one when
        // a non-text event arrives in between). Push it through so the
        // renderer can interleave text and tool calls in chronological
        // order; the cumulative text rendering path is removed in
        // StreamingMessage and TextRow applies typewriter on the last
        // block to keep the streaming pacing smooth.
        if (event.content) {
          actions.push({ kind: 'text', content: event.content });
        }
        break;
      case 'thinking':
        if (event.content.trim()) {
          actions.push({ kind: 'thinking', content: event.content, isStreaming: true });
        }
        break;
      case 'tool_use': {
        const toolUseId = event.toolUse.id;
        const resultInfo = toolResultById.get(toolUseId);
        actions.push({
          kind: 'tool',
          tool: {
            id: event.toolUse.id,
            name: event.toolUse.name,
            input: event.toolUse.input,
            result: resultInfo?.content,
            isError: resultInfo?.is_error,
            durationMs: resultInfo?.duration_ms,
            // Forward tool result metadata so dedicated row components
            // (ScreenshotToolRow, VisionToolRow) can render previews.
            metadata: resultInfo?.metadata,
          },
        });
        break;
      }
      case 'tool_result':
        // Skip standalone tool_results that were already paired with tool_use
        break;
      case 'viz':
        if (event.content.trim()) {
          actions.push({ kind: 'widget', content: event.content });
        }
        break;
    }
  }

  return actions;
}

export function useStreamingActions(sessionId: string): ActionItem[] {
  const [actions, setActions] = useState<ActionItem[]>([]);
  // Text and thinking deltas mutate the trailing StreamingEvent in place.
  // Keep the newest snapshot and derive actions at most once per animation
  // frame: reference equality cannot tell whether an in-place event changed.
  const latestEventsRef = useRef<StreamingEvent[] | null>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    // Reset on sessionId change so a new session starts fresh.
    latestEventsRef.current = null;
    setActions([]);

    const flush = () => {
      frameRef.current = null;
      const events = latestEventsRef.current;
      if (events) {
        setActions(streamingEventsToActions(events));
      }
    };

    const scheduleFlush = () => {
      if (frameRef.current !== null) return;
      if (typeof requestAnimationFrame === 'undefined') {
        flush();
        return;
      }
      frameRef.current = requestAnimationFrame(flush);
    };

    const unsubscribe = subscribeToStreamingEvents(sessionId, (events) => {
      latestEventsRef.current = events;
      scheduleFlush();
    });

    return () => {
      unsubscribe();
      if (frameRef.current !== null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(frameRef.current);
      }
      frameRef.current = null;
    };
  }, [sessionId]);

  return actions;
}
