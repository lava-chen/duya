/**
 * Session fork seed derivation tests (plan 506, Track B1).
 *
 * Pure derivation — no sqlite, no fs, no Electron. Coverage:
 *   1. Seed = exactly the messages up to and including the target; later
 *      messages are excluded.
 *   2. Non-message entries are ignored defensively even if present.
 *   3. message_not_found when the target id is absent from message entries
 *      (including ids that only exist on non-message rows).
 *   4. Fresh ids everywhere message identity appears (entry.id, inner
 *      message.id, parentId chain), consistent with NewEvent.id.
 *   5. threadMeta.replyToId remapping (seeded -> rewritten; outside the
 *      seed set -> left verbatim).
 *   6. createdAt ordering preserved in seedEvents.
 *   7. Determinism across identical calls; the input is never mutated.
 *   8. A tool_use/tool_result pair fully before the fork point survives
 *      with both members (repair already ran upstream — no reordering).
 */

import { describe, expect, it } from 'vitest';
import { deriveForkSeed } from '../session-fork';
import type { NewEvent, TimelineEntryRow } from '../message-log';
import type { TurnStartedEvent } from '../rollout-events';
import { THREAD_METADATA_KEY, type MessageEntry } from '@duya/agent/message';

// ─── Fixtures (mirror message-repair.test.ts builder shapes) ───

function textMsg(
  id: string,
  text: string,
  createdAt: number,
  parentId: string | null = null,
): MessageEntry {
  return {
    type: 'message',
    id,
    parentId,
    createdAt,
    message: {
      role: 'user',
      id,
      content: text,
      timestamp: createdAt,
      visibility: 'visible',
    },
  };
}

function replyMsg(
  id: string,
  text: string,
  createdAt: number,
  replyToId: string,
): MessageEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    createdAt,
    message: {
      role: 'user',
      id,
      content: text,
      timestamp: createdAt,
      visibility: 'visible',
      metadata: { [THREAD_METADATA_KEY]: { replyToId, branched: false } },
    },
  };
}

function toolUseMsg(id: string, callId: string, createdAt: number): MessageEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    createdAt,
    message: {
      role: 'assistant',
      id,
      content: [{ type: 'tool_use', id: callId, name: 'Bash', input: {} }],
      timestamp: createdAt,
      msg_type: 'tool_use',
      tool_call_id: callId,
      visibility: 'visible',
    },
  };
}

function toolResultMsg(id: string, callId: string, createdAt: number): MessageEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    createdAt,
    message: {
      role: 'tool',
      id,
      content: 'tool output',
      timestamp: createdAt,
      tool_call_id: callId,
      visibility: 'visible',
    },
  };
}

function turnStarted(id: string, turnId: string, startedAt: number): TurnStartedEvent {
  return { type: 'turn_started', id, turnId, startedAt };
}

function row(entry: TimelineEntryRow['entry'], seq: number): TimelineEntryRow {
  return { entry, seq };
}

/** Narrow seed payloads to MessageEntry (seed events are message-only). */
function messagePayloads(events: NewEvent[]): MessageEntry[] {
  return events.flatMap((e) => (e.payload.type === 'message' ? [e.payload] : []));
}

/** Structural readers — AgentMessage is a role union, so cast like threads.ts. */
function contentOf(entry: MessageEntry): unknown {
  return (entry.message as { content?: unknown }).content;
}

function replyToIdOf(entry: MessageEntry): string | undefined {
  const message = entry.message as { metadata?: Record<string, unknown> };
  const threadMeta = message.metadata?.[THREAD_METADATA_KEY] as
    | { replyToId?: unknown }
    | undefined;
  const replyToId = threadMeta?.replyToId;
  return typeof replyToId === 'string' ? replyToId : undefined;
}

function toolCallIdOf(entry: MessageEntry): string | undefined {
  const message = entry.message as { tool_call_id?: string };
  return message.tool_call_id;
}

// ─── Tests ───

describe('deriveForkSeed (plan 506, Track B1)', () => {
  it('seeds exactly the messages up to and including the target message', () => {
    const timeline: TimelineEntryRow[] = [
      row(textMsg('m-1', 'hello', 1_000), 1),
      row(textMsg('m-2', 'hi', 2_000), 2),
      row(textMsg('m-3', 'the fork point', 3_000), 3),
      row(textMsg('m-4', 'after the fork', 4_000), 4),
      row(textMsg('m-5', 'way after', 5_000), 5),
    ];

    const result = deriveForkSeed({ timeline, throughMessageId: 'm-3', newSessionId: 'fork-1' });

    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.seedEvents).toHaveLength(3);
    expect(result.seedEvents.map((e) => e.id)).toEqual([
      'fork:fork-1:m-1',
      'fork:fork-1:m-2',
      'fork:fork-1:m-3',
    ]);
    // Content survives the deep copy verbatim, in timeline order.
    const payloads = messagePayloads(result.seedEvents);
    expect(payloads.map(contentOf)).toEqual(['hello', 'hi', 'the fork point']);
  });

  it('ignores non-message entries defensively even when present in the input', () => {
    const timeline: TimelineEntryRow[] = [
      row(textMsg('m-1', 'first', 1_000), 1),
      row(turnStarted('evt-1', 'turn-1', 1_500), 2),
      row(textMsg('m-2', 'target', 2_000), 3),
      row(turnStarted('evt-2', 'turn-2', 2_500), 4),
      row(textMsg('m-3', 'after', 3_000), 5),
    ];

    const result = deriveForkSeed({ timeline, throughMessageId: 'm-2', newSessionId: 'fork-2' });

    expect(result.ok).toBe(true);
    expect(messagePayloads(result.seedEvents)).toHaveLength(2);
    // Only message ids enter the id space; events never do.
    expect([...result.idMap.keys()]).toEqual(['m-1', 'm-2']);
    expect(result.idMap.has('evt-1')).toBe(false);
    expect(result.idMap.has('evt-2')).toBe(false);
  });

  it('returns message_not_found when the target id is not a message entry', () => {
    const timeline: TimelineEntryRow[] = [
      row(textMsg('m-1', 'first', 1_000), 1),
      row(turnStarted('evt-ghost', 'turn-1', 1_500), 2),
      row(textMsg('m-2', 'second', 2_000), 3),
    ];

    // Absent entirely.
    const absent = deriveForkSeed({ timeline, throughMessageId: 'm-404', newSessionId: 'fork-3' });
    expect(absent.ok).toBe(false);
    expect(absent.reason).toBe('message_not_found');
    expect(absent.seedEvents).toEqual([]);
    expect(absent.idMap.size).toBe(0);

    // Present in the timeline but only on a non-message row — must not match.
    const eventOnly = deriveForkSeed({ timeline, throughMessageId: 'evt-ghost', newSessionId: 'fork-3' });
    expect(eventOnly.ok).toBe(false);
    expect(eventOnly.reason).toBe('message_not_found');
    expect(eventOnly.seedEvents).toEqual([]);
    expect(eventOnly.idMap.size).toBe(0);
  });

  it('mints fresh ids and remaps every identity field consistently', () => {
    const timeline: TimelineEntryRow[] = [
      row(textMsg('m-1', 'first', 1_000), 1),
      row(textMsg('m-2', 'second', 2_000, 'm-1'), 2),
      row(textMsg('m-3', 'target', 3_000, 'm-2'), 3),
      row(textMsg('m-4', 'after', 4_000), 4),
    ];

    const result = deriveForkSeed({ timeline, throughMessageId: 'm-3', newSessionId: 'fork-4' });

    expect(result.ok).toBe(true);
    const sourceIds = ['m-1', 'm-2', 'm-3'];

    // Every minted id is fresh — none collides with a source id (the
    // message_index.id global primary key constraint).
    for (const ev of result.seedEvents) {
      expect(sourceIds).not.toContain(ev.id);
    }
    expect(result.idMap.size).toBe(3);
    for (const oldId of sourceIds) {
      expect(result.idMap.get(oldId)).toBe(`fork:fork-4:${oldId}`);
    }

    // NewEvent.id, payload.id and inner message.id are in lockstep, and the
    // event is stamped for the new session.
    for (const ev of result.seedEvents) {
      expect(ev.sessionId).toBe('fork-4');
      expect(ev.turnId).toBeNull();
      const payload = messagePayloads([ev])[0];
      expect(payload.id).toBe(ev.id);
      expect(payload.message.id).toBe(ev.id);
    }

    // Parent chain is remapped onto the new id space.
    const msgs = messagePayloads(result.seedEvents);
    expect(msgs[0].parentId).toBeNull();
    expect(msgs[1].parentId).toBe('fork:fork-4:m-1');
    expect(msgs[2].parentId).toBe('fork:fork-4:m-2');
  });

  it('rewrites replyToId onto the new id space and leaves outside references verbatim', () => {
    const timeline: TimelineEntryRow[] = [
      row(textMsg('m-1', 'root', 1_000), 1),
      row(replyMsg('m-2', 'reply to m-1', 2_000, 'm-1'), 2),
      row(replyMsg('m-3', 'reply to a dangling id', 3_000, 'm-999'), 3),
      row(textMsg('m-4', 'after the fork', 4_000), 4),
    ];

    const result = deriveForkSeed({ timeline, throughMessageId: 'm-3', newSessionId: 'fork-5' });

    expect(result.ok).toBe(true);
    const msgs = messagePayloads(result.seedEvents);

    // Points at a seeded message -> rewritten to its new id.
    expect(replyToIdOf(msgs[1])).toBe('fork:fork-5:m-1');
    // Points outside the seed set (dangling / past the fork) -> verbatim.
    expect(replyToIdOf(msgs[2])).toBe('m-999');
  });

  it('preserves the original createdAt values and their ordering in seedEvents', () => {
    const timeline: TimelineEntryRow[] = [
      row(textMsg('m-1', 'a', 1_000), 1),
      row(textMsg('m-2', 'b', 2_000), 2),
      row(textMsg('m-3', 'c', 3_000), 3),
      row(textMsg('m-4', 'd', 4_000), 4),
    ];

    const result = deriveForkSeed({ timeline, throughMessageId: 'm-2', newSessionId: 'fork-6' });

    expect(result.ok).toBe(true);
    const createdAts = result.seedEvents.map((e) => e.createdAt);
    expect(createdAts).toEqual([1_000, 2_000]);
    for (let i = 1; i < createdAts.length; i++) {
      expect(createdAts[i]).toBeGreaterThan(createdAts[i - 1]);
    }
  });

  it('is deterministic: identical inputs produce identical seed events without mutating the input', () => {
    const timeline: TimelineEntryRow[] = [
      row(textMsg('m-1', 'a', 1_000), 1),
      row(replyMsg('m-2', 'b', 2_000, 'm-1'), 2),
      row(textMsg('m-3', 'c', 3_000), 3),
      row(textMsg('m-4', 'd', 4_000), 4),
    ];
    const input = {
      timeline,
      throughMessageId: 'm-3',
      newSessionId: 'fork-7',
      idPrefix: 'seed',
    };

    const first = deriveForkSeed(input);
    const second = deriveForkSeed(input);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.seedEvents).toEqual(first.seedEvents);
    expect(second.idMap).toEqual(first.idMap);
    // Custom prefix is honored.
    expect(first.seedEvents.map((e) => e.id)).toEqual([
      'seed:fork-7:m-1',
      'seed:fork-7:m-2',
      'seed:fork-7:m-3',
    ]);

    // The source timeline is untouched (deep-copy discipline).
    expect(timeline.map((r) => r.entry.id)).toEqual(['m-1', 'm-2', 'm-3', 'm-4']);
    const sourceReply = timeline[1].entry as MessageEntry;
    expect(replyToIdOf(sourceReply)).toBe('m-1');
    expect(sourceReply.id).toBe('m-2');
  });

  it('keeps a tool_use/tool_result pair fully before the fork point intact', () => {
    const timeline: TimelineEntryRow[] = [
      row(textMsg('u-1', 'run it', 1_000), 1),
      row(toolUseMsg('a-1', 'call-1', 2_000), 2),
      row(toolResultMsg('t-1', 'call-1', 3_000), 3),
      row(textMsg('u-2', 'after the pair', 4_000), 4),
    ];

    const result = deriveForkSeed({ timeline, throughMessageId: 't-1', newSessionId: 'fork-8' });

    expect(result.ok).toBe(true);
    const msgs = messagePayloads(result.seedEvents);
    expect(msgs).toHaveLength(3);

    // Both members survive, in order, with fresh ids.
    expect(msgs.map((m) => m.id)).toEqual([
      'fork:fork-8:u-1',
      'fork:fork-8:a-1',
      'fork:fork-8:t-1',
    ]);
    expect(msgs[1].message.role).toBe('assistant');
    expect(msgs[2].message.role).toBe('tool');

    // The pairing key survives verbatim so the tool_use/tool_result pair
    // still matches after the fork (tool_call_id is a pairing id, not a
    // message identity).
    expect(toolCallIdOf(msgs[1])).toBe('call-1');
    expect(toolCallIdOf(msgs[2])).toBe('call-1');
  });
});
