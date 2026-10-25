import type {
  RunEvent,
  RunEventEnvelope,
  RunId,
  SessionId,
} from '@duya/agent-protocol';
import type { LegacyFrame } from './blocks.js';

/**
 * Project one Host event into the frame vocabulary consumed by the CLI TUI.
 *
 * ## Why `messageId` and `index` are carried through
 *
 * A text or thinking BLOCK is not the same thing as the turn it arrives in.
 * One assistant message contains several content blocks — text, a tool call,
 * more text — and the Host already stamps each one with `messageId` + `index`.
 * Projecting that away left the view with nothing to tell blocks apart except
 * arrival order, which is why the TUI used to merge every sentence of a turn
 * into one block and let tool lines land above text written after them.
 *
 * So the identity is carried into `frame.data`, and `TranscriptModel` keys its
 * blocks on it. `blocks.ts` owns the fallback for frames that carry no key.
 */
export function projectHostEvent(event: RunEvent): LegacyFrame | null {
  switch (event.type) {
    case 'assistant.text_delta':
      return {
        type: 'text_delta',
        data: { content: event.delta, messageId: event.messageId, index: event.index },
      };
    case 'assistant.text_block':
      return {
        type: 'text',
        data: { content: event.text, messageId: event.messageId, index: event.index },
      };
    case 'assistant.thinking_delta':
      return {
        type: 'thinking_delta',
        data: { content: event.delta, messageId: event.messageId, index: event.index },
      };
    case 'assistant.thinking_block':
      return {
        type: 'thinking',
        data: { content: event.thinking, messageId: event.messageId, index: event.index },
      };
    case 'assistant.status':
      return { type: 'status', data: { message: event.message } };
    case 'turn.started':
      // `effort` rides the turn envelope because it is decided per run, not per
      // session. The TUI paints the composer border with it, so dropping it here
      // would leave the border claiming the previous turn's level.
      return {
        type: 'turn_start',
        data: {
          turnCount: event.index,
          ...(event.effort === undefined ? {} : { effort: event.effort }),
        },
      };
    case 'tool.progress':
      return { type: 'tool_progress', data: { toolName: event.toolCallId, elapsedSeconds: event.elapsedMs / 1000, title: event.title } };
    case 'tool.group_progress':
      return { type: 'tool_group_progress', data: { groupId: event.groupId, title: event.title, source: event.source } };
    case 'permission.requested':
      return { type: 'permission', data: { requestId: event.requestId, toolName: event.toolName, toolInput: event.toolInput, reason: event.reason, mode: event.mode, blockedPath: event.blockedPath, expiresAt: event.expiresAt } };
    case 'assistant.usage':
      return {
        type: 'token_usage',
        data: {
          input_tokens: event.usage.inputTokens,
          output_tokens: event.usage.outputTokens,
          total_tokens: event.usage.totalTokens,
          // The physical duration of the provider request, when the provider
          // measured one. It is what makes the output rate derivable: a
          // consumer cannot reconstruct the elapsed time from chunk
          // timestamps, because those may be buffered. OMITTED rather than
          // zeroed when absent -- a zero would divide by zero downstream.
          ...(event.usage.requestDurationMs === undefined
            ? {}
            : { request_duration_ms: event.usage.requestDurationMs }),
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
    case 'tool.call_completed': {
      const outcome = event.outcome.outcome;
      return {
        type: 'tool_result',
        data: {
          id: event.toolCallId,
          result: event.content,
          error: outcome !== 'success' && outcome !== 'indeterminate',
          indeterminate: outcome === 'indeterminate',
        },
      };
    }
    case 'run.failed':
      return {
        type: 'error',
        data: { message: event.error.message, code: event.error.code },
      };
    // A subagent runs behind one parent tool call and can outlive it by
    // minutes. `agent_progress` is the frame the TUI already understands
    // (`ActivityTracker` for the chrome label, `BackgroundTaskModel` for the
    // task list), so the durable events map onto that vocabulary instead of
    // inventing a second one.
    case 'subagent.started':
      return {
        type: 'agent_progress',
        data: {
          agentEventType: 'subagent_started',
          subagentId: event.subagentId,
          agentName: event.agentName,
          agentType: event.agentType,
          parentToolCallId: event.parentToolCallId,
          ...(event.agentDescription === undefined ? {} : { agentDescription: event.agentDescription }),
        },
      };
    case 'subagent.completed':
      return {
        type: 'agent_progress',
        data: {
          agentEventType: 'subagent_completed',
          subagentId: event.subagentId,
          status: event.status,
          durationMs: event.durationMs,
          ...(event.summary === undefined ? {} : { summary: event.summary }),
        },
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
  private turnId = 'initial';

  constructor(
    private readonly sessionId: SessionId,
    private readonly runId: RunId,
  ) {}

  push(envelope: RunEventEnvelope): LegacyFrame | null {
    if (envelope.sessionId !== this.sessionId || envelope.runId !== this.runId) return null;
    if (!Number.isSafeInteger(envelope.seq) || envelope.seq <= this.lastSeq) return null;

    this.lastSeq = envelope.seq;
    const event = envelope.payload;
    if (event.type === 'turn.started') this.turnId = event.turnId;
    // Legacy Host frames reuse one message ID and index zero for every model
    // call. Scope that identity by the accepted turn without changing the wire.
    if (event.type === 'assistant.text_delta' || event.type === 'assistant.text_block'
      || event.type === 'assistant.thinking_delta' || event.type === 'assistant.thinking_block') {
      return projectHostEvent({ ...event, messageId: JSON.stringify([this.runId, this.turnId, event.messageId]) });
    }
    return projectHostEvent(event);
  }
}
