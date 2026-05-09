import { useEffect, useState } from 'react';
import { subscribeToStreamingEvents, type StreamingEvent } from '@/lib/stream-session-manager';
import type { ActionItem } from '@/components/chat/ToolActionsGroup';

function streamingEventsToActions(events: StreamingEvent[]): ActionItem[] {
  const actions: ActionItem[] = [];

  for (const event of events) {
    switch (event.type) {
      case 'text':
        // NOTE: We intentionally skip text events in streaming mode.
        // Text is rendered as a single continuous block via useStreamingText
        // to avoid markdown fragmentation when text is split by thinking/tool events.
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
