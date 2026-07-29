/**
 * packages/ai/src/api/emit-sse.ts
 *
 * Downgrades internal AssistantMessageEvent to the public SSEEvent wire format.
 *
 * Spec §6.7: The internal events carry partial AssistantMessage state (for
 * signature accumulation), but consumers (DuyaAgent, agent-process-entry)
 * only understand SSEEvent. This mapping is the ONLY place where the two
 * event systems meet.
 */

import type { AssistantMessageEvent, SSEEvent } from '../types.js';

export function emitSSE(internalEvent: AssistantMessageEvent): SSEEvent | null {
  switch (internalEvent.type) {
    case 'text_delta':
      return { type: 'text_delta', data: internalEvent.delta };
    case 'text_end':
      return { type: 'text', data: internalEvent.content };
    case 'thinking_delta':
      return { type: 'thinking_delta', data: internalEvent.delta };
    case 'thinking_end':
      return { type: 'thinking', data: internalEvent.content };
    case 'toolcall_start': {
      const block = internalEvent.partial.content[internalEvent.contentIndex];
      if (block && block.type === 'tool_use') {
        return {
          type: 'tool_use_started',
          data: { id: block.id, name: block.name, input: block.input },
        };
      }
      return null;
    }
    case 'toolcall_end':
      return {
        type: 'tool_use',
        data: {
          id: internalEvent.toolCall.id,
          name: internalEvent.toolCall.name,
          input: internalEvent.toolCall.input,
        },
      };
    case 'done':
      return { type: 'done', reason: internalEvent.reason };
    case 'error':
      return { type: 'error', data: internalEvent.reason, code: undefined };
    // start / text_start / thinking_start / toolcall_delta → no SSEEvent
    default:
      return null;
  }
}
