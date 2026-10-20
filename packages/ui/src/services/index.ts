export type {
  UiPlatformCapabilities,
  UiRunRecord,
  UiRunSession,
  UiServices,
  UiStartRunInput,
} from './ui-services.js';
export { clearUiServices, configureUiServices, getUiServices, peekUiServices } from './registry.js';
export { UiServicesProvider, useUiServices } from '../hooks/useUiServices.js';

// The Host boundary and the shared run projection.
//
// A surface that wants to talk to the Host imports the PORT, not a URL: the
// Web surface fills it with a same-origin BFF, the Desktop surface with
// whatever the Main-process bridge delivers. `createUiRunSession` is the one
// composition of a live stream and a durable ledger, so both surfaces project
// a run the same way.
export type {
  HostApiBridge,
  HostFetchLike,
  HostFetchResponse,
  HostHttpBridgeOptions,
} from './host-api.js';
export { createHostHttpBridge, HostApiError } from './host-api.js';
export type { UiRunSessionOptions } from './ui-run-session.js';
export { createUiRunSession } from './ui-run-session.js';
export type { CreateUiServicesOptions } from './ui-services-factory.js';
export { createUiServices } from './ui-services-factory.js';
export type {
  RejectedFrameDetail,
  RunEventStreamOptions,
  RunStreamOpener,
  RunStreamPhase,
  RunStreamState,
} from './run-session-stream.js';
export { RunEventStream } from './run-session-stream.js';
export { decodeRunFrame, readRunEventEnvelope } from './envelope.js';
export type { DecodedRunFrame, IgnoredFrameReason } from './envelope.js';
export { isRecord, RUN_EVENT_NAME, STREAM_ERROR_EVENT_NAME } from './envelope.js';
export type { SseFrame } from './sse.js';
export { SseFrameDecoder } from './sse.js';
