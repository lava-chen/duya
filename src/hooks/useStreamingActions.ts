import { useEffect, useState } from 'react';
import { subscribeToStreamingEvents, type StreamingEvent } from '@/lib/stream-session-manager';
import type { ActionItem } from '@/components/chat/ToolActionsGroup';

function streamingEventsToActions(events: StreamingEvent[]): ActionItem[] {
  const actions: ActionItem[] = [];

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
        // Find matching tool_result in subsequent events
        const toolUseId = event.toolUse.id;
        const resultEvent = events.find(
          (e): e is Extract<StreamingEvent, { type: 'tool_result' }> =>
            e.type === 'tool_result' && e.toolResult.tool_use_id === toolUseId
        );
        actions.push({
          kind: 'tool',
          tool: {
            id: event.toolUse.id,
            name: event.toolUse.name,
            input: event.toolUse.input,
            result: resultEvent?.toolResult.content,
            isError: resultEvent?.toolResult.is_error,
            durationMs: resultEvent?.toolResult.duration_ms,
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

  useEffect(() => {
    const unsubscribe = subscribeToStreamingEvents(sessionId, (events) => {
      setActions(streamingEventsToActions(events));
    });
    return unsubscribe;
  }, [sessionId]);

  return actions;
}
