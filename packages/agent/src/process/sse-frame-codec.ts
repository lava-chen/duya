/**
 * The SSE-to-worker-frame codec, extracted so there is exactly ONE of them.
 *
 * ## Why this is a module and not a function inside the worker entry
 *
 * `agent-process-entry.ts` used to own this mapping privately. That was fine
 * while the worker process was the only thing that had to speak the legacy
 * `chat:*` frame vocabulary. Plan 587 H8.1 added a second caller — the headless
 * run host, which drives `DuyaAgent` in process and therefore produces the same
 * `SSEEvent` stream the worker consumes — and the two options at that point
 * were:
 *
 *  - copy the function, and have the in-process path drift from the subprocess
 *    path the first time somebody added a frame type to one of them; or
 *  - extract it, and have both callers share one vocabulary.
 *
 * The second is the only one that keeps the T3.5 equivalence claim meaningful.
 * The equivalence test proves the three transports deliver the same RUN; it
 * says nothing about two different frame producers, and a second producer is
 * precisely the case it would not catch.
 *
 * ## What is deliberately NOT here
 *
 * No state, no run identity, no sequencing, no terminal decision. This is a
 * pure function from one event shape to one frame shape, and it is the reason
 * the headless host can be a host ADAPTER: the vocabulary it speaks is the
 * worker's, so the runtime sees the frames it has always seen.
 */

import { logger } from '../utils/logger.js';
import type { SubagentAgentEventType } from './worker-protocol.js';

/**
 * One event off the agent's `streamChat` generator.
 *
 * Structurally typed rather than importing `SSEEvent`: the generator's declared
 * union is a lie about two of its own variants (see
 * `agent-protocol/src/legacy/sse-event.ts`), and every read below is total, so a
 * narrower type here would only push casts to the call sites.
 */
export interface AgentStreamEvent {
  readonly type: string;
  readonly data?: unknown;
  /**
   * Producers attach fields the declared union does not name -- `metadata` on
   * `system`, for instance. The index signature is what lets the rest-spread
   * arms below destructure the event, and it is the same openness the inline
   * parameter type this function was extracted from had. Narrowing it would
   * have meant either casts at those arms or dropping the fields they forward.
   *
   * It is NOT a licence to read a payload off the top level: `done` and
   * `error` carry theirs inside `data`, and reading `event.reason` /
   * `event.code` from here returned `undefined` for every frame the real
   * producer ever minted. See `readPayloadString`.
   */
  readonly [field: string]: unknown;
}

/**
 * Read one string field off a legacy frame's `data` payload.
 *
 * The legacy wire carries a frame's payload INSIDE `data` -- `{ type, data }`,
 * which is the shape `LegacySseFrame` declares and the shape every agent-server
 * client already parses. So `done` and `error` are read here rather than off the
 * frame's top level, and the value is NARROWED because `data` is `unknown`: a
 * bare `as string` would turn "the payload is an object" into a lie the type
 * system could not catch.
 */
function readPayloadString(data: unknown, field: string): string | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const value = (data as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Map one agent event onto the legacy worker frame, or `null` to drop it.
 *
 * `null` is a real answer, used for events the wire has no place for (the LLM
 * usage `result` frame is consumed by the caller's accounting before this runs,
 * and several research-internal snapshots are debug-only). It is never a
 * silent catch-all: the default arm logs the unknown type rather than
 * pretending the event did not exist.
 */
export function convertSSEToAgentMessage(event: AgentStreamEvent): Record<string, unknown> | null {
  switch (event.type) {
    case 'text':
      return { type: 'chat:text', content: event.data as string };
    case 'thinking': {
      // Signature-only thinking events (empty data) carry no renderable
      // content — emitting them would create empty chat:thinking rows.
      const content = typeof event.data === 'string' ? event.data : '';
      if (!content) return null;
      return { type: 'chat:thinking', content };
    }
    case 'tool_use_started':
      return {
        type: 'chat:tool_use_started',
        id: (event.data as { id: string }).id,
        name: (event.data as { name: string }).name,
        input: (event.data as { input?: unknown }).input,
        groupId: (event.data as { groupId?: string }).groupId,
        progressTitle: (event.data as { progressTitle?: string }).progressTitle,
        progressSource: (event.data as { progressSource?: string }).progressSource,
      };
    // Plan 461: incremental argument fragment for a tool call still being
    // generated. `delta` is a raw JSON slice — the renderer accumulates it
    // per tool_use id so the row can render partial file content live.
    case 'tool_use_delta':
      return { type: 'chat:tool_use_delta', id: (event.data as { id: string }).id, name: (event.data as { name: string }).name, delta: (event.data as { delta: string }).delta };
    case 'tool_group_progress':
      return {
        type: 'chat:tool_group_progress',
        groupId: (event.data as { groupId?: string }).groupId,
        title: (event.data as { title: string }).title,
        source: (event.data as { source?: string }).source,
      };
    case 'tool_use':
      return {
        type: 'chat:tool_use',
        id: (event.data as { id: string }).id,
        name: (event.data as { name: string }).name,
        input: (event.data as { input?: unknown }).input,
        groupId: (event.data as { groupId?: string }).groupId,
        progressTitle: (event.data as { progressTitle?: string }).progressTitle,
        progressSource: (event.data as { progressSource?: string }).progressSource,
      };
    case 'tool_result':
      return {
        type: 'chat:tool_result',
        id: (event.data as { id: string }).id,
        result: (event.data as { result: string }).result,
        error: (event.data as { error?: boolean }).error,
        duration_ms: (event.data as { duration_ms?: number }).duration_ms,
        metadata: (event.data as { metadata?: unknown }).metadata,
      };
    case 'tool_progress':
      return { type: 'chat:tool_progress', toolUseId: (event.data as { toolName: string }).toolName, percent: 0, stage: `${event.data}` };
    case 'agent_progress': {
      // Forward sub-agent progress events so the UI can show what the sub-agent is doing.
      // `agentEventType` is passed through verbatim (it is not narrowed to a
      // subset), so the plan 571 `heartbeat` keepalive reaches the renderer as
      // its own event type instead of masquerading as `thinking` prose.
      const agentEvent = event.data as {
        type: SubagentAgentEventType | string;
        data?: string;
        toolName?: string;
        toolInput?: Record<string, unknown>;
        toolResult?: string;
        duration?: number;
        agentId?: string;
        agentType?: string;
        agentName?: string;
        agentDescription?: string;
        sessionId?: string;
        agentSessionId?: string;
      } | undefined;
      if (agentEvent) {
        const { type: agentEventType, sessionId: _parentSessionId, agentSessionId, ...rest } = agentEvent;
        return {
          ...rest,
          type: 'chat:agent_progress',
          agentEventType,
          sessionId: _parentSessionId,
          agentSessionId,
        };
      }
      return null;
    }
    case 'permission_request':
      return { type: 'chat:permission', request: event.data };
    // ── The two terminal frames ─────────────────────────────────────────
    //
    // Both payloads live INSIDE `data`, which is where the ONE producer of
    // these frames writes them: `projectToLegacyFrame` (`run.completed` ->
    // `{ type: 'done', data: { reason } }`, `run.failed` ->
    // `{ type: 'error', data: { message, code } }`), reached through
    // `driveRunWithEngine`'s drain. `LegacySseFrame.data` is `unknown`, so the
    // reads below are NARROWED rather than asserted -- the old
    // `event.data as string` was a type assertion over a real type error, and
    // it silently handed the worker frame's `message: string` the payload
    // OBJECT while `code` (read off the top level) came back `undefined`.
    case 'done':
      return { type: 'chat:done', reason: readPayloadString(event.data, 'reason') };
    case 'error':
      return {
        type: 'chat:error',
        // `''`, not the payload: `message` is declared `string` on the worker
        // frame, and the router's own fallback (`event.message || 'Unknown
        // error'`) turns an empty string into the message the user sees.
        message: readPayloadString(event.data, 'message') ?? '',
        code: readPayloadString(event.data, 'code'),
      };
    case 'turn_start':
      return { type: 'chat:status', message: `Turn ${(event.data as { turnCount?: number })?.turnCount ?? ''}` };
    case 'mode_changed':
      // Plan 224 follow-up: agent runtime mode switched via
      // EnterPlanMode / ExitPlanMode / SwitchMode tool. Forward the
      // new mode + source so the renderer can sync input-box chip/glow.
      return { type: 'chat:mode_changed', ...(event.data as object) };
    case 'system': {
      const metadata = (event as { metadata?: { retryAttempt?: number; maxAttempts?: number; retryDelayMs?: number; retryReason?: string; errorType?: string; statusCode?: number } }).metadata;
      if (metadata?.retryAttempt !== undefined) {
        return {
          type: 'chat:retry',
          attempt: metadata.retryAttempt,
          maxAttempts: metadata.maxAttempts ?? 10,
          delayMs: metadata.retryDelayMs ?? 0,
          // Plan 462: carry the provider's own wording so the UI can explain
          // WHY it is reconnecting (e.g. "余额不足，请充值") — not just a counter.
          message: metadata.retryReason ?? (event.data as string),
          errorType: metadata.errorType,
          statusCode: metadata.statusCode,
        };
      }
      return null;
    }
    // Research mode events
    case 'research_phase':
      return { type: 'chat:research_phase', ...(event.data as object) };
    case 'research_complexity':
      return { type: 'chat:research_complexity', ...(event.data as object) };
    case 'research_questions':
      return { type: 'chat:research_questions', ...(event.data as object) };
    case 'research_iteration':
      return { type: 'chat:research_iteration', ...(event.data as object) };
    case 'research_finding':
      return { type: 'chat:research_finding', ...(event.data as object) };
    case 'research_progress':
      return { type: 'chat:research_progress', ...(event.data as object) };
    case 'research_synthesis_chunk':
      return { type: 'chat:research_synthesis_chunk', ...(event.data as object) };
    case 'research_complete':
      return { type: 'chat:research_complete', ...(event.data as object) };
    case 'research_error':
      // Surface as chat:research_error so the stream-session-manager routes
      // it to handleResearchErrorEvent instead of terminating the entire
      // chat session. The orchestrator's own error event is research-scoped.
      return { type: 'chat:research_error', ...(event.data as object) };
    case 'report_complete': {
      const { type: _t, ...rest } = event as Record<string, unknown>;
      return { type: 'chat:research_report', ...rest };
    }
    case 'evidence_chain_response': {
      const { type: _t, ...rest } = event as Record<string, unknown>;
      return { type: 'chat:research_evidence', ...rest };
    }
    case 'continue_research_start': {
      const { type: _t, ...rest } = event as Record<string, unknown>;
      return { type: 'chat:research_continue', ...rest };
    }
    case 'research_source_found':
      return { type: 'chat:research_source_found', ...(event.data as object) };
    case 'research_source_rejected':
      return { type: 'chat:research_source_rejected', ...(event.data as object) };
    case 'research_gap_detected':
      return { type: 'chat:research_gap_detected', ...(event.data as object) };
    case 'research_next_action':
      return { type: 'chat:research_next_action', ...(event.data as object) };
    case 'research_conflict_detected':
      return { type: 'chat:research_conflict_detected', ...(event.data as object) };
    case 'research_stop_decision':
      return { type: 'chat:research_stop_decision', ...(event.data as object) };
    case 'plan_delta':
      return { type: 'chat:plan_delta', ...(event.data as object) };
    case 'complexity_classified':
      return { type: 'chat:research_complexity', ...(event.data as object) };
    case 'run_status':
      return { type: 'chat:research_run_status', ...(event.data as object) };
    case 'activity':
      return { type: 'chat:research_activity', ...(event.data as object) };
    case 'plan_steps_created':
      return { type: 'chat:research_plan_steps', ...(event.data as object) };
    // Internal events: debug panel only, silently skip for now
    case 'research_quality_snapshot':
    case 'query_deduplicated':
    case 'finding_deduplicated':
    case 'action_executed':
    // LLM usage frame: consumed upstream for token accounting before this
    // codec runs; nothing to forward to the SSE client.
    case 'result':
      return null;
    // Compact events (from DuyaAgent auto-compaction in streamChat).
    // Routed as-is so the renderer can show a compressing indicator.
    case 'compact:start':
      return { type: 'compact:start' };
    case 'compact:done':
      return { type: 'compact:done', ...(event.data as object) };
    case 'compact:error':
      return { type: 'compact:error', ...(event.data as object) };
    // Per-step lifecycle events are now forwarded live (they used to be
    // buffered agent-side and dropped here, so the renderer never saw
    // projecting/summarizing verbs in real time).
    case 'compact:step':
      return { type: 'compact:step', ...(event.data as object) };
    case 'compact:over_threshold':
      return { type: 'compact:over_threshold', ...(event.data as object) };
    default:
      // Structured rather than `console.warn`, and WARN (not INFO) because an
      // unrecognised event type is a producer/consumer disagreement: either the
      // agent grew a frame nobody forwards, or a caller is replaying an event
      // shape this codec does not know. Both are worth an operator's attention.
      logger.warn('Unknown agent stream event type — dropped by the frame codec', {
        type: event.type,
      });
      return null;
  }
}
