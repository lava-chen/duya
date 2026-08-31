// Tests for the pure helper that merges DB-loaded messages with local
// optimistic entries in loadThreadMessages' streaming-session branch.
//
// Regression target: user message rendered twice when a forced DB reload
// ran while the agent was still streaming. Cause was a pure id-diff
// dedupe that let an optimistic UUID slip past the DB-assigned UUID.

import { describe, expect, it } from 'vitest';
import type { Message } from '@/types/message';
import {
  mergeInFlightOptimisticMessages,
  OPTIMISTIC_DEDUPE_WINDOW_MS,
} from '../conversation-store';

const userMsg = (
  id: string,
  content: string,
  timestamp: number,
  opts: { optimistic?: boolean } = {},
): Message => ({
  id,
  role: 'user',
  content,
  timestamp,
  metadata: opts.optimistic ? { optimistic: true } : undefined,
});

const assistantMsg = (id: string, content: string, timestamp: number): Message => ({
  id,
  role: 'assistant',
  content,
  timestamp,
});

describe('mergeInFlightOptimisticMessages', () => {
  it('drops the optimistic copy when the same user message is already in DB (regression: rendered twice)', () => {
    // Reproduces the screenshot bug: optimistic UUID-A (client-generated)
    // and DB UUID-B (server-assigned) for the SAME content+timestamp.
    const dbTs = 1_700_000_000_000;
    const persisted: Message[] = [
      userMsg('db-uuid-real', '结合我的记忆综合思考', dbTs),
      assistantMsg('db-asst', '好的,我来综合分析…', dbTs + 1_000),
    ];
    const local: Message[] = [
      userMsg('optimistic-uuid-tmp', '结合我的记忆综合思考', dbTs, {
        optimistic: true,
      }),
    ];

    const { merged, droppedOptimistic, keptOptimistic } =
      mergeInFlightOptimisticMessages(persisted, local);

    expect(merged).toHaveLength(2);
    // The DB row wins; the optimistic copy is dropped.
    expect(merged.map((m) => m.id)).toEqual(['db-uuid-real', 'db-asst']);
    expect(droppedOptimistic).toBe(1);
    expect(keptOptimistic).toBe(0);
  });

  it('keeps the optimistic copy when DB does not yet contain that user message', () => {
    // Normal streaming case: user just clicked Send, Agent worker has not
    // finished the round yet, DB has no row for this user turn.
    const dbTs = 1_700_000_000_000;
    const persisted: Message[] = [
      assistantMsg('db-prev-asst', '上一次回答', dbTs - 60_000),
    ];
    const local: Message[] = [
      userMsg('optimistic-uuid-tmp', '新一轮问题', dbTs, { optimistic: true }),
    ];

    const { merged, droppedOptimistic, keptOptimistic } =
      mergeInFlightOptimisticMessages(persisted, local);

    expect(merged).toHaveLength(2);
    expect(merged.map((m) => m.id)).toEqual(['db-prev-asst', 'optimistic-uuid-tmp']);
    expect(droppedOptimistic).toBe(0);
    expect(keptOptimistic).toBe(1);
  });

  it('keeps a non-optimistic local message even if its id matches a DB row (e.g. SSE re-emit)', () => {
    // SSE re-emits a known id; it has no optimistic flag and is not a
    // user message, so the helper must not touch it. This guards the
    // "only user-role optimistic entries are eligible for dedupe" rule.
    const ts = 1_700_000_000_000;
    const persisted: Message[] = [
      assistantMsg('shared-id', 'text', ts),
    ];
    const local: Message[] = [
      assistantMsg('shared-id', 'text', ts),
    ];

    const { merged } = mergeInFlightOptimisticMessages(persisted, local);
    // Assistant block dedupe lives elsewhere (registerLoadedMessages);
    // this helper leaves it alone.
    expect(merged.map((m) => m.id)).toEqual(['shared-id', 'shared-id']);
  });

  it('does not confuse two distinct optimistic user messages sent close together', () => {
    // A legitimate fast double-send: 2s apart, different content. They
    // must both survive even though they fall in the same window.
    const ts1 = 1_700_000_000_000;
    const ts2 = ts1 + 2_000; // well within the 5s window
    const persisted: Message[] = [];
    const local: Message[] = [
      userMsg('opt-a', '第一条', ts1, { optimistic: true }),
      userMsg('opt-b', '第二条', ts2, { optimistic: true }),
    ];

    const { merged, droppedOptimistic, keptOptimistic } =
      mergeInFlightOptimisticMessages(persisted, local);

    expect(merged.map((m) => m.id)).toEqual(['opt-a', 'opt-b']);
    expect(droppedOptimistic).toBe(0);
    expect(keptOptimistic).toBe(2);
  });

  it('treats timestamps inside the same window as equivalent and outside as distinct', () => {
    // Boundary check: messages 1s apart with the same content land in
    // the same bucket (1s < 5s window). 12s apart they are in different
    // buckets and must NOT be deduped. (8s/9s would still round to the
    // same bucket index because Math.round rounds .5 up, so we use
    // 12s/13s to clearly cross the boundary.)
    expect(OPTIMISTIC_DEDUPE_WINDOW_MS).toBe(5_000);
    const base = 1_700_000_000_000;
    const inside = userMsg('a', 'same', base, { optimistic: true });
    const outside = userMsg('b', 'same', base + 12_000, { optimistic: true });
    const dbInWindow = userMsg('db-1', 'same', base + 1_000);
    const dbOutOfWindow = userMsg('db-2', 'same', base + 13_000);

    const insideResult = mergeInFlightOptimisticMessages([dbInWindow], [inside]);
    expect(insideResult.droppedOptimistic).toBe(1);
    expect(insideResult.keptOptimistic).toBe(0);

    const outsideResult = mergeInFlightOptimisticMessages([dbOutOfWindow], [outside]);
    expect(outsideResult.droppedOptimistic).toBe(0);
    expect(outsideResult.keptOptimistic).toBe(1);
  });

  it('returns the persisted list untouched when local is empty', () => {
    const ts = 1_700_000_000_000;
    const persisted: Message[] = [
      userMsg('db-1', 'old', ts),
      assistantMsg('db-2', 'old reply', ts + 1_000),
    ];
    const { merged, droppedOptimistic, keptOptimistic } =
      mergeInFlightOptimisticMessages(persisted, []);
    expect(merged).toHaveLength(2);
    expect(merged).toBe(merged); // identity preserved for the array head
    expect(droppedOptimistic).toBe(0);
    expect(keptOptimistic).toBe(0);
  });

  it('does not treat non-user optimistic messages as eligible for dedupe', () => {
    // Future-proofing: even if a non-user message somehow carries the
    // optimistic flag (it should not, but defensively), it must NOT be
    // deduped — only user messages go through the content-window logic.
    const ts = 1_700_000_000_000;
    const persisted: Message[] = [
      assistantMsg('db-asst', 'reply', ts),
    ];
    const local: Message[] = [
      { id: 'opt-asst', role: 'assistant', content: 'reply', timestamp: ts, metadata: { optimistic: true } },
    ];
    const { merged } = mergeInFlightOptimisticMessages(persisted, local);
    expect(merged).toHaveLength(2);
  });
});