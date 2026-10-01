/**
 * One minimal legal payload per event.
 *
 * ## Why this ships in `dist`
 *
 * Other packages need the SAME payloads: `agent-core` proves exhaustive switch
 * handling, `agent-runtime` proves codec round-trips, the harness proves
 * transport parity. If each grew its own fixtures they would drift, and a
 * drift test that shares no input cannot detect drift.
 *
 * ## Compile-time completeness
 *
 * `EventFixtures` is a mapped type over `EventType`, so omitting a fixture is a
 * compile error rather than a hole found six months later.
 */

import type { RunEventPayloads } from '../events/payloads.js';
import type { EventType, RunEvent } from '../events/registry.js';

export type EventFixtures = { [K in EventType]: RunEventPayloads[K] };

const FIXTURES = {
  'run.started': {
    manifestHash: 'a'.repeat(64),
    protocol: { major: 1, minor: 0 },
    runtime: { name: 'test-runtime', version: '0.0.0-test' },
  },
  'run.paused': { at: 'turn_boundary' },
  'run.completed': { status: 'completed', stopReason: 'end_turn' },
  'run.failed': { error: { code: 'internal', message: 'fixture' } },

  'turn.started': {
    turnId: 'turn-1',
    index: 0,
    model: 'test-model',
    providerId: 'test-provider',
    apiFormat: 'anthropic',
  },
  'turn.retry_scheduled': {
    attempt: 1,
    maxAttempts: 3,
    delayMs: 500,
    reason: 'fixture',
    errorClass: 'provider_timeout',
  },
  'turn.completed': {
    turnId: 'turn-1',
    index: 0,
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    durationMs: 10,
  },

  'assistant.text_block': { messageId: 'msg-1', index: 0, text: 'hello' },
  'assistant.text_delta': { messageId: 'msg-1', index: 0, delta: 'he' },
  'assistant.thinking_block': { messageId: 'msg-1', index: 0, thinking: 'thinking' },
  'assistant.thinking_delta': { messageId: 'msg-1', index: 0, delta: 'th' },
  'assistant.message_finalized': {
    messageId: 'msg-1',
    content: [{ type: 'text', text: 'hello' }],
    stopReason: 'end_turn',
  },
  'assistant.usage': { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
  'assistant.mode_changed': { mode: 'plan', source: 'user' },
  'assistant.goal_updated': {
    state: 'active',
    phase: 'explore',
    objective: 'fixture',
    tokensUsed: 0,
    tokenBudget: 1000,
    consecutiveNotAchieved: 0,
  },
  'assistant.status': { message: 'working' },

  'tool.call_started': {
    toolCallId: 'call-1',
    toolName: 'Read',
    arguments: {},
    attempt: 1,
  },
  'tool.arguments_delta': { toolCallId: 'call-1', delta: '{}' },
  'tool.progress': { toolCallId: 'call-1', elapsedMs: 5 },
  'tool.group_progress': { title: 'fixture group', source: 'test' },
  'tool.timed_out': { toolCallId: 'call-1', toolName: 'Read', elapsedMs: 30_000 },
  'tool.call_completed': {
    toolUseId: 'call-1',
    content: 'ok',
    isError: false,
    durationMs: 1,
  },

  'permission.requested': {
    requestId: 'req-1',
    kind: 'tool_use',
    toolCallId: 'call-1',
    toolName: 'Bash',
    toolInput: {},
    mode: 'generic',
    expiresAt: 300_000,
  },
  'permission.resolved': {
    requestId: 'req-1',
    action: 'allow',
    source: 'host',
    latencyMs: 42,
  },
  'permission.expired': { requestId: 'req-1', afterMs: 300_000 },

  'compaction.started': { compactionId: 'cmp-1', trigger: 'auto' },
  'compaction.step': { compactionId: 'cmp-1', step: 1, phase: 'summarize' },
  'compaction.completed': {
    compactionId: 'cmp-1',
    boundaryId: 'boundary-1',
    compactedMessageIds: ['msg-1'],
  },
  'compaction.failed': {
    compactionId: 'cmp-1',
    error: { code: 'compaction_failed', message: 'fixture' },
  },
  'compaction.over_threshold': { tokensRetained: 200_000, available: 150_000 },

  'subagent.started': {
    subagentId: 'sub-1',
    parentToolCallId: 'call-1',
    agentType: 'general',
    agentName: 'fixture',
  },
  'subagent.completed': { subagentId: 'sub-1', status: 'completed', durationMs: 100 },
  'hook.invoked': {
    hookEventName: 'PostToolUse',
    hookType: 'command',
    hookName: 'fixture-hook',
    async: false,
    durationMs: 3,
    status: 'ok',
  },

  diagnostic: { level: 'info', message: 'fixture diagnostic' },
  'diagnostic.trace': { traceId: 'trace-1', name: 'fixture-span' },

  'extension.custom': { namespace: 'test.fixture', name: 'ping', data: {} },
} as const satisfies EventFixtures;

export const EVENT_FIXTURES: EventFixtures = FIXTURES;

export const FIXTURE_EVENT_TYPES: readonly EventType[] = Object.keys(
  EVENT_FIXTURES,
) as EventType[];

/** A complete, decodable envelope around a fixture payload. */
export function fixtureEnvelope<T extends EventType>(
  type: T,
  overrides: { seq?: number; runId?: string; sessionId?: string; timestamp?: number } = {},
): RunEvent & { type: T } {
  return { type, ...(EVENT_FIXTURES[type] as object) } as RunEvent & { type: T };
}

export function fixtureFrame<T extends EventType>(
  type: T,
  overrides: { seq?: number; runId?: string; sessionId?: string; timestamp?: number } = {},
): Record<string, unknown> {
  return {
    runId: overrides.runId ?? 'run-fixture',
    sessionId: overrides.sessionId ?? 'session-fixture',
    seq: overrides.seq ?? 1,
    timestamp: overrides.timestamp ?? 1_700_000_000_000,
    traceId: 'trace-fixture',
    payload: { type, ...(EVENT_FIXTURES[type] as object) },
  };
}
