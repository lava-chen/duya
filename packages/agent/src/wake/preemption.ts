/**
 * wake/preemption.ts — preemption / redrive state machine (Plan 476 §2.2).
 *
 * Pure decision logic for "may this incoming wake preempt the currently
 * running turn, and what happens to the displaced run?".
 *
 * Rules (grok send-turn-dispatch / agent-to-agent-messaging parity):
 *  - a `user` wake preempts ANY running turn — including a user turn
 *    (Plan 500 P3, grok "superseded by a new user message": the user is
 *    driving, nothing they type queues behind the bot);
 *  - a `priority` DM preempts a running turn whose origin is NOT
 *    user-driven (a bot/automation/background run);
 *  - the displaced run is NOT silently dropped unless it was a user run:
 *    agent/background runs are marked `isRedriven: true` and re-queued
 *    (redrive) so the work still happens once the preempting turn finishes;
 *    a displaced USER run is deliberately not redriven — the user replaced
 *    it on purpose and its partial transcript is already persisted;
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

  // Plan 500 P3 (grok parity): a new user message supersedes even a running
  // user turn. Priority DMs still wait behind a user turn — the user is
  // driving, the DM belongs to the agent lane.
  if (currentOrigin === 'user' && incoming.lane !== 'user') {
    return { action: 'proceed' }
  }

  // A displaced user run is not redriven — the user superseded it on
  // purpose and its partial transcript is already persisted. Agent and
  // background runs redrive so the displaced work still happens (476 §2.2).
  return {
    action: 'preempt',
    redrive: currentOrigin !== 'user',
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
