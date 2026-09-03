/**
 * wake/queue.ts — per-agent WakeQueue pure data structure (Plan 476 §2.2).
 *
 * Three lane FIFOs with strict user > agent > background priority. This is
 * the *pure* core: deterministic, side-effect free, unit-testable. The
 * authoritative runtime loop in Electron main (476 §6.1) owns persistence,
 * dispatch and preemption; it mutates this structure through the helpers
 * below and reads head-of-queue via `peekNext`.
 *
 * Semantics:
 *  - one agent runs one exclusive run at a time (`enqueueExclusiveRun` in
 *    the runtime). Head lane decides what runs next;
 *  - dedupe: `enqueue` collapses an item whose wakeDedupeKey already sits
 *    in a lane (newest wins, keeps original enqueue order slot);
 *  - merge: dedupe by key keeps one entry — helpers return `'added'` or
 *    `'merged'` so the caller can decide whether a dispatch is needed.
 */

import { type WakeItem, type WakeLane } from './types.js'

export type EnqueueOutcome = 'added' | 'merged'

export interface WakeQueue {
  /** All items currently queued, per lane (insertion order preserved). */
  readonly pending: Readonly<Record<WakeLane, readonly WakeItem[]>>
  /** Total queued items across lanes. */
  readonly size: number
  /** Whether the agent has no queued wake at all. */
  readonly isEmpty: boolean
}

export function createWakeQueue(): WakeQueue {
  return { pending: { user: [], agent: [], background: [] }, size: 0, isEmpty: true }
}

/**
 * Enqueue a wake item into its lane. If an item with the same dedupe key
 * already exists in *any* lane, it is merged (replaced in place) rather
 * than duplicated — newest wins.
 */
export function enqueueWake(
  queue: WakeQueue,
  item: WakeItem,
): { queue: WakeQueue; outcome: EnqueueOutcome } {
  const key = item.id
  const lanes: readonly WakeLane[] = ['user', 'agent', 'background']

  // Find an existing slot across lanes.
  for (const lane of lanes) {
    const current = queue.pending[lane] as readonly WakeItem[]
    const index = current.findIndex((candidate) => candidate.id === key)
    if (index === -1) continue
    const replaced = [...current]
    replaced[index] = item // newest wins, slot preserved
    return { queue: patch(queue, lane, replaced), outcome: 'merged' }
  }

  // No duplicate: append to its own lane.
  const target = queue.pending[item.lane] as readonly WakeItem[]
  const patched = patch(queue, item.lane, [...target, item])
  return { queue: patched, outcome: 'added' }
}

/**
 * Merge a batch of items: for each, enqueueWake. Returns a new queue with
 * every item placed and the number of fresh (non-merged) additions, which
 * the caller can use to decide whether to trigger a dispatch.
 */
export function enqueueWakeBatch(
  queue: WakeQueue,
  items: readonly WakeItem[],
): { queue: WakeQueue; addedCount: number } {
  let current = queue
  let added = 0
  for (const item of items) {
    const next = enqueueWake(current, item)
    current = next.queue
    if (next.outcome === 'added') added += 1
  }
  return { queue: current, addedCount: added }
}

/**
 * Peak the head item across lanes (strict lane priority). Returns null
 * when empty. Does not mutate.
 */
export function peekNextWake(queue: WakeQueue): WakeItem | null {
  for (const lane of orderedLanes()) {
    const items = queue.pending[lane] as readonly WakeItem[]
    if (items.length > 0) return items[0]
  }
  return null
}

/**
 * Dequeue the head item across lanes. Returns the item plus the mutated
 * queue, or null when empty.
 */
export function dequeueNextWake(
  queue: WakeQueue,
): { queue: WakeQueue; item: WakeItem } | null {
  for (const lane of orderedLanes()) {
    const items = queue.pending[lane] as readonly WakeItem[]
    if (items.length === 0) continue
    const [head, ...rest] = items
    return { queue: patch(queue, lane, rest), item: head }
  }
  return null
}

/**
 * Remove every item matching a predicate (e.g. agent deleted, workId
 * cancelled). Returns the removed items for post-processing.
 */
export function removeWakeWhere(
  queue: WakeQueue,
  predicate: (item: WakeItem) => boolean,
): { queue: WakeQueue; removed: WakeItem[] } {
  const removed: WakeItem[] = []
  let next = queue
  for (const lane of orderedLanes()) {
    const items = next.pending[lane] as readonly WakeItem[]
    const kept: WakeItem[] = []
    for (const item of items) {
      if (predicate(item)) removed.push(item)
      else kept.push(item)
    }
    next = patch(next, lane, kept)
  }
  return { queue: next, removed }
}

/** Internal: rebuild queue with one lane replaced and counters recomputed. */
function patch(
  queue: WakeQueue,
  lane: WakeLane,
  items: readonly WakeItem[],
): WakeQueue {
  const pending = {
    user: lane === 'user' ? items : queue.pending.user,
    agent: lane === 'agent' ? items : queue.pending.agent,
    background: lane === 'background' ? items : queue.pending.background,
  }
  const size = pending.user.length + pending.agent.length + pending.background.length
  return { pending, size, isEmpty: size === 0 }
}

/** Lane iteration in strict priority order (user > agent > background). */
function orderedLanes(): readonly WakeLane[] {
  return ['user', 'agent', 'background']
}
