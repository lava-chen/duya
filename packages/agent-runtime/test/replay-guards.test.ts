/**
 * T3.3 — the runtime half of the replay guards.
 *
 * `replay-guards.ts` holds the compile-time half (in `src/`, because the
 * packages' tsconfig excludes `test/` and esbuild strips types). These are the
 * halves TypeScript cannot check: that the registry's durability table still
 * matches the set the guards name, and that each replay outcome kind maps to a
 * status a consumer can act on.
 */

import { describe, expect, it } from 'vitest';
import { EVENT_REGISTRY } from '@duya/agent-protocol';
import type { EventType } from '@duya/agent-protocol';
import { handleReplayOutcome } from '../src/replay/replay-guards.js';
import type { ReplayOutcome } from '../src/replay/replay-repository.js';

const window = {
  oldest: 10,
  latest: 20,
  mintedLatest: 25,
  count: 6,
  sparse: true,
} as const;
const cursor = { runId: 'run-1', epoch: 1, afterSeq: 12 } as const;

describe('the durable text family is exactly what the rebuild reads', () => {
  it('every guarded type is durable in the registry', () => {
    // If one of these stopped being durable, the rebuild would be reading from a
    // store that never wrote it, and the recovery claim would be false.
    for (const type of [
      'assistant.text_block',
      'assistant.thinking_block',
      'assistant.message_finalized',
    ] as const) {
      expect(EVENT_REGISTRY.specOf(type)?.durability).toBe('durable');
    }
  });

  it('no other assistant text event is durable, so none is silently unread', () => {
    // The set is closed in both directions: a fourth durable text event would
    // reach the store but never the rebuild.
    const durableAssistantText = [...EVENT_REGISTRY.durable].filter((type) =>
      type.startsWith('assistant.'),
    );
    expect(new Set(durableAssistantText)).toEqual(
      new Set([
        'assistant.text_block',
        'assistant.thinking_block',
        'assistant.message_finalized',
        'assistant.usage',
        'assistant.goal_updated',
      ] satisfies EventType[]),
    );
  });

  it('the deltas the rebuild cannot replay really are non-durable', () => {
    for (const type of ['assistant.text_delta', 'assistant.thinking_delta'] as const) {
      expect(EVENT_REGISTRY.specOf(type)?.durability).toBe('ephemeral');
    }
  });
});

describe('each replay outcome maps to a status a consumer can act on', () => {
  const outcomes: readonly ReplayOutcome[] = [
    {
      kind: 'replay',
      cursor,
      window,
      events: [],
      throughSeq: 12,
    },
    {
      kind: 'snapshot_resync',
      cursor,
      window,
      snapshot: {
        runId: 'run-1',
        source: 'durable_transcript',
        throughSeq: 20,
        messages: [],
        finalized: [],
        blocks: [],
        report: {
          messages: 0,
          recoveredBlocks: 0,
          openBlocks: [],
          deltasNotReplayed: 0,
        },
      },
      snapshotSource: 'durable_transcript',
      supersededFromSeq: 10,
    },
    {
      kind: 'refused',
      cursor,
      window,
      refusal: 'replay_unavailable',
      detail: 'too old',
    },
  ];

  it('tells a resync apart from a success, so a consumer replaces its state', () => {
    // The distinction that matters: `ok` for a resync would let a consumer keep
    // a transcript it never received.
    expect(handleReplayOutcome(outcomes[0]!)).toBe('ok');
    expect(handleReplayOutcome(outcomes[1]!)).toBe('resync_required');
    expect(handleReplayOutcome(outcomes[2]!)).toBe('error');
  });

  it('covers every kind the union declares', () => {
    // The census discipline T3.2 applied to the control plane: a kind in the
    // union with no assertion here is a kind nobody has thought about.
    expect(outcomes.map((o) => o.kind).sort()).toEqual(['refused', 'replay', 'snapshot_resync']);
    for (const outcome of outcomes) {
      expect(['ok', 'resync_required', 'error']).toContain(handleReplayOutcome(outcome));
    }
  });
});
