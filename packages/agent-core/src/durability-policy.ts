/**
 * Durability policy — what a run keeps, what it counts, what it drops.
 *
 * ## The three buckets are not interchangeable
 *
 * `registry.ts:50-53` classifies every event as `durable`, `volatile` or
 * `ephemeral`. This module turns that classification into the three decisions a
 * run actually has to make about each event:
 *
 *  - **retain** — write it to the durable log; a transcript can be rebuilt from it.
 *  - **count** — it happened and it matters to metrics, but storing it would be wrong.
 *  - **drop** — it never reaches a consumer that stores anything.
 *
 * ## Why the classification is read, never restated
 *
 * A hand-written `Set` of "durable types" would be correct on the day it was
 * written and wrong the first time somebody adds an event to `EVENT_META`. The
 * registry is the single source of truth for classification, so it is the single
 * source of truth here. `test/durability-policy.test.ts` asserts the mapping is
 * total: every registered type resolves to exactly one disposition, and a new
 * event type cannot be added without a decision.
 *
 * ## Why ephemeral events are counted and not retained
 *
 * A text-delta storm is thousands of events carrying bytes that are already
 * implied by the `assistant.text_block` that follows them. Retaining them would
 * let a single verbose answer dominate the run's storage, and the block event
 * is enough to reconstruct the text. So the storm is *counted* — `RunMetrics`
 * needs to know it happened — and dropped. Counting is the only operation that
 * is O(1) in the right direction.
 */

import type { Durability, EventType, RunEvent } from '@duya/agent-protocol';
import { EVENT_REGISTRY } from '@duya/agent-protocol';

/** What a run does with one event. */
export type Disposition =
  /** Write to the durable run log. */
  | 'retain'
  /** Count in metrics; store nothing. */
  | 'count'
  /** Not counted, not stored, not forwarded. */
  | 'drop';

const DISPOSITION_BY_DURABILITY: Readonly<Record<Durability, Disposition>> = {
  durable: 'retain',
  volatile: 'count',
  ephemeral: 'drop',
};

/**
 * The disposition for one event type.
 *
 * Returns `'drop'` for an unregistered type rather than throwing. An unknown
 * event is by definition not part of this protocol version, and the registry's
 * own contract is that an unrecognised event is never durable
 * (`envelope.ts:98-107`) — so dropping is the only consistent answer, and
 * throwing would turn a forward-compatible frame into a crashed run.
 */
export function dispositionOf(type: string): Disposition {
  const meta = EVENT_REGISTRY.specOf(type);
  if (meta === undefined) return 'drop';
  // The `?? 'drop'` is unreachable while `EVENT_META` is total, and
  // unreachable-but-unprovable is exactly where a silent hole grows. Falling
  // back to the safest disposition keeps an incomplete registry from turning
  // into an unretainable event.
  return DISPOSITION_BY_DURABILITY[meta.durability] ?? 'drop';
}

/** True when the event belongs in the durable log. */
export function isRetainable(type: string): boolean {
  return dispositionOf(type) === 'retain';
}

/**
 * The counters a run keeps while it executes.
 *
 * `eventsEphemeral` is deliberately a counter and not a buffer: the registry's
 * own comment on `RunMetrics` (`run.ts:81-85`) says an ephemeral storm would
 * otherwise consume the whole buffer, and the honest fix is to count rather
 * than to bound.
 */
export interface RunEventCounters {
  total: number;
  durable: number;
  volatile: number;
  ephemeral: number;
  toolCalls: number;
  permissionRequests: number;
  permissionDecisions: number;
  turns: number;
}

export function emptyCounters(): RunEventCounters {
  return {
    total: 0,
    durable: 0,
    volatile: 0,
    ephemeral: 0,
    toolCalls: 0,
    permissionRequests: 0,
    permissionDecisions: 0,
    turns: 0,
  };
}

/**
 * Fold one event into the counters.
 *
 * Total is incremented for every event including unknown ones: an unrecognised
 * frame still consumed stream position and sequence number, and a `total` that
 * silently skips them would not reconcile against `seq`.
 */
export function countEvent(
  counters: RunEventCounters,
  event: Pick<RunEvent, 'type'>,
): RunEventCounters {
  const next: RunEventCounters = {
    ...counters,
    total: counters.total + 1,
  };

  switch (dispositionOf(event.type)) {
    case 'retain':
      next.durable = counters.durable + 1;
      break;
    case 'count':
      next.volatile = counters.volatile + 1;
      break;
    case 'drop':
      next.ephemeral = counters.ephemeral + 1;
      break;
  }

  if (event.type === 'tool.call_started') next.toolCalls = counters.toolCalls + 1;
  if (event.type === 'turn.started') next.turns = counters.turns + 1;
  if (event.type === 'permission.requested') {
    next.permissionRequests = counters.permissionRequests + 1;
  }
  if (event.type === 'permission.resolved') {
    next.permissionDecisions = counters.permissionDecisions + 1;
  }

  return next;
}

/**
 * The durable subset of a run's events, in order.
 *
 * This is what a `run_events` table is written from. Volatile events are
 * excluded even though they are counted, and ephemeral ones twice over — a
 * reader that wants a transcript gets the events that can actually build one.
 */
export function durableOnly<T extends Pick<RunEvent, 'type'>>(
  events: readonly T[],
): readonly T[] {
  return events.filter((event) => isRetainable(event.type));
}

/**
 * Every registered type and its disposition, for diagnostics and for the
 * totality test.
 */
export function dispositionTable(): Readonly<Record<EventType, Disposition>> {
  const table: Partial<Record<EventType, Disposition>> = {};
  for (const type of EVENT_REGISTRY.all) {
    table[type] = dispositionOf(type);
  }
  return table as Record<EventType, Disposition>;
}
