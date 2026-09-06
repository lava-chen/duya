/**
 * Session fork tests (plan 506, Track B).
 *
 * Pure derivation (B1) — no sqlite, no fs, no Electron. Coverage:
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
 *
 * Orchestration (B1) — real MessageLog + SessionStore + SpawnEdgeStore over
 * a temp better-sqlite3 database (schema built from the stores' own
 * migrations, sorted by id like CoreDatabase). Coverage:
 *   9. forkSession happy path: seeds land in the new session with remapped
 *      ids, the session row mirrors the source with parentSessionId set,
 *      and a 'fork' spawn edge is recorded.
 *  10. source_not_found / message_not_found leave nothing behind.
 *  11. Reply-thread remap survives the appendBatch round trip.
 *  12. Forking at the FIRST message seeds exactly that one message.
 *
 * Lineage helpers (B2) — pure edge-array walks:
 *  13. ancestorChain: nearest-first order, [] for roots, cycle-safe.
 *  14. childrenOf: direct children oldest-first, spawnType filter.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ancestorChain,
  childrenOf,
  deriveForkSeed,
  forkSession,
  type ForkSessionDeps,
  type LineageEdge,
} from '../session-fork';
import { MessageLog, type NewEvent, type TimelineEntryRow } from '../message-log';
import type { TurnStartedEvent } from '../rollout-events';
import { THREAD_METADATA_KEY, type MessageEntry } from '@duya/agent/message';
import type { SqliteDatabase } from '../database';
import { SessionStore } from '../session-store';
import { SpawnEdgeStore } from '../stores';

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

/** Wrap a MessageEntry as a NewEvent for MessageLog.appendBatch. */
function seedEvent(sessionId: string, entry: MessageEntry): NewEvent {
  return { id: entry.id, sessionId, turnId: null, payload: entry, createdAt: entry.createdAt };
}

/** Parse a StoredEvent payload (raw JSON string) back into a MessageEntry. */
function storedEntry(payload: string): MessageEntry {
  return JSON.parse(payload) as MessageEntry;
}

/** Minimal LineageEdge fixture. */
function lineageEdge(
  parentSessionId: string,
  childSessionId: string,
  spawnType: string,
  spawnedAt: number,
): LineageEdge {
  return { parentSessionId, childSessionId, spawnType, spawnedAt };
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

// ─── forkSession orchestration (real stores, temp sqlite) ───

describe('forkSession orchestration (plan 506, Track B1)', () => {
  let tempDir: string;
  let rootDir: string;
  let db: SqliteDatabase;
  let messageLog: MessageLog;
  let sessions: SessionStore;
  let spawnEdges: SpawnEdgeStore;
  let deps: ForkSessionDeps;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-session-fork-'));
    rootDir = path.join(tempDir, 'data');
    fs.mkdirSync(rootDir, { recursive: true });
    db = new Database(path.join(tempDir, 'core.db')) as unknown as SqliteDatabase;
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // Schema from the stores' own migrations, sorted by id like CoreDatabase
    // (1 message_index, 2 sessions, 9 spawn edges, 13/14 bumps, 15 search).
    const migrations = [
      ...MessageLog.migrations,
      ...SessionStore.migrations,
      ...SpawnEdgeStore.migrations,
    ].sort((a, b) => a.id - b.id);
    for (const m of migrations) m.up(db);
    messageLog = new MessageLog(db, rootDir);
    sessions = new SessionStore(db);
    spawnEdges = new SpawnEdgeStore(db);
    deps = { messageLog, sessions, spawnEdges };
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('forks at message #2 of a 3-message session: seeds 2, remaps ids, links lineage', () => {
    const sourceId = 'src-1';
    const newId = 'fork-1';
    const t = Date.UTC(2026, 8, 7, 9, 0, 0);
    sessions.create({
      id: sourceId,
      title: 'Original',
      workingDirectory: 'e:/proj/duya',
      projectName: 'duya',
      model: 'test-model',
      providerId: 'test-provider',
      mode: 'code',
      permissionMode: 'default',
      agentName: 'tester',
    });
    messageLog.appendBatch([
      seedEvent(sourceId, textMsg('m-1', 'first', t)),
      seedEvent(sourceId, textMsg('m-2', 'second', t + 1)),
      seedEvent(sourceId, textMsg('m-3', 'third, after the fork', t + 2)),
    ]);

    const result = forkSession(deps, {
      sourceSessionId: sourceId,
      throughMessageId: 'm-2',
      newSessionId: newId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.sessionId).toBe(newId);
    expect(result.seedCount).toBe(2);
    expect(result.idMap.get('m-2')).toBe(`fork:${newId}:m-2`);

    // The new session reads back end-to-end with remapped ids and content.
    const events = messageLog.listBySession(newId);
    expect(events.map((e) => e.id)).toEqual([`fork:${newId}:m-1`, `fork:${newId}:m-2`]);
    expect(events.map((e) => contentOf(storedEntry(e.payload)))).toEqual(['first', 'second']);

    // The session row mirrors the source and carries lineage on itself.
    const forkRow = sessions.get(newId);
    expect(forkRow).not.toBeNull();
    expect(forkRow?.parentSessionId).toBe(sourceId);
    expect(forkRow?.title).toBe('Original (fork)');
    expect(forkRow?.workingDirectory).toBe('e:/proj/duya');
    expect(forkRow?.projectName).toBe('duya');
    expect(forkRow?.model).toBe('test-model');
    expect(forkRow?.providerId).toBe('test-provider');
    expect(forkRow?.mode).toBe('code');
    expect(forkRow?.permissionMode).toBe('default');
    expect(forkRow?.agentName).toBe('tester');
    expect(forkRow?.status).toBe('active');

    // The spawn edge is recorded with spawnType 'fork'.
    const edge = spawnEdges.getParent(newId);
    expect(edge).not.toBeNull();
    expect(edge?.parentSessionId).toBe(sourceId);
    expect(edge?.childSessionId).toBe(newId);
    expect(edge?.spawnType).toBe('fork');
    expect(edge?.spawnReason).toBe('fork at message m-2');
    expect(edge?.spawnTurnId).toBeNull();

    // Structural typing: live SpawnEdge[] feeds the pure lineage helpers.
    const forkChildren = childrenOf(spawnEdges.listChildren(sourceId), sourceId, 'fork');
    expect(forkChildren.map((c) => c.sessionId)).toEqual([newId]);

    // The source session is untouched.
    expect(messageLog.listBySession(sourceId).map((e) => e.id)).toEqual(['m-1', 'm-2', 'm-3']);
  });

  it('returns source_not_found when the source session does not exist', () => {
    const result = forkSession(deps, {
      sourceSessionId: 'ghost',
      throughMessageId: 'm-1',
      newSessionId: 'fork-2',
    });

    expect(result).toEqual({ ok: false, reason: 'source_not_found', seedCount: 0 });
    expect(sessions.get('fork-2')).toBeNull();
  });

  it('returns message_not_found when throughMessageId is absent, writing nothing', () => {
    const sourceId = 'src-3';
    const newId = 'fork-3';
    const t = Date.UTC(2026, 8, 7, 9, 30, 0);
    sessions.create({ id: sourceId, title: 'Original' });
    messageLog.appendBatch([seedEvent(sourceId, textMsg('m-1', 'only', t))]);

    const result = forkSession(deps, {
      sourceSessionId: sourceId,
      throughMessageId: 'm-404',
      newSessionId: newId,
    });

    expect(result).toEqual({ ok: false, reason: 'message_not_found', seedCount: 0 });
    // Nothing was written: no session row, no rollout, no spawn edge.
    expect(sessions.get(newId)).toBeNull();
    expect(spawnEdges.getParent(newId)).toBeNull();
    expect(messageLog.listBySession(newId)).toEqual([]);
  });

  it('remaps threadMeta.replyToId end-to-end so the reply thread survives the fork', () => {
    const sourceId = 'src-4';
    const newId = 'fork-4';
    const t = Date.UTC(2026, 8, 7, 10, 0, 0);
    sessions.create({ id: sourceId, title: 'Threaded' });
    messageLog.appendBatch([
      seedEvent(sourceId, textMsg('a-1', 'thread root', t)),
      seedEvent(sourceId, replyMsg('b-1', 'reply to root', t + 1, 'a-1')),
      seedEvent(sourceId, textMsg('c-1', 'after the fork point', t + 2)),
    ]);

    const result = forkSession(deps, {
      sourceSessionId: sourceId,
      throughMessageId: 'b-1',
      newSessionId: newId,
    });

    expect(result.ok).toBe(true);
    const events = messageLog.listBySession(newId);
    expect(events.map((e) => e.id)).toEqual([`fork:${newId}:a-1`, `fork:${newId}:b-1`]);
    // The reply's reference points at the REMAPPED root id in the new session.
    expect(replyToIdOf(storedEntry(events[1].payload))).toBe(`fork:${newId}:a-1`);
  });

  it('forking at the FIRST message seeds exactly that one message', () => {
    const sourceId = 'src-5';
    const newId = 'fork-5';
    const t = Date.UTC(2026, 8, 7, 11, 0, 0);
    sessions.create({ id: sourceId, title: 'Original' });
    messageLog.appendBatch([
      seedEvent(sourceId, textMsg('m-1', 'the only seeded one', t)),
      seedEvent(sourceId, textMsg('m-2', 'excluded', t + 1)),
    ]);

    const result = forkSession(deps, {
      sourceSessionId: sourceId,
      throughMessageId: 'm-1',
      newSessionId: newId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.seedCount).toBe(1);
    expect(messageLog.listBySession(newId).map((e) => e.id)).toEqual([`fork:${newId}:m-1`]);
  });
});

// ─── Lineage helpers (pure) ───

describe('lineage helpers (plan 506, Track B2)', () => {
  const t1 = 1_000;
  const t2 = 2_000;
  const t3 = 3_000;
  const t4 = 4_000;

  it('ancestorChain walks nearest-first up to the root; roots return []', () => {
    const edges: LineageEdge[] = [
      lineageEdge('A', 'B', 'fork', t1),
      lineageEdge('B', 'C', 'subagent', t2),
    ];

    const chain = ancestorChain(edges, 'C');
    expect(chain.map((n) => n.sessionId)).toEqual(['B', 'A']);
    // Each node carries its OWN spawn metadata (the edge whose child it is);
    // the root ancestor has no incoming edge, hence null fields.
    expect(chain[0]).toEqual({
      sessionId: 'B',
      parentSessionId: 'A',
      spawnType: 'fork',
      spawnedAt: t1,
    });
    expect(chain[1]).toEqual({
      sessionId: 'A',
      parentSessionId: null,
      spawnType: null,
      spawnedAt: null,
    });

    // A root session (no incoming edge) has an empty chain.
    expect(ancestorChain(edges, 'A')).toEqual([]);
    // Unknown ids behave like roots.
    expect(ancestorChain(edges, 'Z')).toEqual([]);
  });

  it('ancestorChain terminates on a malformed edge cycle instead of hanging', () => {
    const cycle: LineageEdge[] = [
      lineageEdge('A', 'B', 'fork', t1),
      lineageEdge('B', 'A', 'fork', t2),
    ];

    // Neither walk loops; each emits the single reachable ancestor.
    expect(ancestorChain(cycle, 'A').map((n) => n.sessionId)).toEqual(['B']);
    expect(ancestorChain(cycle, 'B').map((n) => n.sessionId)).toEqual(['A']);
  });

  it('childrenOf returns direct children oldest-first, filtered by spawnType when given', () => {
    const edges: LineageEdge[] = [
      lineageEdge('A', 'B', 'subagent', t2),
      lineageEdge('A', 'C', 'fork', t1),
      lineageEdge('A', 'D', 'fork', t3),
      lineageEdge('C', 'E', 'fork', t4), // grandchild of A — never returned for A
    ];

    // All edge types, oldest first.
    expect(childrenOf(edges, 'A').map((n) => n.sessionId)).toEqual(['C', 'B', 'D']);

    // Fork-only filter, oldest first.
    const forks = childrenOf(edges, 'A', 'fork');
    expect(forks.map((n) => n.sessionId)).toEqual(['C', 'D']);
    expect(forks[0]).toEqual({
      sessionId: 'C',
      parentSessionId: 'A',
      spawnType: 'fork',
      spawnedAt: t1,
    });

    // No children / unknown parent.
    expect(childrenOf(edges, 'B')).toEqual([]);
    expect(childrenOf(edges, 'missing')).toEqual([]);
  });
});
