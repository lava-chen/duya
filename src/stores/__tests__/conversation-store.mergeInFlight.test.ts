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
  isDuplicateOptimisticUser,
  optimisticBucketKey,
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

// ---------------------------------------------------------------------------
// isDuplicateOptimisticUser — write-time guard used by `addMessage`.
//
// Regression target: 7 copies of the same user message in the chat
// transcript. `addMessage` is unconditional append, so rapid sends /
// retry re-fires / hook re-fires stacked N optimistic rows in local state.
// The merge branch in `loadThreadMessages` only runs on force:true
// reloads, which never fire for a normal renderer-initiated stream —
// so duplicates accumulated until the run ended (visible to the user
// the whole time). These tests pin the rule `addMessage` now enforces.
// ---------------------------------------------------------------------------

describe('isDuplicateOptimisticUser', () => {
  it('flags two optimistic user messages in the same content window as duplicates', () => {
    const ts = 1_700_000_000_000;
    const existing: Message[] = [
      userMsg('opt-1', '我希可以有待续的文件输出', ts, { optimistic: true }),
    ];
    const candidate = userMsg('opt-2', '我希可以有待续的文件输出', ts + 1_000, {
      optimistic: true,
    });
    expect(isDuplicateOptimisticUser(existing, candidate)).toBe(true);
  });

  it('keeps distinct content even within the same window', () => {
    const ts = 1_700_000_000_000;
    const existing: Message[] = [
      userMsg('opt-1', '第一条', ts, { optimistic: true }),
    ];
    const candidate = userMsg('opt-2', '第二条', ts + 1_000, {
      optimistic: true,
    });
    expect(isDuplicateOptimisticUser(existing, candidate)).toBe(false);
  });

  it('keeps identical content sent outside the dedupe window', () => {
    // The window is 5s — 12s apart lands in a different bucket.
    const base = 1_700_000_000_000;
    const existing: Message[] = [
      userMsg('opt-1', 'same content', base, { optimistic: true }),
    ];
    const candidate = userMsg('opt-2', 'same content', base + 12_000, {
      optimistic: true,
    });
    expect(isDuplicateOptimisticUser(existing, candidate)).toBe(false);
  });

  it('does not treat an non- optimistic candidate as a duplicate even if it matches', () => {
    // A persisted user message re-entering local state (e.g. SSE re-emit
    // of an existing DB row) is not eligible — the optimistic flag is
    // what marks an entry as "this might collide with a future DB row".
    const ts = 1_700_000_000_000;
    const existing: Message[] = [
      userMsg('opt-1', 'text', ts, { optimistic: true }),
    ];
    const candidate: Message = {
      id: 're-emit',
      role: 'user',
      content: 'text',
      timestamp: ts,
      // no optimistic flag — must always be accepted
    };
    expect(isDuplicateOptimisticUser(existing, candidate)).toBe(false);
  });

  it('does not treat assistant candidates as duplicates', () => {
    // Assistant messages are deduped by stream-session-manager, not here.
    const ts = 1_700_000_000_000;
    const existing: Message[] = [
      assistantMsg('opt-asst', 'reply', ts),
    ];
    const candidate: Message = {
      id: 'opt-asst-2',
      role: 'assistant',
      content: 'reply',
      timestamp: ts,
      metadata: { optimistic: true },
    };
    expect(isDuplicateOptimisticUser(existing, candidate)).toBe(false);
  });

  it('does not let non-optimistic existing entries block an optimistic write', () => {
    // A persisted user message already in local state must not block a
    // fresh optimistic send. Otherwise the first real send would lock
    // out every subsequent attempt with identical content.
    const ts = 1_700_000_000_000;
    const existing: Message[] = [
      userMsg('db-row', 'text', ts), // no optimistic flag
    ];
    const candidate = userMsg('opt-1', 'text', ts + 500, {
      optimistic: true,
    });
    expect(isDuplicateOptimisticUser(existing, candidate)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// optimisticBucketKey — exported separately so both the write-time guard
// (isDuplicateOptimisticUser) and the post-DB-load merge share one
// definition. A drift between the two would let one layer drop a row
// the other layer keeps.
// ---------------------------------------------------------------------------

describe('optimisticBucketKey', () => {
  it('collapses sub-second timestamp skew into the same bucket', () => {
    const a = userMsg('a', 'same', 1_700_000_000_000, { optimistic: true });
    const b = userMsg('b', 'same', 1_700_000_000_500, { optimistic: true });
    expect(optimisticBucketKey(a)).toBe(optimisticBucketKey(b));
  });

  it('separates timestamps outside the window', () => {
    const base = 1_700_000_000_000;
    expect(optimisticBucketKey(userMsg('a', 'same', base))).not.toBe(
      optimisticBucketKey(userMsg('b', 'same', base + OPTIMISTIC_DEDUPE_WINDOW_MS + 1)),
    );
  });

  it('uses the literal content for strings and a fixed marker for block content', () => {
    // The bucket key intentionally distinguishes string-content user
    // messages from block-content user messages. Two block-shaped
    // copies of the same text collapse to "blocks" so any pair of
    // block-form local rows dedupe against each other; a string-form
    // copy of identical text gets its own key because that is what
    // a plain user-typed send actually looks like in local state.
    const ts = 1_700_000_000_000;
    const stringForm = userMsg('a', 'text', ts);
    const blockForm: Message = {
      id: 'b',
      role: 'user',
      content: [{ type: 'text', text: 'text' }],
      timestamp: ts,
    };
    const otherBlock: Message = {
      id: 'c',
      role: 'user',
      content: [{ type: 'text', text: 'totally different payload' }],
      timestamp: ts,
    };

    expect(optimisticBucketKey(stringForm)).toBe('user|text|340000000');
    expect(optimisticBucketKey(blockForm)).toBe('user|blocks|340000000');
    // All block-content user messages share the same bucket — we never
    // look inside the blocks to dedupe, only outside the content shape.
    expect(optimisticBucketKey(blockForm)).toBe(optimisticBucketKey(otherBlock));
  });
});