/**
 * Per-field classification of the transcript vocabulary.
 *
 * ## What this file is
 *
 * Plan 587 T3.1 asks for an inventory "classified per field" across the `ai`
 * types, the agent types, the worker command surface, the SSE frames, the
 * Desktop DTOs, and the real consumers, with four classes: JSON wire,
 * internal async, storage view, UI view. An inventory that lives only in a
 * reviewer's head is not a deliverable, so the judgement is written here as
 * data and made load-bearing by two independent mechanisms:
 *
 *   1. `Classified<Shape>` is a mapped type over the shape's own keys with
 *      `-?` on every key. A field added to `Message` without a classification
 *      is a COMPILE error in `npm run typecheck:all`, and a classification
 *      naming a field that no longer exists is a compile error too, because
 *      an object literal annotated with the mapped type rejects excess
 *      properties. Drift in either direction is caught at build time.
 *
 *   2. `test/23-wire-field-classification.test.ts` checks the classes
 *      themselves — that `visibility` really is `ui-view`, that no `Promise`
 *      field is classified `json-wire`, and that the recorded union members
 *      match the runtime union. The compiler cannot tell you the
 *      classification is RIGHT, only that it is present.
 *
 * ## The four classes
 *
 * - `json-wire`    — survives `JSON.stringify` unchanged and is read by a
 *                    consumer that is not this process. Contract §A's
 *                    "no Promise/Map/functions into wire".
 * - `internal-async` — a Promise, callback, handle, or any other in-process
 *                    handshake. Forbidden on the wire by §A; must be produced
 *                    by an explicit serializer, never by structural
 *                    inheritance.
 * - `storage-view`  — a shape that exists to be written to and read from the
 *                    transcript store. It crosses no boundary on its own.
 * - `ui-view`       — read only by a renderer, and meaningless to a provider
 *                    or to a storage row.
 *
 * ## The rule for a field that is genuinely two things
 *
 * Several fields (`Message.metadata`, `TokenUsage.last_call`) are both stored
 * and replayed. They are classified `storage-view` and the reason is written
 * inline. The rule applied throughout: classify by WHO reads the field and
 * why, not by which file declares it.
 *
 * @see ./content.ts, ./tool-result.ts, ./permission-progress.ts for the shapes
 */

/** The four classifications contract §A and T3.1 ask for. */
export type FieldClass = 'json-wire' | 'internal-async' | 'storage-view' | 'ui-view';

/**
 * A classification for every field of `Shape`.
 *
 * `-?` makes the mapped keys required, so a missing classification fails the
 * build. Combined with excess-property checking on the annotated literal, a
 * stale classification fails it too.
 */
export type Classified<Shape> = { readonly [K in keyof Shape]-?: FieldClass };

// ── Message ───────────────────────────────────────────────────────────────

/**
 * `Message` carries three concerns on one interface — provider request,
 * durable row, renderer view — so it is the clearest case for classifying per
 * field rather than per type.
 */
export const MESSAGE_FIELDS: Classified<import('./content.js').Message> = {
  // Sent to the provider as the request body.
  role: 'json-wire',
  content: 'json-wire',
  id: 'json-wire',
  name: 'json-wire',
  tool_call_id: 'json-wire',
  timestamp: 'json-wire',
  // Read by providers that support deferred `tool_reference` blocks.
  addedToolNames: 'json-wire',

  // Renderer only. A hidden message must still reach the model and the
  // store; `visible | hidden` has no provider meaning at all.
  visibility: 'ui-view',
  // User-facing rendering content, produced by the renderer projection.
  displayContent: 'ui-view',

  // Persisted transcript columns. Replayed to the model on reload, but the
  // SHAPE is the row, not the provider body.
  metadata: 'storage-view',
  msg_type: 'storage-view',
  thinking: 'storage-view',
  tool_name: 'storage-view',
  tool_input: 'storage-view',
  parent_tool_call_id: 'storage-view',
  viz_spec: 'storage-view',
  status: 'storage-view',
  seq_index: 'storage-view',
  duration_ms: 'storage-view',
  sub_agent_id: 'storage-view',
  attachments: 'storage-view',
  // Origin classifier, inferred at the IPC boundary when absent. Kept as
  // `string` so the protocol stays free of agent vocabulary.
  source: 'storage-view',
  isCompactBoundary: 'storage-view',
  isCompactSummary: 'storage-view',
  compactedMessageCount: 'storage-view',
  compactedMessageIds: 'storage-view',
  compactBoundaryId: 'storage-view',
  tokenUsage: 'storage-view',
  // Read by `isSameModel` to decide whether history may be replayed to a
  // different model, and written on the row. Storage: the value describes a
  // past call rather than instructing the next one.
  providerId: 'storage-view',
  model: 'storage-view',
  api: 'storage-view',
};

// ── content blocks ────────────────────────────────────────────────────────

export const TEXT_CONTENT_FIELDS: Classified<import('./content.js').TextContent> = {
  type: 'json-wire',
  text: 'json-wire',
  // Anthropic text signature, replayed verbatim in history.
  textSignature: 'json-wire',
  // Closed to two values on purpose — see content.ts.
  phase: 'json-wire',
  // Capture-only per the field's own comment; never sent back to a provider.
  annotations: 'json-wire',
};

export const IMAGE_CONTENT_FIELDS: Classified<import('./content.js').ImageContent> = {
  type: 'json-wire',
  // base64 payloads cross the wire by definition; this is the field that
  // makes the event vocabulary's four-member union insufficient.
  source: 'json-wire',
};

export const TOOL_USE_CONTENT_FIELDS: Classified<import('./content.js').ToolUseContent> = {
  type: 'json-wire',
  id: 'json-wire',
  name: 'json-wire',
  input: 'json-wire',
  // Anthropic thought signature, replayed verbatim in history.
  thoughtSignature: 'json-wire',
  // Group identity and title are consumed by the renderer to group tool
  // rows; providers are not sent them.
  groupId: 'ui-view',
  progressTitle: 'ui-view',
  progressSource: 'ui-view',
};

export const TOOL_RESULT_CONTENT_FIELDS: Classified<import('./content.js').ToolResultContent> = {
  type: 'json-wire',
  tool_use_id: 'json-wire',
  // `string | MessageContent[]` — the array form exists so a tool result can
  // carry image blocks to a vision model. Narrowing it to `string` is the
  // specific field loss this inventory exists to prevent.
  content: 'json-wire',
  is_error: 'json-wire',
};

export const THINKING_CONTENT_FIELDS: Classified<import('./content.js').ThinkingContent> = {
  type: 'json-wire',
  thinking: 'json-wire',
  thinkingSignature: 'json-wire',
  redacted: 'json-wire',
  // NOTE: `string` in this vocabulary, `boolean` in the event vocabulary.
  // Deliberately not reconciled here — see the module comment in content.ts.
  encrypted: 'json-wire',
};

export const PROVIDER_BLOCK_CONTENT_FIELDS: Classified<import('./content.js').ProviderBlockContent> =
  {
    type: 'json-wire',
    origin: 'json-wire',
    kind: 'json-wire',
    // Opaque by construction: this is what stops an unmodelled provider block
    // from being dropped on the way through.
    payload: 'json-wire',
  };

export const ASSISTANT_MESSAGE_FIELDS: Classified<import('./content.js').AssistantMessage> = {
  role: 'json-wire',
  content: 'json-wire',
  id: 'json-wire',
  timestamp: 'json-wire',
  api: 'json-wire',
  providerId: 'json-wire',
  model: 'json-wire',
  responseId: 'json-wire',
  usage: 'json-wire',
  // Capture-only provider observability, per its own comment.
  providerMeta: 'json-wire',
  stopReason: 'json-wire',
};

// ── usage ─────────────────────────────────────────────────────────────────

export const TOKEN_USAGE_FIELDS: Classified<import('./content.js').TokenUsage> = {
  input_tokens: 'json-wire',
  output_tokens: 'json-wire',
  total_tokens: 'json-wire',
  cache_hit_tokens: 'json-wire',
  cache_creation_tokens: 'json-wire',
  // Aggregator name; absent for direct API calls.
  upstreamProvider: 'json-wire',
  // Per-call ledger, absent on legacy rows — parsers fall back to the
  // cumulative fields above.
  calls: 'json-wire',
  // Largest-prompt-call snapshot. A nested partial, deliberately not a
  // `UsageCall`: it carries no `model`, so typing it as one would invent a
  // value the producer never wrote.
  last_call: 'json-wire',
};

export const USAGE_CALL_FIELDS: Classified<import('./content.js').UsageCall> = {
  input_tokens: 'json-wire',
  output_tokens: 'json-wire',
  cache_hit_tokens: 'json-wire',
  cache_creation_tokens: 'json-wire',
  // A subset of output_tokens, never double-counted.
  reasoning_tokens: 'json-wire',
  cache_write_1h_tokens: 'json-wire',
  total_tokens: 'json-wire',
  model: 'json-wire',
  // snake_case here and camelCase `providerId` in the event vocabulary.
  provider_id: 'json-wire',
};

/**
 * `StopReason` is a union, so its inventory is per member rather than per
 * field. Classified by what consuming the member DOES, because that is what
 * determines whether a value may be dropped.
 */
export const STOP_REASON_MEMBERS: Readonly<Record<string, FieldClass>> = {
  // Normal finish. Maps to `run.completed`.
  completed: 'json-wire',
  // Cooperative cancel requested and observed.
  aborted: 'json-wire',
  // Run-level turn cap reached. Distinguish from `max_tokens`.
  max_turns: 'json-wire',
  // Output budget exhausted. The truncation guard keys on this value to fail
  // partially-streamed tool calls, so it must never be normalised away.
  max_tokens: 'json-wire',
  error: 'json-wire',
  // More tool calls requested: the loop continues, this is not a terminal.
  tool_use: 'json-wire',
  end_turn: 'json-wire',
  stop_sequence: 'json-wire',
  // The loop's own guard against a repeated-tool-call cycle.
  repeated_tool_calls: 'json-wire',
};

// ── tool result ───────────────────────────────────────────────────────────

export const TOOL_RESULT_WIRE_FIELDS: Classified<import('./tool-result.js').ToolResultWire> = {
  id: 'json-wire',
  name: 'json-wire',
  result: 'json-wire',
  // Kept as an optional boolean on the legacy wire. Deliberately NOT upgraded
  // to the event vocabulary's `ToolCallOutcome` — see tool-result.ts.
  error: 'json-wire',
  duration_ms: 'json-wire',
  metadata: 'json-wire',
  // Inline attachments; the executor turns these into `ImageContent` blocks.
  images: 'json-wire',
  // Canonical MCP blocks, saved losslessly.
  blocks: 'json-wire',
  structured: 'json-wire',
};

/**
 * The two Promise fields, classified separately because they are the entire
 * reason `ToolResult` had to be split at all.
 *
 * They are `internal-async` and that is the classification the architecture
 * gate cares about: §A forbids Promise on the wire, and a field cannot be
 * both the wire half of a type and its Promise half.
 */
export const DEFERRED_TOOL_EXTRAS_FIELDS: Classified<import('./tool-result.js').DeferredToolExtras> =
  {
    // Awaited by StreamingToolExecutor after the main result is delivered, to
    // synthesise a second tool_result.
    pendingExtraResult: 'internal-async',
    // Surfaced as a `deferredContext` update for the NEXT provider turn, and
    // explicitly never persisted to durable history.
    pendingContext: 'internal-async',
  };

export const TOOL_USE_FIELDS: Classified<import('./tool-result.js').ToolUse> = {
  id: 'json-wire',
  name: 'json-wire',
  input: 'json-wire',
  groupId: 'ui-view',
  progressTitle: 'ui-view',
  progressSource: 'ui-view',
};

/**
 * `ToolResultMetadata` is deliberately open (`[key: string]: unknown`), so it
 * is excluded from the `Classified<>` machinery: a mapped type over an index
 * signature accepts any key and would enforce nothing.
 *
 * The named keys are recorded here anyway, because "no field is dropped"
 * applies to them too. `matchCount`, `truncated` and `engine` are the three
 * that the sibling definition in `packages/agent/src/tool/types.ts` is missing
 * — see `TOOL_RESULT_METADATA_DIVERGENCE`.
 */
export const TOOL_RESULT_METADATA_NAMED_FIELDS = {
  durationMs: 'json-wire',
  filePath: 'json-wire',
  lineCount: 'json-wire',
  charCount: 'json-wire',
  exitCode: 'json-wire',
  matchCount: 'json-wire',
  truncated: 'json-wire',
  engine: 'json-wire',
} as const satisfies Readonly<Record<string, FieldClass>>;

/**
 * Two `ToolResultMetadata` definitions exist today and they are NOT
 * identical. `packages/agent/src/tool/types.ts` lacks `matchCount`,
 * `truncated` and `engine`. Recorded, not merged: merging them is a
 * behaviour change to whichever tool relies on the absent keys, and this PR
 * is types-only. Removal task 587-T3-1-MERGE-METADATA.
 */
export const TOOL_RESULT_METADATA_DIVERGENCE = {
  agentToolCopy: 'packages/agent/src/tool/types.ts',
  missingFromAgentCopy: ['matchCount', 'truncated', 'engine'] as const,
  removalTask: '587-T3-1-MERGE-METADATA',
} as const;

// ── permission and progress ───────────────────────────────────────────────

export const PERMISSION_REQUEST_EVENT_FIELDS: Classified<
  import('./permission-progress.js').PermissionRequestEvent
> = {
  id: 'json-wire',
  toolName: 'json-wire',
  toolInput: 'json-wire',
  // The request's interactive situation, NOT the policy decision. Kept
  // distinct from the protocol's `PermissionPolicyMode` on purpose (§E).
  mode: 'json-wire',
  expiresAt: 'json-wire',
  decisionReason: 'json-wire',
  // Renders as labeled rows in the approval card.
  metadata: 'ui-view',
};

export const AGENT_PROGRESS_EVENT_FIELDS: Classified<
  import('./permission-progress.js').AgentProgressEvent
> = {
  type: 'json-wire',
  data: 'json-wire',
  toolName: 'json-wire',
  toolInput: 'json-wire',
  toolResult: 'json-wire',
  duration: 'json-wire',
  // Identify the emitting sub-agent to the renderer.
  agentId: 'json-wire',
  agentType: 'json-wire',
  agentName: 'json-wire',
  agentDescription: 'json-wire',
  sessionId: 'json-wire',
  // Drawn as a hook row; the worker flattens it into the envelope.
  hookEvent: 'ui-view',
};

export const HOOK_EVENT_PAYLOAD_FIELDS: Classified<
  import('./permission-progress.js').HookEventPayload
> = {
  hookEventName: 'json-wire',
  hookType: 'json-wire',
  hookName: 'json-wire',
  matcher: 'json-wire',
  additionalContext: 'json-wire',
  exitCode: 'json-wire',
  // `async` is a reserved word as an identifier but a legal property name.
  async: 'json-wire',
  backgroundTaskId: 'json-wire',
  durationMs: 'json-wire',
  status: 'json-wire',
  errorMessage: 'json-wire',
  seq: 'json-wire',
  toolName: 'json-wire',
  toolUseId: 'json-wire',
};

// ── the shape of the inventory itself ─────────────────────────────────────

/** Every classification table, keyed by the type it describes. */
export const FIELD_CLASSIFICATION = {
  Message: MESSAGE_FIELDS,
  TextContent: TEXT_CONTENT_FIELDS,
  ImageContent: IMAGE_CONTENT_FIELDS,
  ToolUseContent: TOOL_USE_CONTENT_FIELDS,
  ToolResultContent: TOOL_RESULT_CONTENT_FIELDS,
  ThinkingContent: THINKING_CONTENT_FIELDS,
  ProviderBlockContent: PROVIDER_BLOCK_CONTENT_FIELDS,
  AssistantMessage: ASSISTANT_MESSAGE_FIELDS,
  TokenUsage: TOKEN_USAGE_FIELDS,
  UsageCall: USAGE_CALL_FIELDS,
  ToolResultWire: TOOL_RESULT_WIRE_FIELDS,
  DeferredToolExtras: DEFERRED_TOOL_EXTRAS_FIELDS,
  ToolUse: TOOL_USE_FIELDS,
  PermissionRequestEvent: PERMISSION_REQUEST_EVENT_FIELDS,
  AgentProgressEvent: AGENT_PROGRESS_EVENT_FIELDS,
  HookEventPayload: HOOK_EVENT_PAYLOAD_FIELDS,
} as const;

/** Fields that must never be classified `json-wire`, and why. */
export const FORBIDDEN_ON_WIRE = ['pendingExtraResult', 'pendingContext'] as const;

/**
 * Field NAMES that carry different classes on different types.
 *
 * These are not contradictions. The same word means different things on
 * different shapes, and that is the honest outcome of classifying per field
 * rather than per type:
 *
 *   - `Message.metadata` is the persisted row blob, while
 *     `ToolResultWire.metadata` is MCP result metadata that is BOTH stored
 *     losslessly and carried on the wire, and
 *     `PermissionRequestEvent.metadata` is `toolParamsDisplay`, which exists
 *     only so the approval card can draw labeled rows.
 *   - `Message.source` is a message-origin classifier inferred at the IPC
 *     boundary; `ImageContent.source` is a base64-vs-url payload descriptor.
 *     Same name, unrelated meanings, and merging them would be a type error
 *     in the making.
 *   - `Message.thinking` is a stored column; `ThinkingContent.thinking` is a
 *     content block replayed to the provider.
 *   - `Message.status` is a row status; `HookEventPayload.status` is the hook
 *     outcome (`ok | error | timeout | skipped`).
 *   - `providerId` / `model` / `api` on `Message` describe a past call, so
 *     `isSameModel` reads them from the row; the same three on
 *     `AssistantMessage` are the live provider handshake.
 *
 * `test/23-wire-field-classification.test.ts` asserts the computed divergence
 * set equals exactly this list. A field that starts disagreeing is a
 * deliberate act: either fix the classification, or add a row here and say
 * why.
 */
export const DECLARED_FIELD_DIVERGENCES: Readonly<Record<string, string>> = {
  metadata: 'Message=storage (persisted blob) vs ToolResultWire=json-wire (MCP result metadata, stored AND sent) vs PermissionRequestEvent=ui-view (approval-card display rows).',
  thinking: 'Message=storage (a stored column) vs ThinkingContent=json-wire (a block replayed to the provider).',
  status: 'Message=storage (row status) vs HookEventPayload=json-wire (hook outcome enum).',
  duration_ms: 'Message=storage (row column) vs ToolResultWire=json-wire (a wire field).',
  source: 'ImageContent=json-wire (base64 vs url payload descriptor) vs Message=storage (origin classifier). Unrelated meanings sharing a name.',
  providerId: 'Message=storage (past call, read by isSameModel) vs AssistantMessage=json-wire (live handshake).',
  model: 'Message=storage (past call) vs AssistantMessage=json-wire (live handshake) vs UsageCall=json-wire (per-call snapshot).',
  api: 'Message=storage (past call) vs AssistantMessage=json-wire (live handshake).',
};

/** One-line justification per classified field that is not obviously `json-wire`. */
export const CLASS_RATIONALE: Readonly<Record<string, string>> = {
  'Message.visibility':
    'Read only by the renderer. A hidden message still reaches the model and the store, so "visible" carries no provider or storage meaning.',
  'Message.displayContent': 'Produced by the renderer projection, consumed by the renderer.',
  'Message.source': 'Inferred at the IPC boundary; describes a past call rather than instructing the next one.',
  'Message.tokenUsage': 'Accounting on the row. The turn-level aggregate is published separately on the wire as `assistant.usage`.',
  'Message.metadata': 'The persisted row blob, not a provider body.',
  'ToolUseContent.groupId': 'Groups tool rows in the renderer. Not sent to a provider.',
  'ToolUseContent.progressTitle': 'Sanitized display title; renderer-only by its own doc comment.',
  'ToolUseContent.progressSource': 'Drives which icon the row shows.',
  'PermissionRequestEvent.metadata': 'Carries `toolParamsDisplay`, which renders as labeled rows in the approval card.',
  'AgentProgressEvent.hookEvent': 'Drawn as a hook row; the worker flattens it into the envelope.',
  'DeferredToolExtras.pendingExtraResult': 'A Promise. Contract §A forbids Promise on the wire.',
  'DeferredToolExtras.pendingContext':
    'A Promise, and never persisted. Contract §A forbids Promise on the wire.',
  'ToolResultWire.error':
    "Kept as the legacy optional boolean. The event vocabulary's `ToolCallOutcome` exists to stop NEW producers inventing a false success; retro-fitting it would fabricate an outcome for every stored row whose producer omitted the bit.",
  'ThinkingContent.encrypted':
    'A string here, a boolean in the event vocabulary. Recorded as a divergence rather than reconciled — see content.ts.',
  'TextContent.annotations':
    'Capture-only per its own doc comment; never replayed to a provider.',
  ...Object.fromEntries(
    Object.entries(DECLARED_FIELD_DIVERGENCES).map(([field, why]) => [`${field} (divergent)`, why]),
  ),
};
