import type {
  RunEvent,
  RunEventEnvelope,
  RunId,
  SessionId,
} from '@duya/agent-protocol';
import type { LegacyFrame } from './blocks.js';

/** Project one Host event into the frame vocabulary consumed by the CLI TUI. */
export function projectHostEvent(event: RunEvent): LegacyFrame | null {
  switch (event.type) {
    case 'assistant.text_delta':
      return { type: 'text_delta', data: { content: event.delta } };
    case 'assistant.text_block':
      return { type: 'text', data: { content: event.text } };
    case 'assistant.thinking_delta':
      return { type: 'thinking_delta', data: { content: event.delta } };
    case 'assistant.thinking_block':
      return { type: 'thinking', data: { content: event.thinking } };
    case 'assistant.status':
      return { type: 'status', data: { message: event.message } };
    case 'assistant.usage':
      return {
        type: 'token_usage',
        data: {
          input_tokens: event.usage.inputTokens,
          output_tokens: event.usage.outputTokens,
          total_tokens: event.usage.totalTokens,
        },
      };
    case 'tool.call_preview':
      return {
        type: 'tool_use_started',
        data: { id: event.toolCallId, name: event.toolName, input: event.arguments },
      };
    case 'tool.call_started':
      return {
        type: 'tool_use',
        data: { id: event.toolCallId, name: event.toolName, input: event.arguments },
      };
    case 'tool.call_completed':
      return {
        type: 'tool_result',
        data: {
          id: event.toolCallId,
          result: event.content,
          error: event.outcome.outcome !== 'success',
        },
      };
    case 'run.failed':
      return {
        type: 'error',
        data: { message: event.error.message, code: event.error.code },
      };
    case 'run.completed':
      return { type: 'done', data: { reason: event.stopReason ?? event.status } };
    default:
      return null;
  }
}

/**
 * Projects only events belonging to one Host run and rejects replayed or
 * out-of-order envelopes. Sequence acceptance happens before projection so
 * unhandled events still advance the deduplication cursor.
 */
export class HostEventStream {
  private lastSeq = 0;

  constructor(
    private readonly sessionId: SessionId,
    private readonly runId: RunId,
  ) {}

  push(envelope: RunEventEnvelope): LegacyFrame | null {
    if (envelope.sessionId !== this.sessionId || envelope.runId !== this.runId) return null;
    if (!Number.isSafeInteger(envelope.seq) || envelope.seq <= this.lastSeq) return null;

    this.lastSeq = envelope.seq;
    return projectHostEvent(envelope.payload);
  }
}
