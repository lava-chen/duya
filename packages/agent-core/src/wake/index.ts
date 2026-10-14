/**
 * wake/index.ts — Agent Wake Bus pure core barrel (Plan 476).
 *
 * Exports only pure types and pure functions. The authoritative dispatch
 * loop lives in Electron main (476 §6.1); this package is importable from
 * both the worker and main without runtime side effects.
 */

export {
  LANE_RANK,
  SOURCE_DEFAULT_LANE,
  isPreemptingItem,
  sourceCanPreempt,
  wakeDedupeKey,
} from './types.js'
export type {
  QuietWakeOrigin,
  WakeItem,
  WakeLane,
  WakePayload,
  WakeSourceKind,
} from './types.js'

export {
  createWakeQueue,
  dequeueNextWake,
  enqueueWake,
  enqueueWakeBatch,
  peekNextWake,
  removeWakeWhere,
} from './queue.js'
export type { EnqueueOutcome, WakeQueue } from './queue.js'

export {
  advancesTurnEpoch,
  createTurnEpochState,
} from './epoch.js'
export type { TurnEpochState } from './epoch.js'

export {
  asRedriven,
  decidePreemption,
  isPreemptingWake,
} from './preemption.js'
export type { PreemptionDecision, RunOrigin } from './preemption.js'
