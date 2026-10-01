/**
 * Legacy `@duya/ai` SSE surface. Isolated and deprecated.
 *
 * Reachable only as `@duya/agent-protocol/legacy`, never re-exported from the
 * main entry.
 *
 * ## Why the legacy union is declared here instead of imported
 *
 * Importing it from `@duya/ai` would give the protocol package a runtime
 * dependency on another domain package — the `xai-grok-sampling-types`
 * mistake, just in the other direction. So the shape is declared structurally
 * and `test/09-sse-legacy-bridge.test.ts` pins it against the real union by
 * reading that package's source. If `@duya/ai` adds an event, the test fails
 * and the protocol package stays a leaf.
 *
 * ## The migration is table-driven
 *
 * `SSE_EVENT_TO_PROTOCOL` is the whole cutover plan. It is overwhelmingly a
 * 1:1 renaming: the legacy wire already separates every concern this protocol
 * names. The genuine fan-outs are `agent_progress` (one bloated union with
 * three meanings) and the router's research trio, which splits one worker
 * event into three SSE events on the way out.
 *
 * @deprecated Scheduled for removal one release after the router cutover.
 * Import protocol events from `@duya/agent-protocol` instead.
 */

import type { EventType } from '../events/registry.js';
import type { PermissionAction } from '../permission.js';

/** The legacy wire `type` strings, verbatim from `@duya/ai`. */
export const LEGACY_SSE_EVENT_TYPES = [
  'text',
  'text_delta',
  'thinking',
  'thinking_delta',
  'tool_use',
  'tool_use_started',
  'tool_use_delta',
  'tool_result',
  'tool_progress',
  'tool_timeout',
  'tool_group_progress',
  'permission_request',
  'turn_start',
  'done',
  'error',
  'result',
  'system',
  'mode_changed',
  'goal_updated',
  'clipboard_write',
  'compact:start',
  'compact:done',
  'compact:error',
  'compact:step',
  'compact:over_threshold',
  'agent_progress',
] as const;

export type LegacySseEventType = (typeof LEGACY_SSE_EVENT_TYPES)[number];

/**
 * Legacy event type -> protocol event type(s).
 *
 * An empty array means "host-only, deliberately not in the protocol":
 *   - `clipboard_write` is a UI command, not agent state. The worker has no
 *     clipboard at all (ai/src/types.ts:394).
 */
export const SSE_EVENT_TO_PROTOCOL: Readonly<
  Record<LegacySseEventType, readonly EventType[]>
> = {
  // Today the declared type says `data: string` while the router actually sends
  // `data.content` (router.ts:461-465) and the renderer reads
  // `event.data.content` (:444-446). The declared type was a lie.
  text: ['assistant.text_block'],
  text_delta: ['assistant.text_delta'],
  // signature/redacted/encrypted move from the top level into the payload.
  thinking: ['assistant.thinking_block'],
  thinking_delta: ['assistant.thinking_delta'],

  // `tool_use` and `tool_use_started` carry IDENTICAL data
  // (router.ts:466-477 vs :491-502) and the same on the worker side
  // (worker-protocol.ts:269-283, two interfaces that differ only in the
  // `type` discriminant). `tool_use_started` is the provisional announcement
  // while arguments are still streaming; `tool_use` is the authoritative
  // re-emission — DuyaAgent.ts:2394-2397 says so in as many words. Consumers
  // collapse the pair into one upsert keyed by id
  // (agent-sse-client.ts:452-453, stream-session-manager.ts:2013-2014).
  // Neither carries a result: completion arrives on `tool_result` below.
  tool_use: ['tool.call_started'],
  tool_use_started: ['tool.call_started'],
  tool_use_delta: ['tool.arguments_delta'],
  tool_result: ['tool.call_completed'],
  tool_progress: ['tool.progress'],
  tool_timeout: ['tool.timed_out'],
  tool_group_progress: ['tool.group_progress'],

  // The router actually emits `permission`, not `permission_request`
  // (router.ts:513-517). drift test #9 exists to catch exactly that drift.
  permission_request: ['permission.requested'],

  turn_start: ['turn.started'],
  done: ['run.completed'], // `reason` -> `stopReason`
  error: ['run.failed'], // metadata.isRetryable -> error.code
  result: ['assistant.usage'],
  // Retry metadata promoted out of `system` into a first-class event.
  system: ['turn.retry_scheduled'],
  // `mode: string` becomes a closed set.
  mode_changed: ['assistant.mode_changed'],
  goal_updated: ['assistant.goal_updated'],

  // UI command, not agent state.
  clipboard_write: [],

  // Colons become dots.
  'compact:start': ['compaction.started'],
  'compact:done': ['compaction.completed'],
  'compact:error': ['compaction.failed'],
  'compact:step': ['compaction.step'],
  'compact:over_threshold': ['compaction.over_threshold'],

  // One bloated union with 8 `type` values splits three ways.
  agent_progress: ['subagent.started', 'subagent.completed', 'hook.invoked'],
};

/**
 * Event types the router emits that were NEVER in the `SSEEvent` union.
 * Listed so drift test #9 can assert the registry covers them — today
 * `normalizeWorkerEvent` (router.ts:450-569) produces at least ten types the
 * union never declared.
 */
export const UNDECLARED_ROUTER_EVENTS: Readonly<Record<string, readonly EventType[]>> = {
  status: ['assistant.status'],
  token_usage: ['assistant.usage'],
  // `checkpoint` is absorbed by compaction.completed + run.started{resumedFrom};
  // its {messages, generation} payload is a STORAGE shape and must not cross
  // the protocol boundary (router.ts:1520-1526, worker-protocol.ts:248-255).
  checkpoint: [],
  // Control frame, not an event.
  ready: [],
  // Renderer view concern.
  title_generated: [],
  workflow_run: [],
  research_continue: [],
  research_evidence: [],
  research_report: [],
};

/**
 * Every legacy verb mapped to a protocol action.
 *
 * @deprecated Removed together with the rest of this module.
 */
export const LEGACY_PERMISSION_ACTION_MAP: Readonly<Record<string, PermissionAction>> = {
  allow_once: 'allow',
  allow_for_session: 'allow_always',
  // `paused` is what the bot approval card path means when a host never
  // answers (types.ts:334-336) — a timeout, recorded as a deny.
  paused: 'deny',
};

/** True when a legacy type is a compaction event using the colon form. */
export function isLegacyCompactionType(type: string): boolean {
  return type.startsWith('compact:');
}

/**
 * Protocol events with NO legacy source, with the reason each one exists.
 *
 * drift test #9 asserts this list equals the actual set of unreachable events.
 * That turns "which events are new?" from a question someone has to re-derive
 * into a list that has to be consciously maintained — adding an event with no
 * legacy source fails the test until it is written down here.
 */
export const NEW_PROTOCOL_EVENTS: Readonly<Partial<Record<EventType, string>>> = {
  'run.started':
    'The chat path never had a run concept — worker events carried only a sessionId. This carries the manifest hash and runtime identity, which is what makes resume verifiable.',
  'run.paused': 'Pause/resume did not exist. Without this event a paused run is indistinguishable from a stalled one.',
  'turn.completed': 'The legacy surface had turn_start with no terminal event, so a turn that never finished was indistinguishable from one that had not started.',
  'assistant.message_finalized':
    'The authoritative assistant message. Legacy streamed deltas and never marked the point where the message stopped changing, which is why compaction had to guess a boundary.',
  'permission.resolved':
    'The legacy surface had permission_request and no resolution event, so an answered or timed-out permission left no audit trail. Every decision must be recorded, including timeout and cancellation.',
  'permission.expired':
    'Emitted before permission.resolved{deny,timeout} so a reconnecting host can reconstruct that a deadline passed rather than inferring it from a deny.',
  diagnostic:
    'A dedicated channel so an evaluator can consume structured logs while the product UI ignores them. Legacy `status` was a human string and served both audiences badly.',
  'diagnostic.trace': 'Span records. The legacy surface had a trace id and nothing to attach to it.',
  'extension.custom':
    'The forward-compatibility escape hatch. Without it, an older host meeting a newer runtime has nowhere to put a forward-compatible extension and would have to drop or crash.',
};
