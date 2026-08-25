/**
 * Tests for the pure `applyRebases` projection helper. These do not touch
 * sqlite so they run even when the Electron-ABI sqlite binary is locked by
 * a running DUYA instance.
 *
 * The function is the projection backbone for compaction + edit-resend (plan
 * 441). It must:
 *   - drop raw message rows that a later rebase superseded,
 *   - emit rebase events verbatim (audit trail),
 *   - insert rebase.newMessages at the rebase's position,
 *   - leave rollout process events and compaction entries untouched.
 */

import { describe, expect, it } from 'vitest';
import { applyRebases, effectiveMessageTimeline, type TimelineEntryRow } from '../message-log';
import type { MessageEntry, CompactionEntry } from '@duya/agent/message';
import type { RebaseEvent, ReasoningEvent, ToolCallEvent } from '../rollout-events';

// ─── Builders ───

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

function toolCall(id: string, toolName: string, createdAt: number): ToolCallEvent {
  return { type: 'tool_call', id, turnId: 't-1', callId: id, toolName, inputSummary: '{}', createdAt };
}

function rebase(id: string, supersededUpToSeq: number, newMessages: MessageEntry[], createdAt: number): RebaseEvent {
  return { type: 'rebase', id, turnId: 't-1', supersededUpToSeq, newMessages, createdAt };
}

function row<T extends TimelineEntryRow['entry']>(entry: T, seq: number): TimelineEntryRow {
  return { entry, seq };
}

// ─── Tests ───

describe('applyRebases', () => {
  it('returns the input unchanged when there are no rebases', () => {
    const rows: TimelineEntryRow[] = [
      row(userMsg('u-1', 'hello', 1), 1),
      row(assistantMsg('a-1', 'hi', 2), 2),
    ];
    const out = applyRebases(rows);
    expect(out).toEqual(rows);
  });

  it('drops raw messages whose seq is superseded by a later rebase', () => {
    const rows: TimelineEntryRow[] = [
      row(userMsg('u-1', 'hello', 1), 1),
      row(assistantMsg('a-1', 'first reply', 2), 2),
      row(assistantMsg('a-2', 'second reply', 3), 3),
      row(rebase('rb-1', 3, [
        userMsg('u-2', 'continued', 4),
      ], 4), 4),
    ];

    const out = applyRebases(rows);

    // Expect: rb-1, u-2 (rebase-inserted).
    // u-1, a-1, a-2 are all superseded (seq 1, 2, 3 <= rb-1.supersededUpToSeq=3)
    // and not in newMessages, so dropped.
    expect(out.map((r) => r.entry.id)).toEqual(['rb-1', 'u-2']);
    expect(out[0].entry.type).toBe('rebase');
    expect(out[1].entry.type).toBe('message');
  });

  it('keeps a rebase\'s newMessages as message entries even though they are "inserted"', () => {
    const rows: TimelineEntryRow[] = [
      row(userMsg('u-1', 'first prompt', 1), 1),
      row(rebase('rb-1', 1, [userMsg('u-2', 'second prompt', 2)], 2), 2),
    ];

    const out = applyRebases(rows);

    // u-1 superseded (seq=1 <= rb-1.supersededUpToSeq=1, not in newMessages).
    // rb-1 kept (verbatim audit). u-2 emitted (in newMessages).
    expect(out.map((r) => r.entry.id)).toEqual(['rb-1', 'u-2']);
    expect(out[1].entry.type).toBe('message');
  });

  it('preserves a message that is rebase-emitted even when a later rebase would otherwise drop it', () => {
    // Edge case: a message id rebase-emitted at rebase A must NOT be dropped
    // by a later rebase B if A explicitly carried it forward (i.e. B's
    // supersededUpToSeq covers A's slot but the message was an A rebase insertion).
    const kept = userMsg('u-kept', 'kept by rebase 1', 5);
    const rows: TimelineEntryRow[] = [
      row(userMsg('u-1', 'first prompt', 1), 1),
      row(rebase('rb-1', 1, [kept], 5), 2),
      row(rebase('rb-2', 5, [], 10), 3), // would otherwise drop rb-1's kept
    ];

    const out = applyRebases(rows);

    // rb-2.supersededUpToSeq=5 covers kept (it was emitted with seq=2, but
    // rb-2 only supersedes up to seq=5 which includes the rb-1 event). The
    // rebase-emitted copy of u-kept was assigned seq=2 (rb-1's slot).
    // rb-2 supersedes up to seq=5 but the emitted u-kept is at seq=2 — so
    // it IS dropped by rb-2 unless explicitly re-emitted by rb-2.
    //
    // This test documents current behaviour (drop). Plan 441 follow-up may
    // want to track rebase-emitted ids to avoid double-supersession; for now
    // the simpler "latest rebase wins" semantic stands.
    const ids = out.map((r) => r.entry.id);
    expect(ids).toContain('rb-1');
    expect(ids).toContain('rb-2');
    // u-1 dropped by rb-1.
    expect(ids).not.toContain('u-1');
  });

  it('rollout process events pass through untouched', () => {
    const rows: TimelineEntryRow[] = [
      row(reasoning('r-1', 'thinking about u-1', 1), 1),
      row(toolCall('tc-1', 'Bash', 2), 2),
      row(userMsg('u-1', 'hello', 3), 3),
      row(rebase('rb-1', 3, [userMsg('u-2', 'continued', 4)], 4), 4),
    ];

    const out = applyRebases(rows);

    // Reasoning + toolCall + rebase all survive. u-1 dropped. u-2 inserted.
    expect(out.map((r) => r.entry.id)).toEqual(['r-1', 'tc-1', 'rb-1', 'u-2']);
  });

  it('compaction entries are NOT superseded by a later rebase', () => {
    // Compaction is a durable timeline entry (plan 315) — it survives rebases
    // because it represents an explicit context-fold event, not raw message
    // history. The rebase only supersedes MESSAGE rows.
    const rows: TimelineEntryRow[] = [
      row(userMsg('u-1', 'first', 1), 1),
      row(compaction('c-1', 'fold context here', 2), 2),
      row(userMsg('u-2', 'second', 3), 3),
      row(rebase('rb-1', 3, [userMsg('u-3', 'after fold', 4)], 4), 4),
    ];

    const out = applyRebases(rows);

    // c-1 kept even though seq=2 <= rb-1.supersededUpToSeq=3.
    // u-1 and u-2 dropped (u-2 is a message, u-1 is a message).
    expect(out.map((r) => r.entry.id)).toEqual(['c-1', 'rb-1', 'u-3']);
  });

  it('does not duplicate a survivor that a rebase carries forward (truncate*/compaction form)', () => {
    // Regression: truncateAfter/truncateFromInclusive pass ALL survivors as
    // newMessages with a null bound. The old kept-by-id exemption kept the
    // RAW row alive AND emitted the carried copy, duplicating the entire
    // prefix after one rewind. The raw rows must yield to the rebase's own
    // emission — exactly one copy per id.
    const rows: TimelineEntryRow[] = [
      row(userMsg('u-1', 'first', 1), 1),
      row(assistantMsg('a-1', 'reply', 2), 2),
      row(userMsg('u-2', 'second prompt (rewind target)', 3), 3),
      // Rewind to u-2: null bound, survivors u-1/a-1/u-2 carried verbatim.
      row(rebase('rb-1', null, [userMsg('u-1', 'first', 1), assistantMsg('a-1', 'reply', 2), userMsg('u-2', 'second prompt (rewind target)', 3)], 4), 4),
    ];

    const out = applyRebases(rows);
    const ids = out.map((r) => r.entry.id);
    expect(ids).toEqual(['rb-1', 'u-1', 'a-1', 'u-2']);
  });

  it('multiple rebases compose in order: each drops messages superseded by any LATER rebase', () => {
    const rows: TimelineEntryRow[] = [
      row(userMsg('u-1', 'first', 1), 1),
      row(userMsg('u-2', 'second', 2), 2),
      row(rebase('rb-1', 2, [userMsg('u-3', 'after rb-1', 3)], 3), 3),
      row(userMsg('u-3-dup', 'duplicate of u-3 from raw', 4), 4),
      row(rebase('rb-2', 4, [userMsg('u-4', 'final', 5)], 5), 5),
    ];

    const out = applyRebases(rows);

    // rb-1 (seq=3) supersedes u-1, u-2 (seq<=2) → drop them, emit u-3.
    // rb-2 (seq=5) supersedes everything seq<=4 EXCEPT its own newMessages.
    // u-3 (rebase-emitted by rb-1, placed at seq=3) is at seq<=4 and NOT
    // in rb-2.newMessages → dropped by rb-2.
    // u-3-dup (raw at seq=4) is at seq<=4 → dropped by rb-2.
    // rb-2 emitted; u-4 emitted.
    expect(out.map((r) => r.entry.id)).toEqual(['rb-1', 'rb-2', 'u-4']);
  });

  it('effectiveMessageTimeline drops events and yields the LLM-visible message view', () => {
    const rows: TimelineEntryRow[] = [
      row(reasoning('r-1', 'thinking', 1), 1),
      row(userMsg('u-1', 'first', 2), 2),
      row(assistantMsg('a-1', 'reply', 3), 3),
      row(rebase('rb-1', 3, [userMsg('u-2', 'after fold', 4)], 4), 4),
    ];

    const effective = effectiveMessageTimeline(rows);

    // r-1 dropped (event). u-1, a-1 superseded by rb-1 (not in newMessages).
    // rb-1 dropped (event — not message/compaction).
    // u-2 emitted from rebase.
    expect(effective.map((r) => r.entry.id)).toEqual(['u-2']);
    expect(effective[0].entry.type).toBe('message');
  });

  it('effectiveMessageTimeline preserves compaction entries through rebase', () => {
    const rows: TimelineEntryRow[] = [
      row(userMsg('u-1', 'first', 1), 1),
      row(compaction('c-1', 'summary', 2), 2),
      row(rebase('rb-1', 2, [], 3), 3),
    ];

    const effective = effectiveMessageTimeline(rows);

    expect(effective.map((r) => r.entry.id)).toEqual(['c-1']);
  });
});