/**
 * wake/preemption.ts — preemption / redrive state machine (Plan 476 §2.2).
 *
 * Pure decision logic for "may this incoming wake preempt the currently
 * running turn, and what happens to the displaced run?".
 *
 * Rules (grok send-turn-dispatch / agent-to-agent-messaging parity):
 *  - a `user` wake or a `priority` DM may preempt a running turn whose
 *    origin is NOT user-driven (a bot/automation/background run);
 *  - the displaced run is NOT silently dropped: its in-flight wake is
 *    marked `isRedriven: true` and re-queued (redrive), so the work still
 *    happens once the preempting turn finishes;
 *  - preempting advances turn_epoch (§2.6), so the displaced run's tail
 *    side-effects (nudge / error reporting) are suppressed by the epoch
 *    guard rather than by killing the run mid-flight.
 *
 * 476 §6.4 note: in duya the agent subprocess replays queued `chat:start`
 * commands after a turn ends, so the runtime must decide between
 * "interrupt + re-queue a fresh run" vs "queue a preempting chat:start at
 * the head". This module returns the *decision*; the Electron main loop
 * (476 P2) maps it onto the concrete transport.
 */

import type { WakeItem } from './types.js'

/** What the currently running turn was started by. */
export type RunOrigin = 'user' | 'bot' | 'automation' | 'background'

/** What the runtime should do when a preempting wake arrives. */
export type PreemptionDecision =
  | { action: 'proceed' } // no preemption needed: just queue and run in order
  | { action: 'preempt'; redrive: boolean; reason: 'user_wake' | 'priority_dm' }

/**
 * Decide whether an incoming wake preempts the currently running turn.
 *
 * @param incoming - the wake arriving on the queue
 * @param currentOrigin - what started the in-flight run (undefined = idle)
 */
export function decidePreemption(
  incoming: WakeItem,
  currentOrigin: RunOrigin | undefined,
): PreemptionDecision {
  // Nothing running → never preempt, just dispatch in order.
  if (currentOrigin == null) return { action: 'proceed' }

  const preempting = isPreemptingWake(incoming)
  if (!preempting) return { action: 'proceed' }

  // A user turn must never be yanked by anything (not even a priority DM —
  // the user is driving; the DM waits in the agent lane).
  if (currentOrigin === 'user') return { action: 'proceed' }

  return {
    action: 'preempt',
    redrive: true, // displaced run is re-queued, never dropped (476 §2.2)
    reason: incoming.source === 'user.message' ? 'user_wake' : 'priority_dm',
  }
}

/** Whether this wake type is allowed to preempt at all. */
export function isPreemptingWake(item: WakeItem): boolean {
  if (item.lane === 'user') return true
  return (
    item.source === 'agent.dm' &&
    item.payload.kind === 'dm' &&
    item.payload.priority === true
  )
}

/**
 * Mark an item as redriven (re-queue after preemption). Returns a new item
 * with `isRedriven: true` — the runtime re-enqueues it into its lane.
 */
export function asRedriven(item: WakeItem): WakeItem {
  return { ...item, isRedriven: true }
}
