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
export type { ObserveResult, RunPersistence, RunSessionOptions } from './run-session.js';

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
