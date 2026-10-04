/**
 * `@duya/agent-runtime` — the run execution engine.
 *
 * ## The line this package draws
 *
 * It owns **run identity**: the `runId`, the run-scoped `seq`, the protocol
 * `RunEvent` stream, the terminal decision, and the projection back onto the
 * legacy SSE contract the product UI already speaks.
 *
 * It does not own the model loop. `@duya/agent` is the executor today, behind
 * the `ExecutionChannel` seam, and replacing it — a rewritten harness, a
 * sandbox, a different provider stack — must not require touching run identity
 * or persistence. That is the entire reason this layer exists, and it is why
 * `docs/architecture/06-migration-plan.md` M5 is better taken as a vertical
 * slice than as four file-moving PRs.
 *
 * It does not own storage. `RunPersistence` is supplied by the Control Plane.
 *
 * ## Why the projector lives here and not in the host
 *
 * The renderer must not change, and the renderer has never heard of
 * `@duya/agent-protocol`. Keeping the legacy vocabulary on this side of the
 * boundary means the host's only job is to forward a frame it already had —
 * which is what makes the "no UI change" claim a property of the code rather
 * than a promise.
 */

export { RunController, RunStartError, runtimeEventTypes } from './controller.js';
export type {
  FrameOutcome,
  RunControllerOptions,
  RunStartAcceptance,
  RunStartStage,
  RuntimeIdentity,
} from './controller.js';

// `RunHandle` is re-exported rather than re-declared: the protocol owns the
// shape, and a host that had to cast around a second definition would be able
// to drift from the contract's `RunHandle`.
export type { RunHandle } from '@duya/agent-protocol';

export { RunEventStream, RunSession, isTerminal } from './run-session.js';
export type { ObserveResult, RunPersistence, RunSessionOptions, RunTranscriptReader } from './run-session.js';

// Plan 587 T3.2 — the single emit entry point, the structural dispatch that
// decides what a peer may say, and the control-plane census.
export { RunEventEmitter, isTerminalEventType } from './events/event-emitter.js';
export type {
  EmitAcceptance,
  EmitRejection,
  EmitRejectionCode,
  EmitResult,
  InboundAcceptance,
  InboundResult,
  RunEventEmitterPorts,
  TerminalRelease,
} from './events/event-emitter.js';

export { classifyMessageKind, dispatchMessage } from './events/structural-dispatch.js';
export type {
  DispatchAccepted,
  DispatchAcceptedControl,
  DispatchExtension,
  DispatchIssue,
  DispatchOptions,
  DispatchRejection,
  DispatchResult,
  InboundMessageKind,
} from './events/structural-dispatch.js';

export { CONTROL_PLANE_CENSUS, censusGaps, NOT_YET } from './control-plane-census.js';
export type { CensusAuthority, CensusPlane, CensusRow } from './control-plane-census.js';

// Plan 587 T3.3 — the scoped cursor, the window it is checked against, and the
// live/replay handoff. The replay path is read-only by construction: it holds a
// `RunEventReader` and a live tap, and no ledger, so it cannot mint a seq,
// append, or start an executor.
export { resolveReplay, InMemoryRunEventStore } from './replay/replay-repository.js';
export type {
  AppendReceipt,
  ReplayOutcome,
  RunEventIdentityConflict,
  RunEventReader,
} from './replay/replay-repository.js';

export { openReplaySubscription } from './replay/replay-subscription.js';
export type {
  OpenSubscriptionInput,
  RunEventSubscription,
  RunEventSubscriptionReceipt,
  RunEventTap,
} from './replay/replay-subscription.js';

export { buildTranscriptSnapshot, openBlock } from './replay/transcript-snapshot.js';
export type {
  RecoveredBlock,
  TranscriptRebuildReport,
  TranscriptSnapshot,
} from './replay/transcript-snapshot.js';

export { handleReplayOutcome } from './replay/replay-guards.js';
export type { ReplayOutcomeStatus } from './replay/replay-guards.js';

// Plan 587 T3.4 — coalescing, the byte bound, and the channel separation.
//
// The batcher is a PRODUCER-side filter that runs BEFORE the emitter, so a
// coalesced delta never receives a `seq` at all and the live stream stays dense
// (contract §F allows gaps in the durable store and nowhere else). `RunEventEmitter`
// is unchanged and remains the single minting authority.
export {
  COALESCABLE_EVENT_TYPES,
  DeltaBatcher,
  batchedPublisher,
  coalesceKeyId,
  coalesceKeyOf,
  defaultMeasureBytes,
  isCoalescable,
  systemBatchClock,
} from './events/coalesce.js';
export type {
  BatchClock,
  BatchThresholds,
  BatchTimer,
  CoalesceKey,
  CoalesceScope,
  CoalescingMetrics,
  CoalescingReceipt,
  DeltaBatcherOptions,
  EventMinter,
  OfferResult,
} from './events/coalesce.js';

export { BoundedEventQueue, defaultEnvelopeBytes } from './events/backpressure.js';
export type {
  BackpressureMetrics,
  BoundedEventQueueOptions,
  DeliveryGap,
  EnqueueOutcome,
  OverflowAction,
} from './events/backpressure.js';

export { FanOutBroker } from './events/stream-fanout.js';

export {
  NEVER_QUEUED_CONTROL_METHODS,
  TRANSPORT_FLOW_CONTROL,
  assertNoPerTypePauseClaim,
  bypassesEventQueue,
  cancelReachesRunUnderSaturatedEventChannel,
  supportsPerTypePause,
} from './events/control-channel.js';
export type {
  ControlChannelPort,
  ControlChannelReport,
  ControlDelivery,
  ControlOnlyMethods,
  ControlChannelScope,
  FlowControlCapability,
} from './events/control-channel.js';

export type { CoalescingGuards } from './events/coalesce-guards.js';

// Plan 587 M5.5 -- the one owner of a spawned child's lifetime. See
// `process/process-scope.ts` for why the platform kill strategy is an injected
// port rather than a function this package owns.
export { createProcessScope } from './process/process-scope.js';
export type {
  ProcessScope,
  ProcessScopeOptions,
  ProcessSpawner,
  ProcessTreeKiller,
  ScopedCloser,
  ScopedProcess,
  ScopedTimer,
} from './process/process-scope.js';

export {
  translateFrame,
  classifyToolOutcome,
  classifyErrorCode,
  unmappedDiagnostic,
} from './translate/chat-event-translator.js';
export type { RawFrame, TranslateContext, TranslateResult } from './translate/chat-event-translator.js';

export { projectToLegacyFrame } from './project/legacy-sse-projector.js';

export {
  LEGACY_SSE_TYPES,
  INTERNAL_SSE_TYPES,
  isInternalSseType,
  readTextContent,
} from './legacy-sse-contract.js';
export type { LegacySseFrame, LegacySseType } from './legacy-sse-contract.js';

export type {
  ExecutionChannel,
  ExecutionHandle,
  ExecutionSink,
  RunStartInput,
  StopDisposition,
  StopReceipt,
  StopRequest,
} from './transport/execution-channel.js';
export {
  ExecutionDispatchError,
  runInputRevision,
} from './transport/execution-channel.js';

// Plan 587 T3.5 -- the three transports, the capability probe, the taxonomy.
//
// The three adapters are deliberately NOT collapsed behind one implementation.
// What they share is the PORT (`transport-port.js`), and the port's intake
// takes a RAW frame, so no adapter can mint a `seq`. That is the mechanical
// reason the equivalence claim in `equivalence.ts` is a structural property
// rather than a convention three code paths must keep agreeing on.

export {
  LINE_CODEC_LIMITS,
  NdjsonLineDecoder,
  encodeNdjsonLine,
  parseNdjsonLine,
} from './transport/line-codec.js';

// Plan 600 S2 -- the awaitable hop on the executor-facing sink.
//
// Exported together with the type it serves, because a producer that cannot name
// `awaitMaybe` cannot be expected to await, and a producer that does not await
// leaves the byte bound exactly as advisory as it was before.
export { awaitMaybe } from './transport/execution-channel.js';

export type {
  RawFrameIntake,
  RuntimeTransport,
  TransportConnectOptions,
  TransportDiagnostics,
  TransportPrivateChannel,
  TransportRun,
} from './transport/transport-port.js';

export { SubprocessTransport } from './transport/subprocess-transport.js';
export type { SubprocessScenario, SubprocessTransportOptions } from './transport/subprocess-transport.js';

export { InProcessTransport } from './transport/in-process-transport.js';
export type { InProcessTransportOptions } from './transport/in-process-transport.js';

export {
  HttpSseClient,
  HttpSseServer,
  SSE_DISCONNECT,
  SSE_END,
  SSE_EVENT,
  SSE_FRAME,
  SSE_REPLAY,
  parseFrameStream,
  parseSseStream,
} from './transport/http-sse-transport.js';
export type {
  HttpSseClientOptions,
  HttpSseServerOptions,
  HttpSseSubscriptionResult,
  RegisteredRun,
  ReplayPreamble,
} from './transport/http-sse-transport.js';

export {
  CapabilityProbeError,
  UNPROVEN_CAPABILITIES,
  admitIncoming,
  assertTransportCanStart,
  enumerateProbe,
  flowControlOf,
  negotiateEventAdmission,
  probeRuntimeCapabilities,
} from './transport/capability-probe.js';
// Plan 587 D7.1 — the checkpoint / side-effect state machine, and the fence.
export { InMemoryCheckpointStore, recoverRun } from './checkpoint/checkpoint-store.js';
export type {
  CheckpointStore,
  CommitReceipt,
  EmittedSeqProbe,
  RecoveryOutcome,
  RecoveryRefusal,
  RecoveryResult,
  StoredCheckpoint,
} from './checkpoint/checkpoint-store.js';
export { planBranch } from './checkpoint/branch-plan.js';
export type { BranchPlan, BranchResult, InheritedEvent } from './checkpoint/branch-plan.js';
// What D7.1 did NOT build, declared in code so a consumer can read the gap
// rather than infer it from an absent function.
export { SUPPORTED_AFTER_D71, UNSUPPORTED_AFTER_D71, unsupportedSummary } from './checkpoint/unsupported.js';
export type { UnsupportedCapability } from './checkpoint/unsupported.js';
export type {
  AdmissionReport,
  CapabilityProbeErrorDetail,
  CapabilityProbeInput,
  EventAdmission,
  GateTable,
  ProbeEnumeration,
  UnprovenCapability,
} from './transport/capability-probe.js';

export {
  TRANSPORT_ERROR_CATEGORIES,
  categoriseErrorCode,
  errorPolicy,
  explainError,
} from './transport/error-taxonomy.js';
export type {
  CallerAction,
  TransportErrorCategory,
  TransportErrorPolicy,
} from './transport/error-taxonomy.js';

export {
  TRANSPORT_LOCAL_PAYLOAD_FIELDS,
  assertNormalisationIsHonest,
  canonicalise,
  compareRuns,
  normaliseEnvelope,
  normaliseResult,
} from './transport/equivalence.js';
export type {
  NormalisationViolation,
  NormalisedEvent,
  NormalisedPayload,
  NormalisedResult,
  NormalisedValue,
} from './transport/equivalence.js';

// Type-level guards. Present in `src/` on purpose: every package's tsconfig
// excludes `test/`, so an assertion in a test directory is checked by nothing.
export type {
  COMPARED_EVENT_TYPES_ARE_REGISTRY_TYPES,
  ERROR_CATEGORY_LIST_IS_DERIVED,
  RAW_FRAME_INTAKE_ACCEPTS_ONLY_RAW_FRAMES,
  TRANSPORT_ERROR_CATEGORIES_ARE_EXHAUSTIVE,
  TRANSPORT_PORTS_CARRY_NO_RUN_STATE,
} from './transport/transport-guards.js';

// Plan 600 S2 -- the RunEngine port contract, and the engine that implements it.
//
// The ports and the implementation are exported TOGETHER on purpose. Exporting
// the interface alone would let `headless-run-host.ts` reach for it and believe
// the loop had moved, which is the exact acceptance-gate failure `04` section 0
// records: a real controller around an executor that still calls
// `duyaAgent.streamChat` passes the old gate while the loop never moved. What a
// consumer needs in order to be honest about execution is BOTH the shape and the
// thing that drives it.
export { RunEngineImpl } from './engine/run-engine.js';
export type { EngineExit, EngineExitReason, EngineRunReport, RunEngineOptions } from './engine/run-engine.js';

export type {
  ApprovalPort,
  ApprovalRequest,
  ApprovalScope,
  ApprovalVerdict,
  AssembledTurn,
  AttemptLeasePort,
  BudgetPort,
  CheckpointPort,
  ContextPort,
  ExtensionContext,
  ExtensionContribution,
  ExtensionContributor,
  ExtensionPhase,
  ExtensionPort,
  ModelContentBlock,
  ModelFrame,
  ModelMessage,
  ModelPort,
  ModelRequest,
  ModelStopReason,
  ResolvedPart,
  RunEngine,
  RunEnginePorts,
  RunEventStorePort,
  RunExecutionHandle,
  RunExecutionRequest,
  RunInputSnapshot,
  SteeringDirective,
  SubtaskHandle,
  SubtaskRegistration,
  SubtaskRegistry,
  SubtaskSweepRule,
  SubtaskTermination,
  SubtaskTerminationReason,
  TerminalCandidate,
  ToolAttemptRecord,
  ToolCallRequest,
  ToolDescriptor,
  ToolDispatchTicket,
  ToolDiscardReason,
  ToolDrainItem,
  ToolOutcome,
  ToolPort,
  ToolResultRecord,
  ToolSideEffectLedger,
  TransientContextFragment,
  TransientFragmentKind,
  DeferredToolContext,
  PendingTransientContextFragment,
  ResolvedTransientContextFragment,
  SubagentProgressItem,
  TurnAssemblyInput,
  TurnOutputPort,
  TurnOutputSummary,
  WorkerAdapterSurface,
} from './engine/ports.js';
export type { AttachmentInput } from './engine/ports.js';
