/**
 * worker-frames.ts — the worker frame normalizer, owned by the Host.
 *
 * Moved from the Desktop Agent Server router (which keeps its desktop-only
 * `mcp:status:snapshot` cache side effect by wrapping `normalizeWorkerEvent`).
 * The mapping is byte-identical to the router's, because the run layer's
 * projector consumes exactly these normalized legacy frames: two normalizers
 * would mean two vocabularies for one worker protocol.
 *
 * Host-owned execution tees worker frames through `normalizeWorkerEvent` and
 * `RunOrchestrator.observe`; `isRunLayerOnlyFrame` keeps run-only frames from
 * reaching any client stream.
 */

const RUN_LAYER_ONLY_FRAMES: ReadonlySet<string> = new Set(['chat:message_finalized', 'chat:turn_start']);

/** True when the frame is normalised but must not reach an SSE client. */
export function isRunLayerOnlyFrame(normalized: Record<string, unknown> | null): boolean {
  return normalized !== null && RUN_LAYER_ONLY_FRAMES.has(String(normalized['type']));
}

/**
 * Normalize a worker event (a JSON line parsed from the worker's stdout) into
 * the `{ type, data }` contract consumed by every Host/agent-server client.
 * Returns `null` for internal control-plane events (`pong`, `memory:wakeup`)
 * that must never reach a client.
 */
export function normalizeWorkerEvent(event: Record<string, unknown>): Record<string, unknown> | null {
  const msgType = event.type as string;
  if (msgType === 'pong') return null;
  if (msgType === 'memory:wakeup') return null;

  let sseEvent: Record<string, unknown> = event;
  const contentIdentity = {
    ...(typeof event.messageId === 'string' ? { messageId: event.messageId } : {}),
    ...(typeof event.index === 'number' ? { index: event.index } : {}),
  };

  if (msgType === 'chat:text' || msgType === 'chat:thinking') {
    sseEvent = {
      type: msgType.replace('chat:', ''),
      data: { content: event.data || event.content, ...contentIdentity },
    };
  } else if (msgType === 'chat:text_delta' || msgType === 'chat:thinking_delta') {
    sseEvent = {
      type: msgType.replace('chat:', ''),
      data: { content: event.delta, ...contentIdentity },
    };
  } else if (msgType === 'chat:text_delta' || msgType === 'chat:thinking_delta') {
    sseEvent = {
      type: msgType.replace('chat:', ''),
      data: { content: event.delta },
    };
  } else if (msgType === 'chat:tool_use_started') {
    sseEvent = {
      type: 'tool_use_started',
      data: {
        id: event.id,
        name: event.name,
        input: event.input,
        groupId: event.groupId,
        progressTitle: event.progressTitle,
        progressSource: event.progressSource,
      },
    };
  } else if (msgType === 'chat:tool_use_delta') {
    sseEvent = {
      type: 'tool_use_delta',
      data: { id: event.id, name: event.name, delta: event.delta },
    };
  } else if (msgType === 'chat:tool_group_progress') {
    sseEvent = {
      type: 'tool_group_progress',
      data: { groupId: event.groupId, title: event.title, source: event.source },
    };
  } else if (msgType === 'chat:tool_use') {
    sseEvent = {
      type: 'tool_use',
      data: {
        id: event.id,
        name: event.name,
        input: event.input,
        groupId: event.groupId,
        progressTitle: event.progressTitle,
        progressSource: event.progressSource,
      },
    };
  } else if (msgType === 'chat:tool_result') {
    sseEvent = {
      type: 'tool_result',
      data: { id: event.id, result: event.result, error: event.error, duration_ms: event.duration_ms, metadata: event.metadata },
    };
  } else if (msgType === 'chat:tool_progress') {
    sseEvent = {
      type: 'tool_progress',
      data: event,
    };
  } else if (msgType === 'chat:permission') {
    sseEvent = {
      type: 'permission',
      data: event.request,
    };
  } else if (msgType === 'chat:token_usage') {
    sseEvent = {
      type: 'token_usage',
      data: event,
    };
  } else if (msgType === 'chat:status') {
    sseEvent = {
      type: 'status',
      data: { message: event.status || event.message },
    };
  } else if (msgType === 'compact:start' || msgType === 'compact:done' || msgType === 'compact:error') {
    sseEvent = { type: msgType, data: event };
  } else if (msgType === 'compact:step' || msgType === 'compact:over_threshold') {
    sseEvent = { type: msgType, data: event };
  } else if (msgType === 'chat:mode_changed') {
    sseEvent = {
      type: 'mode_changed',
      data: { mode: event.mode, source: event.source, reason: event.reason },
    };
  } else if (msgType === 'chat:goal_updated') {
    const { type: _t, ...rest } = event;
    sseEvent = { type: 'goal_updated', data: rest };
  } else if (msgType === 'chat:clipboard_write') {
    sseEvent = {
      type: 'clipboard_write',
      data: { text: typeof event.text === 'string' ? event.text : '' },
    };
  } else if (msgType === 'chat:agent_progress') {
    sseEvent = {
      type: msgType.replace('chat:', ''),
      data: event,
    };
  } else if (msgType === 'chat:research_continue') {
    const { type: _t, ...rest } = event;
    sseEvent = { type: 'research_continue', data: rest };
  } else if (msgType === 'chat:research_evidence') {
    const { type: _t, ...rest } = event;
    sseEvent = { type: 'research_evidence', data: rest };
  } else if (msgType === 'chat:research_report') {
    const { type: _t, ...rest } = event;
    sseEvent = { type: 'research_report', data: rest };
  } else if (msgType.startsWith('chat:research_')) {
    const { type: _t, ...rest } = event;
    sseEvent = { type: msgType.replace('chat:', ''), data: rest };
  } else if (msgType === 'chat:workflow_run') {
    const { type: _t, ...rest } = event;
    sseEvent = { type: 'workflow_run', data: rest };
  } else if (msgType === 'chat:done') {
    sseEvent = { type: 'done', data: event };
  } else if (msgType === 'chat:error') {
    sseEvent = {
      type: 'error',
      data: { message: event.message || 'Unknown error', code: event.code },
    };
  } else if (msgType === 'chat:retry') {
    sseEvent = {
      type: 'retry',
      data: {
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        message: event.message,
        errorType: event.errorType,
        statusCode: event.statusCode,
      },
    };
  } else if (msgType === 'chat:connector_auth_required') {
    sseEvent = {
      type: 'connector_auth_required',
      data: {
        provider: (event as { provider?: string }).provider,
        connectionId: (event as { connectionId?: string }).connectionId,
        toolName: (event as { toolName?: string }).toolName,
        variant: (event as { variant?: string }).variant ?? 'reauth',
      },
    };
  } else if (msgType === 'chat:db_persisted') {
    sseEvent = { type: 'db_persisted', data: event };
  } else if (msgType === 'chat:title_generated') {
    sseEvent = { type: 'title_generated', data: event };
  } else if (msgType === 'mcp:reloaded') {
    sseEvent = { type: 'mcp:reloaded', data: event };
  } else if (msgType === 'mcp:status:snapshot') {
    // The Desktop router additionally feeds this frame into its capability
    // snapshot store; that side effect stays Desktop-side. The mapping is the same.
    sseEvent = { type: 'mcp:status:snapshot', data: event };
  } else if (msgType === 'mcp:reload:error') {
    sseEvent = { type: 'mcp:reload:error', data: event };
  }

  return sseEvent;
}
