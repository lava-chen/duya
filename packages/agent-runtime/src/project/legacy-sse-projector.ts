/**
 * The projector: a protocol `RunEventEnvelope` back out to the legacy `{ type,
 * data }` frame the product UI already parses.
 *
 * ## This module is the reason the UI does not change
 *
 * The renderer has never heard of `@duya/agent-protocol`. It reads
 * `event.data.content` off an SSE frame whose `type` is one of the strings in
 * `legacy-sse-contract.ts`. Introducing a run layer underneath it would change
 * every one of those strings — unless the run layer projects the protocol
 * events straight back onto the legacy vocabulary on the way out.
 *
 * So this is a total function in the sense that matters: for every event the
 * run produces, the frame the renderer sees is the frame it saw before. The
 * test asserts that property directly, event by event, rather than asserting
 * that the mapping table "looks right".
 *
 * ## Direction matters
 *
 * This is a LOSSY, MANY-TO-ONE projection and it is not invertible. The
 * protocol is strictly more expressive than the legacy union — a run has
 * identity, sequence numbers, and a durable/volatile/ephemeral split that the
 * wire never had. That is fine, and it is the correct direction: the protocol
 * is the record, the legacy frame is the view. What would NOT be fine is
 * deriving the protocol events FROM the legacy frames, because then the durable
 * log would be limited to what the UI happened to display.
 *
 * ## Events with no legacy frame
 *
 * Several protocol events have no predecessor — `run.started`,
 * `turn.completed`, `permission.resolved`, `checkpoint.saved`. They are
 * projected to `null`, which the caller drops. They are NOT smuggled onto a
 * neighbouring event's frame: the UI has no place to put them, and a host that
 * renders an event it does not understand is a host that will render it wrong.
 * They live in `run_events`, which is where the durable truth is.
 */

import type { RunEventEnvelope } from '@duya/agent-protocol';
import type { LegacySseFrame } from '../legacy-sse-contract.js';

/**
 * Project one envelope onto a legacy frame.
 *
 * @returns The frame to write to the SSE stream, or `null` when the event has
 *   no legacy counterpart and must simply not reach the UI.
 */
export function projectToLegacyFrame(
  envelope: RunEventEnvelope,
): LegacySseFrame | null {
  // Narrowing happens on `envelope.payload.type` directly. Destructuring the
  // discriminant off first would erase it, and every arm below would then
  // reach for a field its own variant does not have — the union stops doing
  // the one job it exists to do.
  const event = envelope.payload;
  const { type } = event;

  switch (type) {
    case 'assistant.text_block':
      // `data.content`, NOT `data`. The declared `@duya/ai` union says
      // `data: string`; the router has always sent `data.content` and the
      // renderer has always read `data.content`. Both are wrong in the union
      // and right on the wire, and this is the wire.
      return { type: 'text', data: { content: event.text } };

    case 'assistant.text_delta':
      return { type: 'text_delta', data: { content: event.delta } };

    case 'assistant.thinking_block':
      return { type: 'thinking', data: { content: event.thinking } };

    case 'assistant.thinking_delta':
      return { type: 'thinking_delta', data: { content: event.delta } };

    case 'tool.call_preview':
      return {
        type: 'tool_use_started',
        data: {
          id: event.toolCallId,
          name: event.toolName,
          input: event.arguments,
        },
      };

    case 'tool.arguments_delta':
      return {
        type: 'tool_use_delta',
        data: { id: event.toolCallId, name: '', delta: event.delta },
      };

    case 'tool.call_started':
      return {
        type: 'tool_use',
        data: {
          id: event.toolCallId,
          name: event.toolName,
          input: event.arguments,
          groupId: event.groupId,
          progressTitle: event.progressTitle,
          progressSource: event.progressSource,
        },
      };

    case 'tool.call_completed':
      return {
        type: 'tool_result',
        data: {
          id: event.toolCallId,
          result: event.content,
          // The legacy wire's `error?: boolean` cannot express
          // `indeterminate`, and inventing `false` would report a tool whose
          // status nobody stated as successful. Omitting the key is the honest
          // encoding: the renderer already treats a missing flag as "no
          // error", and a `true` is preserved exactly when the producer said so.
          ...(event.outcome.outcome === 'tool_error' ? { error: true } : {}),
          ...(event.outcome.outcome === 'success' ? { error: false } : {}),
          duration_ms: event.durationMs,
        },
      };

    case 'tool.progress':
      return {
        type: 'tool_progress',
        data: { toolName: event.toolCallId, elapsedSeconds: event.elapsedMs / 1000 },
      };

    case 'tool.group_progress':
      return {
        type: 'tool_group_progress',
        data: { groupId: event.groupId, title: event.title, source: event.source },
      };

    case 'permission.requested':
      return {
        type: 'permission',
        data: {
          requestId: event.requestId,
          toolName: event.toolName,
          toolInput: event.toolInput,
          reason: event.reason,
          blockedPath: event.blockedPath,
        },
      };

    case 'turn.started':
      return { type: 'turn_start', data: { turnCount: event.index } };

    case 'assistant.usage':
      return {
        type: 'token_usage',
        data: {
          input_tokens: event.usage.inputTokens,
          output_tokens: event.usage.outputTokens,
          total_tokens: event.usage.totalTokens,
        },
      };

    case 'assistant.status':
      return { type: 'status', data: { message: event.message } };

    case 'turn.retry_scheduled':
      return {
        type: 'retry',
        data: {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          message: event.reason,
        },
      };

    case 'assistant.mode_changed':
      return {
        type: 'mode_changed',
        data: { mode: event.mode, source: event.source, reason: event.reason },
      };

    case 'assistant.goal_updated':
      // The legacy frame is the flat payload with the transport `type` removed
      // — `router.ts:548`. Every field the producer sent is preserved, because
      // the renderer reads `pauseMessage` and `totalWorkerRounds` from it and
      // neither can be reconstructed from the rest.
      return {
        type: 'goal_updated',
        data: {
          state: event.state,
          phase: event.phase,
          objective: event.objective,
          tokensUsed: event.tokensUsed,
          tokenBudget: event.tokenBudget,
          consecutiveNotAchieved: event.consecutiveNotAchieved,
          gapsSummary: event.gapsSummary,
          strategyProposal: event.strategyProposal,
          pauseMessage: event.pauseMessage,
          pauseReason: event.pauseReason,
          totalWorkerRounds: event.totalWorkerRounds,
          totalVerifyRounds: event.totalVerifyRounds,
          elapsedMs: event.elapsedMs,
        },
      };

    case 'compaction.started':
      return { type: 'compact:start', data: {} };

    case 'compaction.completed':
      return {
        type: 'compact:done',
        data: {
          strategy: event.strategy,
          tokensRemoved: event.tokensRemoved,
          tokensRetained: event.tokensRetained,
          removedCount: event.removedCount,
        },
      };

    case 'compaction.failed':
      return { type: 'compact:error', data: { message: event.error.message } };

    case 'compaction.step':
      return {
        type: 'compact:step',
        data: {
          step: event.phase,
          phase: event.phase,
          messageCount: event.messageCount,
          tokensBefore: event.tokensBefore,
          tokensEstimated: event.tokensEstimated,
          filesCached: event.filesCached,
        },
      };

    case 'compaction.over_threshold':
      return {
        type: 'compact:over_threshold',
        data: { tokensRetained: event.tokensRetained, available: event.available },
      };

    case 'subagent.started':
      return {
        type: 'agent_progress',
        data: {
          agentEventType: 'subagent_started',
          subagentId: event.subagentId,
          toolCallId: event.parentToolCallId,
          agentType: event.agentType,
          agentName: event.agentName,
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
          summary: event.summary,
        },
      };

    case 'hook.invoked':
      return {
        type: 'agent_progress',
        data: {
          agentEventType: event.agentEventType,
          hookEventName: event.hookEventName,
          hookType: event.hookType,
          hookName: event.hookName,
          matcher: event.matcher,
          data: event.data,
          exitCode: event.exitCode,
          async: event.async,
          backgroundTaskId: event.backgroundTaskId,
          durationMs: event.durationMs,
          status: event.status,
          errorMessage: event.errorMessage,
          toolName: event.toolName,
        },
      };

    case 'run.completed':
      return { type: 'done', data: { reason: event.stopReason } };

    case 'run.failed':
      return {
        type: 'error',
        data: { message: event.error.message, code: event.error.code },
      };

    // ── no legacy counterpart ──────────────────────────────────────────
    //
    // `run.started` is the load-bearing one: it is the event that carries the
    // manifest hash, and the UI has no frame for it. It belongs in `run_events`
    // and in nothing the renderer sees.
    case 'run.started':
    case 'run.paused':
    case 'turn.completed':
    case 'assistant.message_finalized':
    case 'permission.resolved':
    case 'permission.expired':
    case 'checkpoint.saved':
    case 'tool.timed_out':
    case 'diagnostic':
    case 'diagnostic.trace':
    case 'extension.custom':
      return null;

    default:
      // Unknown namespaces must be ignored rather than guessed at, and this
      // arm is reachable only if the protocol adds an event type without
      // updating this switch — which the exhaustive `switch` above is designed
      // to make a compile error rather than a silent drop.
      return null;
  }
}
