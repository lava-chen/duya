/**
 * The control-plane census.
 *
 * ## What this is for
 *
 * Plan 587 T3.2 item 4: `生成控制面census：start/cancel、permission、mailbox、
 * status/probe、resume、workflow相关；每项生产者/handler/consumer和schema对应。`
 *
 * A census that drifts from the code is worse than none, because a reader who
 * finds one wrong row stops believing the rest. So this is not prose with a
 * table appended — it is data, declared in `src/` where it is typechecked, and
 * held to the code by `test/control-plane-census.test.ts`, which fails when:
 *
 *  - a declared `producer` / `handler` / `consumer` path no longer exists;
 *  - a declared `schema` symbol is not exported by the module that owns it;
 *  - a control-plane event type exists in the registry but has no row here, or
 *    a row names an event type the registry does not have;
 *  - a `critical` event is not classified consistently with the namespace rule.
 *
 * The last two are the ones that make it a census rather than a list. A list
 * can be complete on the day it is written and wrong the next morning; these
 * fail instead.
 *
 * ## Why it is hand-declared and not generated
 *
 * Generated would mean reading the source at build time, and a generated
 * census can only report what a regex can see. Three of the four fields —
 * consumer, schema, and whether a row is actually load-bearing — are not
 * visible in the text of a function. A census that says "there is a consumer"
 * because it found an `import` is exactly the kind of claim that reads as
 * verified and is not.
 *
 * So the rows are hand-written and the TEST is the generator's replacement: the
 * assertions above are mechanical, and they are the part that would rot. The
 * judgement — what consumes a permission decision — stays with a person, which
 * is the part that should.
 *
 * ## The adapter rows
 *
 * `translator` and `projector` are listed as ADAPTERS and marked as such. They
 * are not the authority on what a legacy SSE field means: `LegacySseFrame` is
 * typed from what the wire does, and the projector's default arm is a refusal,
 * not a fallback definition. The `authority` field is what a future reader
 * checks before treating a row as a source of truth about the wire.
 */

/** Which side of the boundary a row describes. */
export type CensusPlane = 'control' | 'event';

/**
 * Whether a row is authoritative about the wire.
 *
 * `protocol` rows are the contract. `adapter` rows describe a translation and
 * must never be cited as the definition of a legacy field.
 */
export type CensusAuthority = 'protocol' | 'adapter';

export interface CensusRow {
  /** The message this row is about. */
  readonly message: string;
  readonly plane: CensusPlane;
  /** Who creates it. A path, plus the symbol, so a rename is a failing test. */
  readonly producer: string;
  /** Who acts on it. */
  readonly handler: string;
  /** Who reads the result. */
  readonly consumer: string;
  /** The symbol that defines the shape, in the module that owns it. */
  readonly schema: string;
  /** `run.start` and friends gate on capability; events gate on `since`. */
  readonly since: string;
  readonly authority: CensusAuthority;
  /** What breaks if this row is wrong. Why the row exists. */
  readonly note: string;
}

/**
 * Every control-plane message the runtime can produce, act on, or consume.
 *
 * The families the task names, and each row answers the same four questions, so
 * a reader comparing two rows is comparing the same facts.
 */
export const CONTROL_PLANE_CENSUS: readonly CensusRow[] = [
  // ── start ───────────────────────────────────────────────────────────────
  {
    message: 'run.started',
    plane: 'event',
    producer: 'packages/agent-runtime/src/controller.ts:RunController.start',
    handler: 'packages/agent-protocol/src/run-ledger.ts:RunLedger.emit',
    consumer: 'packages/agent-runtime/src/run-session.ts:RunSession.observe',
    schema: 'packages/agent-protocol/src/events/required.ts:REQUIRED_FIELDS',
    since: '1.0 (schema rev 1)',
    authority: 'protocol',
    note: 'CRITICAL. Emitted BEFORE dispatch, flushed on its own. The only event that cannot be reconstructed from later events.',
  },
  {
    message: 'run.start',
    plane: 'control',
    producer:
      'apps/desktop/src/main/agents/server/router.ts (chat POST handler) and ' +
      'packages/agent/src/process/headless-run-host.ts:HeadlessRunHost.start (H8.1)',
    handler: 'packages/agent-runtime/src/controller.ts:RunController.start',
    consumer: 'packages/agent-protocol/src/events/registry.ts:CONTROL_GATE',
    schema: 'packages/agent-protocol/src/manifest.ts:RunManifest',
    since: '1.0 (schema rev 1), no capability',
    authority: 'protocol',
    note: 'R2.1/R2.2. The manifest is the frozen decision; a start that cannot be recorded is not a start (RunStartError). H8.1 added a SECOND producer: the headless CLI, which opens a run through the same controller over the in-process transport rather than a worker pipe. Two producers, one entry.',
  },
  // ── cancel ──────────────────────────────────────────────────────────────
  {
    message: 'run.cancel',
    plane: 'control',
    producer:
      'apps/desktop/src/main/agents/server/router.ts (interrupt path) and ' +
      'packages/agent/src/process/headless-run-host.ts:HeadlessRun.cancel (H8.1)',
    handler: 'packages/agent-runtime/src/controller.ts:RunController.cancel',
    consumer: 'packages/agent-runtime/src/transport/execution-channel.ts:ExecutionHandle.stop',
    schema: 'packages/agent-protocol/src/run.ts:StopDisposition',
    since: '1.0 (schema rev 1), no capability',
    authority: 'protocol',
    note: 'R2.3. Reports requested/applied/terminal. A stop nobody answered is `escalated`, never success. H8.1 added a second producer: the headless CLI cancels through the same controller, and the in-process channel maps the stop onto the agent interrupt.',
  },
  {
    message: 'run.completed',
    plane: 'event',
    producer: 'packages/agent-runtime/src/run-session.ts:RunSession.settle',
    handler: 'packages/agent-protocol/src/run-ledger.ts:RunLedger.emit',
    consumer: 'apps/desktop/src/main/agents/server/router.ts (run row + SSE terminal)',
    schema: 'packages/agent-protocol/src/events/required.ts:REQUIRED_FIELDS',
    since: '1.0 (schema rev 1)',
    authority: 'protocol',
    note: 'CRITICAL. Synthesised when the executor exits with no terminal, so a run never ends in silence.',
  },
  {
    message: 'run.failed',
    plane: 'event',
    producer: 'packages/agent-runtime/src/controller.ts:RunController.failStart',
    handler: 'packages/agent-protocol/src/run-ledger.ts:RunLedger.emit',
    consumer: 'packages/agent-core/src:resolveRunOutcome',
    schema: 'packages/agent-protocol/src/events/required.ts:REQUIRED_FIELDS',
    since: '1.0 (schema rev 1)',
    authority: 'protocol',
    note: 'CRITICAL. Also the terminal a persistence barrier failure rewrites to; a degraded run is not a completed one.',
  },
  // ── permission ──────────────────────────────────────────────────────────
  {
    message: 'permission.requested',
    plane: 'event',
    producer: 'packages/agent-runtime/src/translate/chat-event-translator.ts:translateFrame',
    handler: 'packages/agent-protocol/src/run-ledger.ts:RunLedger.emit',
    consumer: 'apps/desktop/src/main (approval coordinator) -> renderer permission card',
    schema: 'packages/agent-protocol/src/events/required.ts:REQUIRED_FIELDS',
    since: '1.0 (schema rev 1)',
    authority: 'protocol',
    note: 'CRITICAL. kind/mode/expiresAt come from the runtime, never inferred from the tool name (G-2).',
  },
  {
    message: 'permission.respond',
    plane: 'control',
    producer: 'apps/desktop/src/main/agents/server/router.ts (approval POST)',
    handler: 'packages/agent-runtime/src/controller.ts:RunController.respondPermission',
    consumer: 'packages/agent/src (permission coordinator on the worker side)',
    schema: 'packages/agent-protocol/src/permission.ts:PermissionResponse',
    since: '1.0 (schema rev 1), no capability',
    authority: 'protocol',
    note: 'R2.4. Three separate vocabularies deliberately: protocol allow|allow_always|deny|defer, internal policy, and the response.',
  },
  {
    message: 'permission.resolved',
    plane: 'event',
    producer: 'packages/agent-runtime/src/controller.ts:RunController.respondPermission',
    handler: 'packages/agent-protocol/src/run-ledger.ts:RunLedger.emit',
    consumer: 'packages/agent-runtime/src/run-session.ts:RunSession.observe',
    schema: 'packages/agent-protocol/src/events/required.ts:REQUIRED_FIELDS',
    since: '1.0 (schema rev 1)',
    authority: 'protocol',
    note: 'CRITICAL. Every decision is recorded, including timeout and cancellation.',
  },
  {
    message: 'permission.expired',
    plane: 'event',
    producer: 'NOT YET WIRED (no expiry timer emits it in the runtime today)',
    handler: 'packages/agent-protocol/src/run-ledger.ts:RunLedger.emit',
    consumer: 'apps/desktop/src/main (approval coordinator)',
    schema: 'packages/agent-protocol/src/events/required.ts:REQUIRED_FIELDS',
    since: '1.0 (schema rev 1), requires permission_expiry',
    authority: 'protocol',
    note: 'CRITICAL. UNSUPPORTED as a producer: the event is declared and ledger-enforced, and nothing emits it yet. Ordering before permission.resolved{deny,timeout} is the ledger\'s to enforce when a producer arrives.',
  },
  // ── mailbox ─────────────────────────────────────────────────────────────
  {
    message: 'mailbox.deposit',
    plane: 'control',
    producer: 'apps/desktop/src/main (user-queued follow-up while a run is live)',
    handler: 'NOT YET WIRED',
    consumer: 'NOT YET WIRED',
    schema: 'NOT YET DEFINED',
    since: 'unsupported',
    authority: 'protocol',
    note: 'UNSUPPORTED, recorded rather than omitted. No mailbox message type exists in the protocol, and the runtime has no handler. A row that did not exist would read as an oversight; this one reads as a gap with a name.',
  },
  {
    message: 'mailbox.drain',
    plane: 'control',
    producer: 'NOT YET WIRED',
    handler: 'NOT YET WIRED',
    consumer: 'NOT YET WIRED',
    schema: 'NOT YET DEFINED',
    since: 'unsupported',
    authority: 'protocol',
    note: 'UNSUPPORTED. Drain is on the CONTROL plane, not the event plane: a mailbox is a place the host writes to, and nothing is emitted until a run is resumed. Depends on execution resume (D7), which is explicitly not claimed.',
  },
  // ── status / probe ──────────────────────────────────────────────────────
  {
    message: 'assistant.status',
    plane: 'event',
    producer: 'packages/agent-runtime/src/translate/chat-event-translator.ts:translateFrame',
    handler: 'packages/agent-protocol/src/run-ledger.ts:RunLedger.emit',
    consumer: 'apps/desktop/src/main/agents/server/router.ts (forwards to the renderer status line)',
    schema: 'packages/agent-protocol/src/events/required.ts:REQUIRED_FIELDS',
    since: '1.0 (schema rev 1)',
    authority: 'protocol',
    note: 'Volatile. A human-readable line, never authority for anything.',
  },
  {
    message: 'runtime.probe',
    plane: 'control',
    producer: 'packages/agent-runtime/src/controller.ts:RunController.probe',
    handler: 'packages/agent-runtime/src/controller.ts:RunController.probe',
    consumer: 'packages/agent-protocol/src/compatibility.ts:negotiate',
    schema: 'packages/agent-protocol/src/capabilities.ts:RuntimeCapabilities',
    since: '1.0 (schema rev 1), no capability',
    authority: 'protocol',
    note: 'Cancellation, permission, event replay, execution resume and determinism are enumerated as separate booleans so an absent one is a declared absence. H8.1 added a second HOST that probes through the same builder (the headless CLI), which reports NO_RESUME and `deterministic: false` — the same refusals — plus `permissionExpiryClock: \'absent\'` because a headless host has no permission coordinator.',
  },
  {
    message: 'run.paused',
    plane: 'event',
    producer: 'NOT YET WIRED',
    handler: 'packages/agent-protocol/src/run-ledger.ts:RunLedger.emit',
    consumer: 'NOT YET WIRED',
    schema: 'packages/agent-protocol/src/events/required.ts:REQUIRED_FIELDS',
    since: '1.0 (schema rev 1)',
    authority: 'protocol',
    note: 'CRITICAL. UNSUPPORTED as a producer: declared in the registry and enforced by the ledger, with nothing emitting it yet. Listed because a critical event with no producer is a gap, and gaps are what this census is for.',
  },
  // ── resume ──────────────────────────────────────────────────────────────
  {
    message: 'run.resume',
    plane: 'control',
    producer: 'NOT YET WIRED',
    handler: 'packages/agent-runtime/src/controller.ts:RunController.resume',
    consumer: 'NOT YET WIRED',
    schema: 'packages/agent-protocol/src/resume.ts',
    since: '1.0 (schema rev 1), requires replay',
    authority: 'protocol',
    note: 'UNSUPPORTED and it says so: resume() throws with the reason. Plan 587 D7.1 built the checkpoint SCHEMA, the side-effect ledger and the fence, and proved a real kill leaves a recoverable record — but nothing READS that record to continue an execution, so the probe still refuses every resume boundary. A resume that accepted a manifest without comparing fingerprints would be the "silently different run" the protocol exists to prevent.',
  },
  {
    message: 'checkpoint.saved',
    plane: 'event',
    producer: 'NOT YET WIRED',
    handler: 'packages/agent-protocol/src/run-ledger.ts:RunLedger.emit',
    consumer: 'packages/agent-runtime/src/checkpoint/checkpoint-store.ts:InMemoryCheckpointStore',
    schema: 'packages/agent-protocol/src/events/required.ts:REQUIRED_FIELDS',
    since: '1.0 (schema rev 1), requires checkpoint_resume',
    authority: 'protocol',
    note: 'CRITICAL. The ledger rejects a checkpoint pointing at a seq this run never emitted, and D7.1 adds the store-side half of the same rule (a commit naming an uncommitted seq is refused). NO PRODUCER yet: the payload, its digest and the fence exist, but no run emits this event yet, because nothing produces checkpoints on the live path. Listed because a critical event with a consumer and no producer is a gap, and gaps are what this census is for.',
  },
  {
    message: 'checkpoint.recovered',
    plane: 'control',
    producer: 'packages/agent-runtime/src/checkpoint/checkpoint-store.ts:recoverRun',
    handler: 'packages/agent-runtime/src/checkpoint/checkpoint-store.ts:recoverRun',
    consumer: 'NOT YET WIRED (no host calls recoverRun yet — execution resume is D7.3)',
    schema: 'packages/agent-runtime/src/checkpoint/checkpoint-store.ts:RecoveryOutcome',
    since: 'unsupported as a control-plane message',
    authority: 'adapter',
    note: 'D7.1. ADAPTER, not a protocol event: recovery forms a new attempt/epoch with a monotonic fence and returns a typed refusal when the digest or manifest fingerprint disagrees. It is proven by fault injection against a real killed process (apps/desktop/src/main/__tests__/d71-kill-recovery.test.ts) but has NO production caller, so it is declared here rather than presented as a shipped capability.',
  },
  // ── workflow ────────────────────────────────────────────────────────────
  {
    message: 'workflow_run',
    plane: 'event',
    producer: 'packages/agent/src/process/worker-protocol.ts:buildWorkflowRunEvent',
    handler: 'packages/agent-runtime/src/translate/chat-event-translator.ts:translateFrame',
    consumer: 'apps/desktop/src/renderer (workflow timeline)',
    schema: 'packages/agent/src/process/worker-protocol.ts:WorkflowRunEvent',
    since: 'unsupported in the protocol registry',
    authority: 'adapter',
    note: 'ADAPTER. The legacy frame has no protocol event, so this is carried forward rather than modelled. T3.1 recorded it as absent from WorkerEvent; T3.2 closes the union and leaves the modelling to the router cutover.',
  },
  {
    message: 'research_updated',
    plane: 'event',
    producer: 'packages/agent/src/process/worker-protocol.ts:buildResearchUpdatedEvent',
    handler: 'packages/agent-runtime/src/translate/chat-event-translator.ts:translateFrame',
    consumer: 'apps/desktop/src/renderer (research panel)',
    schema: 'packages/agent/src/process/worker-protocol.ts:ResearchUpdatedEvent',
    since: 'unsupported in the protocol registry',
    authority: 'adapter',
    note: 'ADAPTER. Same shape as workflow_run: a real, produced event with no protocol counterpart yet.',
  },
  {
    message: 'assistant.goal_updated',
    plane: 'event',
    producer: 'packages/agent-runtime/src/translate/chat-event-translator.ts:translateFrame',
    handler: 'packages/agent-protocol/src/run-ledger.ts:RunLedger.emit',
    consumer: 'apps/desktop/src/renderer (goal panel)',
    schema: 'packages/agent-protocol/src/events/required.ts:REQUIRED_FIELDS',
    since: '1.0 (schema rev 1)',
    authority: 'protocol',
    note: 'Durable. The one workflow-adjacent message that IS modelled, and the model the other two should reach.',
  },
  {
    message: 'assistant.text_block',
    plane: 'event',
    producer: 'packages/agent-runtime/src/translate/chat-event-translator.ts:translateFrame',
    handler: 'packages/agent-protocol/src/run-ledger.ts:RunLedger.emit',
    consumer: 'packages/agent-runtime/src/replay/transcript-snapshot.ts:buildTranscriptSnapshot',
    schema: 'packages/agent-protocol/src/events/required.ts:REQUIRED_FIELDS',
    since: '1.0 (schema rev 1)',
    authority: 'protocol',
    note: 'Durable. The complete block, distinct from the ephemeral `assistant.text_delta`. This is the event a real completed turn actually persists, and it is what the E4.4 ledger carries today.',
  },
  {
    message: 'assistant.thinking_block',
    plane: 'event',
    producer: 'packages/agent-runtime/src/translate/chat-event-translator.ts:translateFrame',
    handler: 'packages/agent-protocol/src/run-ledger.ts:RunLedger.emit',
    consumer: 'packages/agent-runtime/src/replay/transcript-snapshot.ts:buildTranscriptSnapshot',
    schema: 'packages/agent-protocol/src/events/required.ts:REQUIRED_FIELDS',
    since: '1.0 (schema rev 1)',
    authority: 'protocol',
    note: 'Durable. Indexed within its OWN content array, so a message that reasons and then answers carries both without either overwriting the other.',
  },
  {
    message: 'assistant.usage',
    plane: 'event',
    producer: 'packages/agent-runtime/src/translate/chat-event-translator.ts:translateFrame',
    handler: 'packages/agent-protocol/src/run-ledger.ts:RunLedger.emit',
    consumer: 'apps/desktop/src/renderer (token/cost readout)',
    schema: 'packages/agent-protocol/src/events/required.ts:REQUIRED_FIELDS',
    since: '1.0 (schema rev 1)',
    authority: 'protocol',
    note: 'Durable, and capability-gated on `usage_accounting`. A host that cannot account for cost is WITHHELD this event rather than sent it and dropped it, so its absence on such a host is the contract, not drift.',
  },
  {
    message: 'assistant.message_finalized',
    plane: 'event',
    // Two producers, because there are two frame producers in this codebase and
    // the translation being shared does not make the production shared. The
    // Desktop path's frame is written by the worker subprocess; the headless
    // path's (and therefore the CLI's) by the in-process host. Naming only the
    // translator would have been the more flattering half of the truth.
    producer:
      'packages/agent/src/process/agent-process-entry.ts:handleChatCommand (worker subprocess) and ' +
      'packages/agent/src/process/headless-run-host.ts:createAgentExecutionChannel (headless + CLI)',
    handler: 'packages/agent-protocol/src/run-ledger.ts:RunLedger.emit',
    consumer: 'packages/agent-runtime/src/replay/transcript-snapshot.ts:buildTranscriptSnapshot',
    schema: 'packages/agent-protocol/src/events/required.ts:REQUIRED_FIELDS',
    since: '1.0 (schema rev 1)',
    authority: 'protocol',
    note: 'Durable. Produced on the wire as `chat:message_finalized` (worker-protocol.ts:AgentMessageFinalizedEvent) and translated at the ONE seam every host crosses (`translateFrame`), so Desktop, headless and CLI all emit it. The frame exists because `chat:done` carries neither required field: before it, no host could produce this event without inventing the two facts it exists to record. It is emitted AHEAD of `chat:done` — the message stops changing before the run ends — and `messageId` is the runtime\'s run-scoped `ctx.messageId`, NOT the producer\'s own id, so the finalized message joins the per-block events it supersedes in transcript-snapshot.ts. KNOWN NARROWING, stated rather than hidden: the payload\'s `MessageContent` has four members and the transcript vocabulary has six, so `image` and `provider_block` blocks are preserved verbatim under `providerMeta.untranslatedBlocks` instead of being dropped; and a stop reason the event union cannot state (`max_turns`, `tool_use`, `repeated_tool_calls`) is REFUSED rather than coerced, so those turns carry no finalized event.',
  },
  {
    message: 'extension.custom',
    plane: 'event',
    producer: 'any peer (forward-compatibility path)',
    handler: 'packages/agent-runtime/src/events/structural-dispatch.ts:classifyUnknownType',
    consumer: 'packages/agent-runtime/src/events/event-emitter.ts (diagnostic only)',
    schema: 'packages/agent-protocol/src/events/required.ts:REQUIRED_FIELDS',
    since: '1.0 (schema rev 1)',
    authority: 'protocol',
    note: 'The legal-unknown path. Ignored, diagnosed, never persisted — which is what makes ignoring it safe rather than a lost event.',
  },
];

/** The marker for a row whose half is not built yet. Named so a test can find them. */
export const NOT_YET = 'NOT YET';

/** Rows that name something that does not exist yet. Grouped, so a reader sees the gaps. */
export function censusGaps(): readonly CensusRow[] {
  return CONTROL_PLANE_CENSUS.filter((row) => row.producer.includes(NOT_YET) || row.handler.includes(NOT_YET));
}
