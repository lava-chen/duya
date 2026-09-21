/**
 * recorder/ — RPA event-level recording (plan 556).
 *
 * Public surface for the recorder pipeline. The hook-worker entry
 * (hook-worker-entry.ts) is intentionally NOT exported here: it is a
 * standalone child-process bundle whose only runtime import is
 * uiohook-napi, and it is consumed by path (dist/recorder/
 * hook-worker-entry.js), not through the package index.
 */

export {
  AppRefSchema,
  ClickPayloadSchema,
  ElementDescriptorSchema,
  RecorderEventSchema,
  RECORDER_EVENT_TYPES,
  safeParseRecorderEvent,
} from './events.js';
export type {
  AppRef,
  ClickPayload,
  ElementDescriptor,
  RecorderEvent,
  RecorderEventType,
} from './events.js';

export { redactRecorderEvent, shouldDropEventForApp, DEFAULT_BLOCKED_PROCESS_NAMES, REDACTED_TEXT } from './privacy.js';

export {
  SessionStore,
  listSessions,
  loadSession,
  deleteSession,
  getDefaultRecorderRootDir,
} from './session-store.js';
export type { SessionSummary, LoadedSession } from './session-store.js';

export {
  KEYCODE_TO_CHAR,
  KEYCODE_TO_NAME,
  MODIFIER_KEYCODES,
  resolveChar,
  resolveTextForKeycode,
} from './keymap.js';
export type { CharMapping } from './keymap.js';

export {
  parseWorkerLine,
  isComboKeyDown,
  WorkerEventSchema,
  KeyDownEventSchema,
  KeyUpEventSchema,
  MouseDownEventSchema,
  MouseUpEventSchema,
  WheelEventSchema,
  HeartbeatEventSchema,
} from './worker-protocol.js';
export type {
  WorkerEvent,
  KeyDownEvent,
  KeyUpEvent,
  MouseDownEvent,
  MouseUpEvent,
  WheelEvent,
  HeartbeatEvent,
} from './worker-protocol.js';

export {
  RecorderAggregator,
  NO_ELEMENT,
  TYPE_SILENCE_FLUSH_MS,
  WHEEL_DEBOUNCE_MS,
} from './aggregators.js';
export type { AggregatorOptions, FeedContext } from './aggregators.js';
