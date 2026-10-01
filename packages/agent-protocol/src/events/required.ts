/**
 * Per-event field manifest: which fields must be present, which may be absent.
 *
 * ## The hole this closes
 *
 * `validate()` in codecs.ts checked the ENVELOPE (six keys, `seq`, payload is an
 * object, `payload.type` is a known event) and then, for durable events, whether
 * the payload could be serialised. It never checked the payload's own fields. A
 * `run.started` with no `manifestHash`, or a `tool.call_completed` with no
 * `outcome`, decoded cleanly and validated cleanly. The types said otherwise and
 * the types were not being enforced at the boundary.
 *
 * pi-protocol closes this hole with typebox: `Check(Schema, value)` validates
 * every field at runtime. Adopting typebox here would break the zero-runtime-
 * dependency constraint that is the reason this package exists, so the manifest
 * is written out by hand instead — and the hand-written part is exactly where
 * drift lives, so it is locked structurally rather than by discipline.
 *
 * ## Why the mapped type does the work
 *
 * `FieldFlags<K>` is a mapped type over the payload's OWN keys:
 *
 *   { readonly [P in keyof RunEventPayloads[K] & string]: boolean }
 *
 * which makes all three failure modes compile errors rather than review items:
 *
 *  - a field omitted from an entry  -> `false`-or-`true` missing
 *  - a field that does not exist on the payload -> excess property check
 *  - a whole event omitted -> the outer mapped type
 *
 * `true` means the producer MUST send it; `false` means it is optional and its
 * absence is legal. There is deliberately no third state: "maybe" is not a
 * category the wire has, and inventing one is how a payload ends up with two
 * conflicting sources of truth.
 *
 * ## Why the value is a boolean and not two arrays
 *
 * Two arrays (`required` / `optional`) read slightly better but cannot express
 * completeness: nothing forces the author to notice a field added to the
 * payload later. A key->boolean record does, because the compiler reports the
 * new key as missing.
 *
 * ## The remaining link is a test, not a type
 *
 * This table is checked against `RunEventPayloads` at compile time. It cannot be
 * checked against `EVENT_FIXTURES` that way, because the fixtures deliberately
 * omit optional fields. test/21-payload-field-manifest.test.ts closes that link
 * at runtime: every `true` field must appear in the legal minimal fixture, and
 * every fixture key must be declared here. Together the two directions mean a
 * field cannot be added, renamed, or re-classified without one of them failing.
 */

import type { RunEventPayloads } from './payloads.js';
import type { EventType } from './registry.js';

/** `true` = the producer must send it. `false` = optional, absence is legal. */
type FieldFlags<K extends EventType> = {
  readonly [P in keyof RunEventPayloads[K] & string]: boolean;
};

/** One entry per event; every field of that event's payload is declared. */
export type RequiredFieldTable = {
  readonly [K in EventType]: FieldFlags<K>;
};

/**
 * The manifest. Compiled against the payload interfaces, so a field added to
 * `RunEventPayloads` without a decision here fails the build.
 */
export const REQUIRED_FIELDS = {
  // ── run ────────────────────────────────────────────────────────────────
  'run.started': { manifestHash: true, protocol: true, runtime: true, resumedFrom: false },
  'run.paused': { at: true },
  'run.completed': { status: true, stopReason: false, usage: false, cancelRequested: false },
  'run.failed': { error: true },

  // ── turn ───────────────────────────────────────────────────────────────
  'turn.started': { turnId: true, index: true, model: true, providerId: true, apiFormat: true, effort: false },
  'turn.retry_scheduled': { attempt: true, maxAttempts: true, delayMs: true, reason: true },
  'turn.completed': { turnId: true, index: true, stopReason: true, usage: true, durationMs: true },

  // ── assistant ──────────────────────────────────────────────────────────
  'assistant.text_block': { messageId: true, index: true, text: true, textSignature: false, phase: false },
  'assistant.text_delta': { messageId: true, index: true, delta: true },
  'assistant.thinking_block': {
    messageId: true,
    index: true,
    thinking: true,
    thinkingSignature: false,
    redacted: false,
    encrypted: false,
  },
  'assistant.thinking_delta': { messageId: true, index: true, delta: true },
  'assistant.message_finalized': { messageId: true, content: true, stopReason: true, usage: false, providerMeta: false },
  'assistant.usage': { usage: true },
  'assistant.mode_changed': { mode: true, source: true, reason: false },
  'assistant.goal_updated': {
    state: true,
    phase: true,
    objective: true,
    tokensUsed: true,
    tokenBudget: true,
    consecutiveNotAchieved: true,
    gapsSummary: false,
    strategyProposal: false,
    pauseMessage: false,
    pauseReason: false,
    totalWorkerRounds: false,
    totalVerifyRounds: false,
    elapsedMs: false,
    createdAt: false,
    executionWait: false,
    planFile: false,
    history: false,
  },
  'assistant.status': { message: true },

  // ── tool ───────────────────────────────────────────────────────────────
  'tool.call_preview': { toolCallId: true, toolName: true, arguments: true, provisional: true },
  'tool.call_started': {
    toolCallId: true,
    toolName: true,
    arguments: true,
    attempt: true,
    annotations: false,
    groupId: false,
    progressTitle: false,
    progressSource: false,
    mcp: false,
  },
  'tool.arguments_delta': { toolCallId: true, delta: true },
  'tool.progress': { toolCallId: true, elapsedMs: true, title: false, percent: false, stage: false },
  'tool.group_progress': { groupId: false, title: true, source: true },
  'tool.timed_out': { toolCallId: true, toolName: true, elapsedMs: true },
  'tool.call_completed': {
    toolCallId: true,
    content: true,
    outcome: true,
    durationMs: true,
    metadata: false,
    blocks: false,
    structured: false,
    images: false,
  },

  // ── checkpoint ─────────────────────────────────────────────────────────
  'checkpoint.saved': { checkpointRef: true, generation: true, eventSeq: true },

  // ── permission ─────────────────────────────────────────────────────────
  'permission.requested': {
    requestId: true,
    kind: true,
    toolCallId: false,
    toolName: true,
    toolInput: true,
    mode: true,
    reason: false,
    suggestions: false,
    metadata: false,
    blockedPath: false,
    startedAt: true,
    expiresAt: true,
  },
  'permission.resolved': { requestId: true, action: true, source: true, latencyMs: true, scope: false, reason: false },
  'permission.expired': { requestId: true, afterMs: true },

  // ── compaction ─────────────────────────────────────────────────────────
  'compaction.started': { compactionId: true, trigger: true },
  'compaction.step': {
    compactionId: true,
    step: true,
    phase: true,
    messageCount: false,
    tokensBefore: false,
    tokensEstimated: false,
    filesCached: false,
  },
  'compaction.completed': {
    compactionId: true,
    strategy: false,
    tokensRemoved: false,
    tokensRetained: false,
    removedCount: false,
    boundaryId: true,
    compactedMessageIds: true,
  },
  'compaction.failed': { compactionId: true, error: true },
  'compaction.over_threshold': { tokensRetained: true, available: true },

  // ── subagent / hooks ───────────────────────────────────────────────────
  'subagent.started': {
    subagentId: true,
    parentToolCallId: true,
    sessionId: false,
    agentType: true,
    agentName: true,
    agentDescription: false,
  },
  'subagent.completed': { subagentId: true, status: true, durationMs: true, summary: false },
  'hook.invoked': {
    agentEventType: true,
    hookEventName: true,
    hookType: true,
    hookName: true,
    matcher: false,
    additionalContext: false,
    data: false,
    exitCode: false,
    async: true,
    backgroundTaskId: false,
    durationMs: true,
    status: true,
    errorMessage: false,
    toolName: false,
    toolCallId: false,
    toolInput: false,
  },

  // ── diagnostic ─────────────────────────────────────────────────────────
  diagnostic: { level: true, message: true, data: false },
  'diagnostic.trace': { traceId: true, spanId: false, parentSpanId: false, name: true, attributes: false },

  // ── extension ──────────────────────────────────────────────────────────
  'extension.custom': { namespace: true, name: true, data: true },
} as const satisfies RequiredFieldTable;

/** The fields a producer must send for one event type. */
export function requiredFieldsOf(type: EventType): readonly string[] {
  const flags = REQUIRED_FIELDS[type] as Readonly<Record<string, boolean>>;
  return Object.keys(flags).filter((field) => flags[field]);
}

/** One missing or illegally-null required field. */
export interface FieldIssue {
  readonly field: string;
  readonly message: string;
}

/**
 * Check one payload against its manifest.
 *
 * Presence is checked with `in` rather than `!== undefined` because
 * `exactOptionalPropertyTypes` is on across this package: an optional field is
 * either absent or a real value, so an explicit `undefined` on a REQUIRED field
 * is a producer bug worth reporting rather than an absence worth tolerating.
 * Both are reported; a field that is present-but-undefined is not the same
 * signal as a field that was never sent.
 *
 * @param type - The event type, used to select the manifest entry.
 * @param payload - The decoded payload object, already known to be an object.
 * @returns One issue per required field that is missing or explicitly undefined.
 */
export function checkRequiredFields(type: EventType, payload: Readonly<Record<string, unknown>>): readonly FieldIssue[] {
  const flags = REQUIRED_FIELDS[type] as Readonly<Record<string, boolean>>;
  const issues: FieldIssue[] = [];
  for (const [field, required] of Object.entries(flags)) {
    if (!required) continue;
    if (!(field in payload)) {
      issues.push({ field, message: 'required field is missing' });
      continue;
    }
    if (payload[field] === undefined) {
      issues.push({ field, message: 'required field is present but undefined' });
    }
  }
  return issues;
}
