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

export { RunController, runtimeEventTypes } from './controller.js';
export type {
  FrameOutcome,
  RunControllerOptions,
  RuntimeIdentity,
} from './controller.js';

export { RunEventStream, RunSession, isTerminal } from './run-session.js';
export type { ObserveResult, RunPersistence, RunSessionOptions } from './run-session.js';

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
} from './transport/execution-channel.js';
