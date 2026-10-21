/**
 * journal-projection.test.ts — end-to-end projection wiring (plan 441).
 *
 * The unit suites for applyRebases / repairInterruptedToolCalls cover the
 * pure helpers in isolation. This suite covers the INTEGRATION contract that
 * production readers depend on: whatever goes in through appendBatch /
 * appendRebase must come back out of the production read path
 * (`listBySession`) already folded:
 *
 *   1. A null-bound compaction rebase supersedes ALL prior raw messages,
 *      keeping only ids listed in newMessages — including for a session
 *      whose index seqs started well before the rebase (the resumed-session
 *      case a subprocess-local counter cannot handle).
 *   2. An interrupted tool_use (crash mid-turn) is read back with a
 *      synthesized tool_result; orphan tool_results are dropped.
 *   3. Boundary events re-emitted with the same deterministic id are
 *      deduplicated by INSERT OR IGNORE.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MessageLog } from '../message-log';
import type { SqliteDatabase } from '../database';

const SESSION = 'sess:journal-e2e';

function userMsg(id: string, text: string) {
  return {
    id,
    sessionId: SESSION,
    turnId: 't-1',
    payload: {
      type: 'message' as const,
      id,
      parentId: null,
      createdAt: 1000,
      message: { role: 'user' as const, id, content: text, timestamp: 1000, visibility: 'visible' as const },
    },
    createdAt: 1000,
  };
}

function assistantToolUse(id: string, toolCallId: string, createdAt: number) {
  return {
    id,
    sessionId: SESSION,
    turnId: 't-1',
    payload: {
      type: 'message' as const,
      id,
      parentId: null,
      createdAt,
      message: {
        role: 'assistant' as const,
        id,
        content: [{ type: 'tool_use' as const, id: toolCallId, name: 'read_file', input: { path: 'a.ts' } }],
        timestamp: createdAt,
        msg_type: 'tool_use',
        tool_call_id: toolCallId,
        visibility: 'visible' as const,
      },
    },
    createdAt,
  };
}

describe('journal → listBySession end-to-end projection', () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let messageLog: MessageLog;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-projection-test-'));
    db = new Database(path.join(tempDir, 'core.db')) as unknown as SqliteDatabase;
    db.pragma('journal_mode = WAL');
    for (const m of MessageLog.migrations.sort((a, b) => a.id - b.id)) {
      m.up(db);
    }
    messageLog = new MessageLog(db, tempDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('applies a null-bound compaction rebase on the production read path', () => {
    // Pre-existing history with DB-assigned seqs 1..4 (e.g. a RESUMED
    // session — a subprocess-local counter would compute a bound of ~0 here
    // and silently keep everything).
    messageLog.appendBatch([
      userMsg('m-1', 'hello'),
      assistantToolUse('m-2', 'call-1', 2000),
      userMsg('m-3', 'there'),
      userMsg('m-4', 'more history'),
    ]);

    // Compaction: supersede everything prior; only m-4 survives by id.
    const kept = [userMsg('m-4', 'more history')];
    messageLog.appendRebase(SESSION, null, null, [
      { ...kept[0]!, payload: kept[0]!.payload },
    ] as never);

    const events = messageLog.listBySession(SESSION);
    const ids = events.map((e) => JSON.parse(e.payload).id ?? e.id);

    // m-1..m-3 superseded; m-4 kept via newMessages; rebase row present.
    expect(ids).not.toContain('m-1');
    expect(ids).not.toContain('m-2');
    expect(ids).not.toContain('m-3');
    expect(ids).toContain('m-4');
    expect(events.some((e) => e.kind === 'rebase')).toBe(true);
  });

  it('synthesizes interrupted tool_results and drops orphans on read', () => {
    // Crash mid-turn: tool_use landed, its tool_result never will.
    // call-2's result exists without a matching tool_use (orphan).
    messageLog.appendBatch([
      assistantToolUse('a-1', 'call-1', 2000),
      {
        id: 'r-orphan',
        sessionId: SESSION,
        turnId: 't-1',
        payload: {
          type: 'message' as const,
          id: 'r-orphan',
          parentId: null,
          createdAt: 3000,
          message: {
            role: 'tool' as const,
            id: 'r-orphan',
            content: 'ghost result',
            timestamp: 3000,
            tool_call_id: 'no-such-call',
            visibility: 'visible' as const,
          },
        },
        createdAt: 3000,
      },
    ]);

    const payloads = messageLog.listBySession(SESSION).map((e) => JSON.parse(e.payload));
    const messages = payloads.filter((p) => p.type === 'message').map((p) => p.message);

    // Synthesized result for the dangling tool_use...
    expect(messages.some((m) => m.tool_call_id === 'call-1' && String(m.content).includes('[interrupted by crash]'))).toBe(true);
    // ...and the orphan tool_result is gone.
    expect(messages.some((m) => m.tool_call_id === 'no-such-call')).toBe(false);
  });

  it('deduplicates boundary re-emits with deterministic ids', () => {
    const event = userMsg('m-dup', 'exactly once');
    messageLog.appendBatch([event]);
    // Same boundary re-emitted after an app-level retry: identical
    // deterministic id → INSERT OR IGNORE drops it, file stays clean.
    messageLog.appendBatch([{ ...event }]);

    const rows = messageLog.listBySession(SESSION);
    expect(rows.filter((r) => r.id === 'm-dup')).toHaveLength(1);
  });
});
