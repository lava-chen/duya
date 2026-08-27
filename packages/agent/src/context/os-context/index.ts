/**
 * OSContextBridge public barrel.
 *
 * Plan 453 Task B.
 */

export type { OSContext, OSFocusedEntity, AcceptedSchemaVersion } from './types.js';
export {
  ACCEPTED_SCHEMA_VERSIONS,
  MAX_TRAIL_EVENTS,
} from './types.js';

export type {
  ContextPayload,
  FocusedEntity,
  IntentCandidate,
  InteractionEvent,
  RedactionReason,
} from '@duya/computer-use-demo';

export type {
  ParseFailureReason,
  ParseOutcome,
  ParseOptions,
} from './payload.js';
export { parseOSContext, capTrail } from './payload.js';

export { ContextWatcher, DEFAULT_CONTEXT_DIR } from './watcher.js';
export type { ContextWatcherOptions, WatcherEvent } from './watcher.js';

export type {
  OSContextBridge,
  OSContextListener,
  OSContextErrorListener,
} from './bridge.js';
export { getOSContextBridge, __resetOSContextBridge } from './bridge.js';