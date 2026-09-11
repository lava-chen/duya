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
  unwrapJournalMessageId,
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

  it('drops a local non-user row the DB already has (regression: whole transcript duplicated)', () => {
    // `local` is the WHOLE store transcript, so every assistant / tool row in
    // it is an echo of a row the DB read already returned. The old contract
    // claimed "assistant dedupe lives in registerLoadedMessages" — but that
    // function dedupes *streaming events*, never store rows, so nothing
    // stopped these echoes from stacking up.
    const ts = 1_700_000_000_000;
    const persisted: Message[] = [
      assistantMsg('shared-id', 'text', ts),
    ];
    const local: Message[] = [
      assistantMsg('shared-id', 'text', ts),
    ];

    const { merged } = mergeInFlightOptimisticMessages(persisted, local);
    expect(merged.map((m) => m.id)).toEqual(['shared-id']);
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

  // Regression: the renderer mints the optimistic user message id and the
  // worker now persists the user row with that SAME id (clientMsgId). The
  // merge must drop the optimistic copy by id alone, even when the timestamps
  // drifted far apart — which is exactly the queued bot turn (plan 500) that
  // persists the row seconds/minutes after the client send.
  it('drops the optimistic copy when the persisted row shares its id, regardless of timestamp drift', () => {
    const sendTs = 1_700_000_000_000;
    const queuedTs = sendTs + 60_000; // persisted 1 minute later than the send
    const persisted: Message[] = [
      userMsg('client-uuid', '协调一下把这件事做好', queuedTs),
      assistantMsg('db-asst', '好的，我来协调…', queuedTs + 1_000),
    ];
    const local: Message[] = [
      userMsg('client-uuid', '协调一下把这件事做好', sendTs, {
        optimistic: true,
      }),
    ];

    const { merged, droppedOptimistic, keptOptimistic } =
      mergeInFlightOptimisticMessages(persisted, local);

    expect(merged.map((m) => m.id)).toEqual(['client-uuid', 'db-asst']);
    expect(droppedOptimistic).toBe(1);
    expect(keptOptimistic).toBe(0);
  });

  it('dedupes user rows by true timestamp distance, not bucket index', () => {
    // The merge compares |Δt| against the window instead of comparing
    // Math.round(ts / window) bucket indices. Bucket indices jump at every
    // window edge, so a DB row 1s from its optimistic twin used to land in a
    // different bucket (and survive as a duplicate) whenever the pair
    // straddled a multiple of 5s — which is exactly the pair below.
    expect(OPTIMISTIC_DEDUPE_WINDOW_MS).toBe(5_000);
    const base = 1_700_000_000_000;

    const straddling = userMsg('a', 'same', base + 12_000, { optimistic: true });
    const dbStraddling = userMsg('db-1', 'same', base + 13_000); // 1s apart, different bucket
    const straddlingResult = mergeInFlightOptimisticMessages([dbStraddling], [straddling]);
    expect(straddlingResult.droppedOptimistic).toBe(1);
    expect(straddlingResult.keptOptimistic).toBe(0);

    // Genuinely far apart (> window): a real re-send, must be preserved.
    const farApart = userMsg('b', 'same', base, { optimistic: true });
    const dbFarApart = userMsg('db-2', 'same', base + 20_000);
    const farResult = mergeInFlightOptimisticMessages([dbFarApart], [farApart]);
    expect(farResult.droppedOptimistic).toBe(0);
    expect(farResult.keptOptimistic).toBe(1);
  });

  // Regression (plan 441 cold-start duplicate): the journal persists the user
  // row under the deterministic event id `journal:<clientMsgId>:user_msg_added`,
  // and the worker-side timestamp is taken AFTER the agent process boots. On a
  // cold start that is more than OPTIMISTIC_DEDUPE_WINDOW_MS after the send, so
  // the timestamp leg cannot rescue the id leg — the optimistic bubble survived
  // next to the broadcast DB row, exactly when "Turn 1" appeared. Unwrapping
  // the journal id restores the timestamp-independent id contract.
  it('drops the optimistic copy when the persisted row carries the journal-wrapped clientMsgId, even far outside the window', () => {
    const sendTs = 1_700_000_000_000;
    const coldStartTs = sendTs + 9_000; // agent process boot exceeded the 5s window
    const persisted: Message[] = [
      userMsg('journal:client-uuid:user_msg_added', '现在压缩到底是什么触发逻辑', coldStartTs),
      assistantMsg('db-asst', '回复', coldStartTs + 1_000),
    ];
    const local: Message[] = [
      userMsg('client-uuid', '现在压缩到底是什么触发逻辑', sendTs, { optimistic: true }),
    ];

    const { merged, droppedOptimistic, keptOptimistic } =
      mergeInFlightOptimisticMessages(persisted, local);

    expect(merged.map((m) => m.id)).toEqual([
      'journal:client-uuid:user_msg_added',
      'db-asst',
    ]);
    expect(droppedOptimistic).toBe(1);
    expect(keptOptimistic).toBe(0);
  });

  it('does not unwrap unrelated journal ids into a match (different source message)', () => {
    // Same content, but the persisted journal id wraps a DIFFERENT message id
    // and the pair sits outside the window: a genuine re-send, must be kept.
    const sendTs = 1_700_000_000_000;
    const persisted: Message[] = [
      userMsg('journal:other-uuid:user_msg_added', '同文案重发', sendTs + 30_000),
    ];
    const local: Message[] = [
      userMsg('client-uuid', '同文案重发', sendTs, { optimistic: true }),
    ];

    const { merged, droppedOptimistic, keptOptimistic } =
      mergeInFlightOptimisticMessages(persisted, local);

    expect(merged).toHaveLength(2);
    expect(droppedOptimistic).toBe(0);
    expect(keptOptimistic).toBe(1);
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

  it('never carries a non-user local row over, flagged optimistic or not', () => {
    // Only user rows are ever created locally ahead of the DB. An assistant
    // row in `local` is by definition an echo of a persisted row, so it must
    // not be appended even if it somehow carries the optimistic flag.
    const ts = 1_700_000_000_000;
    const persisted: Message[] = [
      assistantMsg('db-asst', 'reply', ts),
    ];
    const local: Message[] = [
      { id: 'opt-asst', role: 'assistant', content: 'reply', timestamp: ts, metadata: { optimistic: true } },
    ];
    const { merged } = mergeInFlightOptimisticMessages(persisted, local);
    expect(merged.map((m) => m.id)).toEqual(['db-asst']);
  });

  it('does not duplicate the transcript when local mirrors the DB rows', () => {
    // The screenshot bug: a forced reload of a streaming session passed the
    // full store transcript as `local`, and every row was re-appended.
    const ts = 1_700_000_000_000;
    const dbRows: Message[] = [
      userMsg('u1', '我今天给自己的目标就是…', ts),
      assistantMsg('a1', '这是一个非常具体的目标…', ts + 1_000),
      { id: 't1', role: 'tool', content: '[completed] todo', timestamp: ts + 2_000 },
    ];
    const { merged } = mergeInFlightOptimisticMessages(
      dbRows,
      dbRows.map((r) => ({ ...r })),
    );
    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1', 't1']);
  });

  it('stays stable across repeated reloads instead of growing per reload', () => {
    // Each reload fed the previous (already doubled) array back in as `local`,
    // so the transcript grew 2N -> 3N -> 4N. The user saw one extra copy of
    // every message per session switch-back.
    const ts = 1_700_000_000_000;
    const dbRows: Message[] = [
      userMsg('u1', '目标', ts),
      assistantMsg('a1', '拆解', ts + 1_000),
    ];
    let store: Message[] = dbRows.map((r) => ({ ...r }));
    const counts: number[] = [];
    for (let i = 0; i < 4; i++) {
      store = mergeInFlightOptimisticMessages(dbRows, store).merged;
      counts.push(store.length);
    }
    expect(counts).toEqual([2, 2, 2, 2]);
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
// unwrapJournalMessageId — mirrors Journal.deterministicEventId
// (packages/agent/src/journal/Journal.ts). Journal boundary events persist
// rows as `journal:<sourceMsgId>:<kind>`; the optimistic-dedupe id legs
// compare both sides through this unwrapper so the renderer's clientMsgId
// matches even though the raw stored id differs.
// ---------------------------------------------------------------------------

describe('unwrapJournalMessageId', () => {
  it('passes plain message ids through unchanged', () => {
    expect(unwrapJournalMessageId('0f5d2c1e-6a7b-4c8d-9e0f-1a2b3c4d5e6f')).toBe(
      '0f5d2c1e-6a7b-4c8d-9e0f-1a2b3c4d5e6f',
    );
  });

  it('unwraps journal boundary ids back to the source message id', () => {
    expect(unwrapJournalMessageId('journal:client-uuid:user_msg_added')).toBe('client-uuid');
    expect(unwrapJournalMessageId('journal:client-uuid:assistant_message_finalized')).toBe('client-uuid');
    expect(unwrapJournalMessageId('journal:client-uuid:tool_result_added')).toBe('client-uuid');
  });

  it('keeps a source id that itself contains colons intact (greedy capture)', () => {
    expect(unwrapJournalMessageId('journal:weird:id:user_msg_added')).toBe('weird:id');
  });

  it('does not match journal-rebase fallback ids (no colon after journal)', () => {
    expect(unwrapJournalMessageId('journal-rebase:sess:turn:0:1700')).toBe(
      'journal-rebase:sess:turn:0:1700',
    );
  });

  it('coerces null/undefined to the empty string', () => {
    expect(unwrapJournalMessageId(null)).toBe('');
    expect(unwrapJournalMessageId(undefined)).toBe('');
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