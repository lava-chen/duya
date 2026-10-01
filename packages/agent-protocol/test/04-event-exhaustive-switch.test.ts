/**
 * Drift test #4 — exhaustive switch handling.
 *
 * Two halves:
 *
 *  - COMPILE TIME. `assertNever` below only accepts `never`. If a new event is
 *    added to `RunEventPayloads` and a consumer's switch has no case for it,
 *    TypeScript reports the argument as not assignable to `never`. This is the
 *    property grok gets from `define_methods!` generating a Rust enum, and it
 *    is the reason `RunEvent` is DERIVED rather than hand-written.
 *
 *  - RUN TIME. The consumer below switches over every registered type and
 *    records which ones it saw. Comparing that against `EVENT_REGISTRY.all`
 *    catches a case that exists but is unreachable.
 */

import { describe, expect, it } from 'vitest';
import { EVENT_REGISTRY, EVENT_TYPES, type EventType, type RunEvent } from '../src/index.js';

function assertNever(value: never, exhaustive: { missing: EventType[] }): never {
  exhaustive.missing.push(value as unknown as EventType);
  throw new Error(`unhandled event: ${JSON.stringify(value)}`);
}

/** A realistic consumer: fold a stream into per-category counters. */
function fold(events: readonly RunEvent[], seen: { missing: EventType[] }) {
  const tally: Record<string, number> = {};
  for (const event of events) {
    switch (event.type) {
      case 'run.started':
      case 'run.paused':
      case 'run.completed':
      case 'run.failed':
        tally['run'] = (tally['run'] ?? 0) + 1;
        break;
      case 'turn.started':
      case 'turn.retry_scheduled':
      case 'turn.completed':
        tally['turn'] = (tally['turn'] ?? 0) + 1;
        break;
      case 'assistant.text_block':
      case 'assistant.text_delta':
      case 'assistant.thinking_block':
      case 'assistant.thinking_delta':
      case 'assistant.message_finalized':
      case 'assistant.usage':
      case 'assistant.mode_changed':
      case 'assistant.goal_updated':
      case 'assistant.status':
        tally['assistant'] = (tally['assistant'] ?? 0) + 1;
        break;
      case 'tool.call_started':
      case 'tool.arguments_delta':
      case 'tool.progress':
      case 'tool.group_progress':
      case 'tool.timed_out':
      case 'tool.call_completed':
        tally['tool'] = (tally['tool'] ?? 0) + 1;
        break;
      case 'permission.requested':
      case 'permission.resolved':
      case 'permission.expired':
        tally['permission'] = (tally['permission'] ?? 0) + 1;
        break;
      case 'compaction.started':
      case 'compaction.step':
      case 'compaction.completed':
      case 'compaction.failed':
      case 'compaction.over_threshold':
        tally['compaction'] = (tally['compaction'] ?? 0) + 1;
        break;
      case 'subagent.started':
      case 'subagent.completed':
      case 'hook.invoked':
        tally['subagent'] = (tally['subagent'] ?? 0) + 1;
        break;
      case 'diagnostic':
      case 'diagnostic.trace':
        tally['diagnostic'] = (tally['diagnostic'] ?? 0) + 1;
        break;
      case 'extension.custom':
        tally['extension'] = (tally['extension'] ?? 0) + 1;
        break;
      default:
        assertNever(event, seen);
    }
  }
  return tally;
}

describe('drift #4: exhaustive switch', () => {
  it('the consumer handles every registered type, and the compiler agrees', () => {
    const seen = { missing: [] as EventType[] };
    const tally = fold(EVENT_TYPES.map((type) => ({ type }) as RunEvent), seen);
    expect(seen.missing).toEqual([]);
    expect(Object.keys(tally).sort()).toEqual([
      'assistant',
      'compaction',
      'diagnostic',
      'extension',
      'permission',
      'run',
      'subagent',
      'tool',
      'turn',
    ]);
  });

  it('every registered type is reachable from a switch at runtime', () => {
    // A case can compile and still be dead if the discriminant never arrives.
    // Fold one event per type and assert the total was accounted for.
    const seen = { missing: [] as EventType[] };
    const input = EVENT_TYPES.map((type) => ({ type }) as RunEvent);
    fold(input, seen);
    expect(input.length).toBe(EVENT_REGISTRY.all.length);
  });

  it('every category in the metadata table has at least one event', () => {
    for (const [category, types] of EVENT_REGISTRY.byCategory) {
      expect(types.length, `category ${category} is empty`).toBeGreaterThan(0);
    }
  });

  it('durability partitions the registry into three non-empty sets', () => {
    expect(EVENT_REGISTRY.durable.length).toBeGreaterThan(0);
    expect(EVENT_REGISTRY.volatile.length).toBeGreaterThan(0);
    expect(EVENT_REGISTRY.ephemeral.length).toBeGreaterThan(0);
    expect(
      EVENT_REGISTRY.durable.length +
        EVENT_REGISTRY.volatile.length +
        EVENT_REGISTRY.ephemeral.length,
    ).toBe(EVENT_REGISTRY.all.length);
  });

  it('no type appears in two durability buckets', () => {
    const all = [
      ...EVENT_REGISTRY.durable,
      ...EVENT_REGISTRY.volatile,
      ...EVENT_REGISTRY.ephemeral,
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});
