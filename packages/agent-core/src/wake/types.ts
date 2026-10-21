/**
 * Compatibility exports for wake contracts now owned by agent-protocol.
 * Keep existing Agent-internal imports working while callers migrate.
 */
export {
  isPreemptingItem,
  LANE_RANK,
  SOURCE_DEFAULT_LANE,
  sourceCanPreempt,
  wakeDedupeKey,
} from '@duya/agent-protocol'
export type {
  QuietWakeOrigin,
  WakeItem,
  WakeLane,
  WakePayload,
  WakeSourceKind,
} from '@duya/agent-protocol'
