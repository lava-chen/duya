/**
 * Tests for the pure `emitRebaseNewMessages` projection helper (plan 548).
 *
 * Companion to `applyRebases` (see `apply-rebases.test.ts`). Unlike
 * `applyRebases`, which folds superseded raw messages out of the
 * projection, `emitRebaseNewMessages` keeps every raw message so the
 * chat UI can render the full pre-compaction history alongside a
 * CompactSummary card at each rebase point.
 *
 * The helper must:
 *   - emit every raw message row verbatim (no supersede check),
 *   - skip rebase event rows (they are internal audit markers),
 *   - emit each rebase's `newMessages` so the compaction summary reaches
 *     the renderer,
 *   - dedup by id with first-emission-wins so rebase-emitted tails that
 *     share an id with an already-seen raw row do not double-render,
 *   - leave rollout process events and legacy compaction entries untouched.
 */

import { describe, expect, it } from 'vitest';
import { emitRebaseNewMessages, type TimelineEntryRow } from '../message-log';
import type { MessageEntry, CompactionEntry } from '@duya/agent/message';
import type { RebaseEvent, ReasoningEvent } from '../rollout-events';

// ─── Builders (mirrored from apply-rebases.test.ts) ─────────────────────

function userMsg(id: string, text: string, createdAt: number): MessageEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    createdAt,
    message: { role: 'user', id, content: text, timestamp: createdAt, visibility: 'visible' },
  };
}

function assistantMsg(id: string, text: string, createdAt: number): MessageEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    createdAt,
    message: { role: 'assistant', id, content: [{ type: 'text', text }], timestamp: createdAt, visibility: 'visible' },
  };
}

function summaryMessage(id: string, text: string, createdAt: number): MessageEntry {
  // The compaction summary the journal writes into a rebase event's
  // newMessages[0] (see Journal.toMessageEntries + SessionMemoryCompactStrategy).
  return {
    type: 'message',
    id,
    parentId: null,
    createdAt,
    message: {
      role: 'system',
      id,
      content: text,
      timestamp: createdAt,
      visibility: 'visible',
      isCompactSummary: true,
      compactedMessageCount: 3,
    },
  };
}

function compaction(id: string, summary: string, createdAt: number): CompactionEntry {
  return {
    type: 'compaction',
    id,
    parentId: null,
    createdAt,
    summary,
    firstKeptMessageId: 'kept',
    compactedMessageIds: [],
    tokensBefore: 0,
    tokensAfter: 0,
    strategy: 'summary',
  };
}

function reasoning(id: string, text: string, createdAt: number): ReasoningEvent {
  return { type: 'reasoning', id, turnId: 't-1', model: 'claude-opus-4', text, createdAt };
}

function rebase(
  id: string,
  supersededUpToSeq: number | null,
  newMessages: MessageEntry[],
  createdAt: number,
): RebaseEvent {
  return { type: 'rebase', id, turnId: 't-1', supersededUpToSeq, newMessages, createdAt };
}

function row<T extends TimelineEntryRow['entry']>(entry: T, seq: number): TimelineEntryRow {
  return { entry, seq };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('emitRebaseNewMessages', () => {
  it('returns the input (with rebase rows stripped) when there are no rebases', () => {
    const rows: TimelineEntryRow[] = [
      row(userMsg('u-1', 'hello', 1), 1),
      row(assistantMsg('a-1', 'hi', 2), 2),
    ];
    const out = emitRebaseNewMessages(rows);
    expect(out.map((r) => r.entry.id)).toEqual(['u-1', 'a-1']);
  });

  it('keeps superseded raw messages (the chat UI history view)', () => {
    const rows: TimelineEntryRow[] = [
      row(userMsg('u-1', 'first prompt', 1), 1),
      row(assistantMsg('a-1', 'first reply', 2), 2),
      row(assistantMsg('a-2', 'second reply', 3), 3),
      // Compaction rebase supersedes ALL prior (null bound), then inserts
      // [summary, kept-tail-user].
      row(
        rebase('rb-1', null, [
          summaryMessage('summary-1', 'compacted recap', 4),
          userMsg('u-2', 'continued after compact', 5),
        ], 4),
        4,
      ),
    ];

    const out = emitRebaseNewMessages(rows);

    // Every raw message must be present so the chat UI can render the
    // full pre-compaction history. The compaction summary must also be
    // present so it renders as a CompactSummary card. The rebase event
    // row itself is dropped (not user-visible).
    expect(out.map((r) => r.entry.id)).toEqual(['u-1', 'a-1', 'a-2', 'summary-1', 'u-2']);
    expect(out.every((r) => r.entry.type !== 'rebase')).toBe(true);
  });

  it('drops the rebase event row itself', () => {
    const rows: TimelineEntryRow[] = [
      row(userMsg('u-1', 'hi', 1), 1),
      row(rebase('rb-1', 1, [userMsg('u-2', 'next', 2)], 2), 2),
    ];
    const out = emitRebaseNewMessages(rows);
    expect(out.map((r) => r.entry.id)).toEqual(['u-1', 'u-2']);
  });

  it('keeps a tail message that the rebase carries forward (no dedup collision)', () => {
    // The kept tail is a brand-new id (the strategy assigns fresh ids
    // for re-emission), so it must reach the renderer alongside the
    // superseded originals.
    const kept = userMsg('u-tail', 'tail', 5);
    const rows: TimelineEntryRow[] = [
      row(userMsg('u-1', 'first', 1), 1),
      row(assistantMsg('a-1', 'reply', 2), 2),
      row(rebase('rb-1', 2, [kept], 3), 3),
    ];
    const out = emitRebaseNewMessages(rows);
    expect(out.map((r) => r.entry.id)).toEqual(['u-1', 'a-1', 'u-tail']);
  });

  it('drops a rebase-emitted tail whose id collides with an earlier raw row (first-emission wins)', () => {
    // Edge case: if the rebase re-emits a message with an id that
    // matches an already-emitted raw row, the raw row wins because it
    // arrived earlier in seq order. The compaction summary itself uses
    // a deterministic id (`journal-rebase:<session>:<turn>:0:<ts>`,
    // see Journal.toMessageEntries) that never collides, so the summary
    // always survives this dedup.
    const colliding = userMsg('u-1', 'tail-form', 5);
    const rows: TimelineEntryRow[] = [
      row(userMsg('u-1', 'original form', 1), 1),
      row(
        rebase('rb-1', null, [
          summaryMessage('summary-1', 'compacted recap', 4),
          colliding,
        ], 4),
        4,
      ),
    ];
    const out = emitRebaseNewMessages(rows);
    // summary-1 survives because its id is unique; u-1 is the original
    // row, and the colliding tail is dropped by first-emission-wins.
    expect(out.map((r) => r.entry.id)).toEqual(['u-1', 'summary-1']);
  });

  it('passes through rollout process events (reasoning, tool_call, ...)', () => {
    const rows: TimelineEntryRow[] = [
      row(reasoning('r-1', 'thinking...', 1), 1),
      row(userMsg('u-1', 'hi', 2), 2),
      row(
        rebase('rb-1', null, [summaryMessage('summary-1', 'recap', 4)], 4),
        3,
      ),
    ];
    const out = emitRebaseNewMessages(rows);
    expect(out.map((r) => r.entry.id)).toEqual(['r-1', 'u-1', 'summary-1']);
  });

  it('passes through legacy compaction entries untouched', () => {
    // Pre-plan-441 data still in the DB carries `type: 'compaction'`
    // entries. The renderer already renders these via the
    // `projectTimelinePersistenceMessages` path; we just ensure the
    // new helper does not drop them.
    const rows: TimelineEntryRow[] = [
      row(userMsg('u-1', 'hi', 1), 1),
      row(compaction('cmp-1', 'old summary', 2), 2),
      row(userMsg('u-2', 'after legacy compact', 3), 3),
    ];
    const out = emitRebaseNewMessages(rows);
    expect(out.map((r) => r.entry.id)).toEqual(['u-1', 'cmp-1', 'u-2']);
  });

  it('handles an empty input', () => {
    expect(emitRebaseNewMessages([])).toEqual([]);
  });

  it('produces output with the rebase\'s seq for newMessages (timeline anchor)', () => {
    // The compaction summary must land at the rebase's seq so it sits
    // between the superseded turns and the retained tail in the
    // renderer's ordered timeline.
    const rows: TimelineEntryRow[] = [
      row(userMsg('u-1', 'first', 1), 1),
      row(assistantMsg('a-1', 'reply', 2), 2),
      row(
        rebase('rb-1', null, [summaryMessage('summary-1', 'recap', 5)], 5),
        5,
      ),
      row(userMsg('u-2', 'continued', 6), 6),
    ];
    const out = emitRebaseNewMessages(rows);
    const summaryRow = out.find((r) => r.entry.id === 'summary-1')!;
    expect(summaryRow.seq).toBe(5);
  });
});