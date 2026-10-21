/**
 * wake/epoch.ts — turn_epoch pure logic (Plan 476 §2.6; overview 473 §2.5.1 E3).
 *
 * turn_epoch is a per-session monotonic counter that answers one question:
 * "is this run still the latest user-visible turn?" A turn whose epoch no
 * longer matches the session's current epoch has been superseded by a newer
 * user message or priority DM, and its tail side-effects (reply nudge,
 * error reporting, delivery-owed) must stand down (grok turn-runtime.ts
 * epoch guards).
 *
 * Rules (aligned with grok SendPipeline.turnEpochs):
 *  - only `user.message` and priority `agent.dm` wakes advance the epoch;
 *  - `background` wakes (task completion, automation, inbound, broadcast)
 *    never advance it — they are quiet machinery;
 *  - compaction does NOT advance it (it is a separate summary epoch, E1);
 *  - the map is process-lifetime (resets on restart, not persisted).
 *
 * This module is pure (a plain Map wrapper) so it can be unit-tested and
 * embedded in whichever process owns the runtime (Electron main).
 */

import type { WakeItem } from './types.js'

export interface TurnEpochState {
  /** Read current epoch for an agent session (0 when never seen). */
  current(sessionId: string): number
  /**
   * Advance the epoch if this item is a user message or a priority DM.
   * Returns the *new* epoch when advanced, or null when the wake does not
   * advance (background / non-priority agent).
   */
  maybeAdvanceForItem(sessionId: string, item: WakeItem): number | null
  /**
   * Unconditionally advance the epoch (main-side explicit signal: a user
   * turn started). Returns the new epoch. Used when the run does not pass
   * through the wake queue (e.g. direct renderer chat in Electron main).
   */
  advance(sessionId: string): number
  /** True when the item's recorded epoch is still the current one. */
  isCurrent(sessionId: string, epoch: number): boolean
}

export function createTurnEpochState(): TurnEpochState {
  const epochs = new Map<string, number>()

  return {
    current(sessionId) {
      return epochs.get(sessionId) ?? 0
    },
    maybeAdvanceForItem(sessionId, item) {
      if (!advancesTurnEpoch(item)) return null
      const next = (epochs.get(sessionId) ?? 0) + 1
      epochs.set(sessionId, next)
      return next
    },
    advance(sessionId) {
      const next = (epochs.get(sessionId) ?? 0) + 1
      epochs.set(sessionId, next)
      return next
    },
    isCurrent(sessionId, epoch) {
      return epoch === (epochs.get(sessionId) ?? 0)
    },
  }
}

/**
 * Whether dispatching this wake should advance the session's turn epoch.
 * User turns and priority DMs preempt the current run, so they begin a new
 * epoch; everything on the background lane (and non-priority agent work)
 * does not.
 */
export function advancesTurnEpoch(item: WakeItem): boolean {
  if (item.lane === 'user') return true
  if (item.lane === 'agent') {
    return item.source === 'agent.dm' && item.payload.kind === 'dm' && item.payload.priority === true
  }
  return false
}
