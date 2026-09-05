/**
 * core-db-adapters-source.test.ts — Plan 489 P0.1 / P0.2
 *
 * Verifies the message origin classifier (`source`) round-trip through the
 * IPC DTO adapter layer:
 *
 *   1. `inferMessageSource` (internal helper) classifies each role + msg_type
 *      to the expected MessageSource value.
 *   2. `ipcMessageToNewEvent` writes the inferred (or caller-supplied)
 *      source into the MessageEntry payload AND the message.metadata copy
 *      (belt-and-suspenders for projector round-trips).
 *   3. `storedEventToIpcMessage` round-trips the source back out into the
 *      `MessageRow.source` field.
 *
 * The classifier table (in `core-db-adapters.ts::inferMessageSource`):
 *
 *   explicit `data.source` (if known) > role > msg_type > runtime-context
 *   cues > 'scratchpad'
 *
 * @see /docs/exec-plans/active/489-bot-chat-dataflow-and-complete-cards.md
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MessageLog, SessionStore, type NewEvent, type SqliteDatabase } from '../../db/core';
import {
  ipcMessageToNewEvent,
  newEventToIpcMessage,
  storedEventToIpcMessage,
} from '../core-db-adapters';

// better-sqlite3 native module may not load in some sandbox configs.
let nativeSqliteAvailable = true;
try {
  const probe = new Database(':memory:');
  probe.close();
} catch {
  nativeSqliteAvailable = false;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

function makeUserDTO(id: string, text: string, t: number) {
  return {
    id,
    session_id: 'sess-1',
    role: 'user',
    content: text,
    msg_type: 'text',
    status: 'done',
    created_at: t,
  };
}

function makeAssistantDTO(id: string, t: number) {
  return {
    id,
    session_id: 'sess-1',
    role: 'assistant',
    content: JSON.stringify([{ type: 'text', text: 'Hello from assistant' }]),
    msg_type: 'text',
    status: 'done',
    created_at: t,
  };
}

function makeToolDTO(id: string, toolCallId: string, t: number) {
  return {
    id,
    session_id: 'sess-1',
    role: 'tool',
    content: JSON.stringify({ result: 'success' }),
    tool_call_id: toolCallId,
    tool_name: 'BashTool',
    tool_input: JSON.stringify({ command: 'echo hello' }),
    msg_type: 'tool_result',
    status: 'done',
    created_at: t,
  };
}

function makeThinkingDTO(id: string, t: number) {
  return {
    id,
    session_id: 'sess-1',
    role: 'assistant',
    content: '',
    thinking: 'Let me think about this carefully...',
    msg_type: 'thinking',
    status: 'done',
    created_at: t,
  };
}

function makeSystemMailboxDTO(id: string, t: number) {
  return {
    id,
    session_id: 'sess-1',
    role: 'system',
    content: 'A background notification',
    msg_type: 'mailbox',
    status: 'done',
    created_at: t,
  };
}

describe.skipIf(!nativeSqliteAvailable)('Plan 489 P0.1 — message source classifier', () => {
  let tmpDir: string;
  let db: SqliteDatabase;
  let messageLog: MessageLog;
  let sessionStore: SessionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-source-test-'));
    db = new Database(path.join(tmpDir, 'core.db')) as unknown as SqliteDatabase;
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    // Core stores expect the MessageLog-managed schema (sessions +
    // message_index); apply the same migrations the app boot path runs.
    for (const migration of MessageLog.migrations) migration.up(db);
    for (const migration of SessionStore.migrations) migration.up(db);
    sessionStore = new SessionStore(db);
    messageLog = new MessageLog(db, tmpDir);
    sessionStore.create({
      id: 'sess-1',
      cwd: '/tmp',
      title: 'test',
      createdAt: 1,
      lastActivityAt: 1,
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── 1. Classification rules ──────────────────────────────────────────

  it('classifies role=user as source=user', () => {
    const dto = makeUserDTO('m-u', 'hi', 1);
    const event = ipcMessageToNewEvent('sess-1', dto as never);
    expect((event.payload as { source?: string }).source).toBe('user');
  });

  it('classifies role=tool as source=tool_use (tool_result block)', () => {
    const dto = makeToolDTO('m-t', 'tc-1', 2);
    const event = ipcMessageToNewEvent('sess-1', dto as never);
    expect((event.payload as { source?: string }).source).toBe('tool_use');
  });

  it('classifies msg_type=thinking as source=thinking', () => {
    const dto = makeThinkingDTO('m-th', 3);
    const event = ipcMessageToNewEvent('sess-1', dto as never);
    expect((event.payload as { source?: string }).source).toBe('thinking');
  });

  it('classifies runtime-context cues (mailbox / task-notification / etc.) as source=system', () => {
    for (const msgType of [
      'mailbox',
      'task-notification',
      'mode',
      'mode_changed',
      'memory',
      'goal_summary',
      'research_continuation',
      'attachment',
      'runtime_context',
    ]) {
      const dto = {
        id: `m-sys-${msgType}`,
        session_id: 'sess-1',
        role: 'system',
        content: '',
        msg_type: msgType,
        status: 'done',
        created_at: 100,
      };
      const event = ipcMessageToNewEvent('sess-1', dto as never);
      expect(
        (event.payload as { source?: string }).source,
        `msg_type=${msgType} should be system`,
      ).toBe('system');
    }
  });

  it('classifies plain assistant text (no source hint) as source=scratchpad', () => {
    const dto = makeAssistantDTO('m-a', 4);
    const event = ipcMessageToNewEvent('sess-1', dto as never);
    expect((event.payload as { source?: string }).source).toBe('scratchpad');
  });

  it("honors caller-provided data.source (SendMessageTool sets 'send_message')", () => {
    const dto = {
      ...makeAssistantDTO('m-sm', 5),
      source: 'send_message',
    };
    const event = ipcMessageToNewEvent('sess-1', dto as never);
    expect((event.payload as { source?: string }).source).toBe('send_message');
  });

  it('falls back to inferred default when caller provides an unknown source string', () => {
    const dto = {
      ...makeAssistantDTO('m-unknown', 6),
      source: 'this_is_not_a_real_source',
    };
    const event = ipcMessageToNewEvent('sess-1', dto as never);
    // Unknown source strings are ignored; role='assistant' + msg_type='text' → scratchpad
    expect((event.payload as { source?: string }).source).toBe('scratchpad');
  });

  // ─── 2. metadata.source belt-and-suspenders ──────────────────────────

  it('writes the inferred source into message.metadata.source as well', () => {
    const dto = { ...makeAssistantDTO('m-meta', 7), source: 'send_message' };
    const event = ipcMessageToNewEvent('sess-1', dto as never);
    const entry = event.payload as {
      message: { metadata?: Record<string, unknown> };
    };
    expect(entry.message.metadata?.source).toBe('send_message');
  });

  it('does NOT carry through whitelist-filtered metadata keys (preImageSha etc. only)', () => {
    // The IPC caller can stuff random metadata; only whitelisted keys
    // survive. `source` is added by the adapter itself, NOT from caller.
    const dto = {
      ...makeUserDTO('m-keep', 'hi', 8),
      metadata: {
        preImageSha: 'abc123',
        customJunk: 'should not survive',
        source: 'malicious_override', // ← ignored, source is adapter-controlled
      },
    };
    const event = ipcMessageToNewEvent('sess-1', dto as never);
    const entry = event.payload as {
      message: { metadata?: Record<string, unknown> };
    };
    expect(entry.message.metadata?.preImageSha).toBe('abc123');
    expect(entry.message.metadata?.customJunk).toBeUndefined();
    // Caller's `metadata.source` was filtered; the adapter still writes
    // the *correct* inferred source (role=user → 'user') under the same key.
    expect(entry.message.metadata?.source).toBe('user');
    expect((event.payload as { source?: string }).source).toBe('user');
  });

  // ─── 3. Round-trip through MessageLog + storedEventToIpcMessage ──────

  it('round-trips source from DTO → MessageEntry → StoredEvent → MessageRow', () => {
    // The tool_result host (msg_type='tool_use', same tool_call_id) must
    // precede the tool row — repairInterruptedToolCalls drops orphan
    // tool_results during projection, which would silently remove m-t1.
    const events: NewEvent[] = [
      ipcMessageToNewEvent('sess-1', makeUserDTO('m-u1', 'hi', 10) as never),
      ipcMessageToNewEvent(
        'sess-1',
        { ...makeAssistantDTO('m-a1', 11), source: 'send_message' } as never,
      ),
      ipcMessageToNewEvent(
        'sess-1',
        {
          ...makeAssistantDTO('m-tu1', 115),
          msg_type: 'tool_use',
          tool_call_id: 'tc-1',
          tool_name: 'BashTool',
          tool_input: JSON.stringify({ command: 'echo hello' }),
        } as never,
      ),
      ipcMessageToNewEvent('sess-1', makeToolDTO('m-t1', 'tc-1', 12) as never),
      ipcMessageToNewEvent('sess-1', makeThinkingDTO('m-th1', 13) as never),
    ];
    messageLog.appendBatch(events);
    const stored = messageLog.listBySession('sess-1');

    expect(stored).toHaveLength(5);

    const rows = stored
      .map((e) => storedEventToIpcMessage(e))
      .filter((r): r is NonNullable<typeof r> => r !== null);

    expect(rows[0]!.source).toBe('user');
    expect(rows[1]!.source).toBe('send_message');
    expect(rows[2]!.source).toBe('tool_use');
    expect(rows[3]!.source).toBe('tool_use');
    expect(rows[4]!.source).toBe('thinking');
  });

  it('survives compaction: MessageEntry source is preserved in rollout JSON', () => {
    const events: NewEvent[] = [
      ipcMessageToNewEvent('sess-1', makeUserDTO('m-c1', 'hi', 20) as never),
      ipcMessageToNewEvent(
        'sess-1',
        { ...makeAssistantDTO('m-c2', 21), source: 'send_message' } as never,
      ),
    ];
    messageLog.appendBatch(events);

    // Re-parse the stored payload directly to verify the JSON carries source.
    const stored = messageLog.listBySession('sess-1');
    const payload = JSON.parse(stored[1]!.payload) as { source?: string };
    expect(payload.source).toBe('send_message');
  });

  // ─── 4. Bot-direct view filter composition ───────────────────────────

  it('composes a bot-direct filter that hides tool_use / thinking / scratchpad / system', () => {
    // Simulate the projection the BotDirectChatView will run after P0.3
    // lands: source IN ['send_message', 'user'].
    const events: NewEvent[] = [
      ipcMessageToNewEvent('sess-1', makeUserDTO('m-bd-u', 'hi', 30) as never),
      ipcMessageToNewEvent(
        'sess-1',
        { ...makeAssistantDTO('m-bd-sm', 31), source: 'send_message' } as never,
      ),
      ipcMessageToNewEvent('sess-1', makeToolDTO('m-bd-t', 'tc-1', 32) as never),
      ipcMessageToNewEvent('sess-1', makeThinkingDTO('m-bd-th', 33) as never),
      ipcMessageToNewEvent('sess-1', makeSystemMailboxDTO('m-bd-sys', 34) as never),
      ipcMessageToNewEvent('sess-1', makeAssistantDTO('m-bd-sc', 35) as never),
    ];
    messageLog.appendBatch(events);
    const stored = messageLog.listBySession('sess-1');

    const visible = stored
      .map((e) => storedEventToIpcMessage(e))
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .filter((r) => r.source === 'send_message' || r.source === 'user');

    expect(visible.map((r) => r.id)).toEqual(['m-bd-u', 'm-bd-sm']);
  });
});

// ─── NewEvent → MessageRow broadcast adapter (no sqlite required) ──────

/**
 * Plan 489 P0.3 realtime regression: the db-bridge `message:append`
 * broadcast maps freshly-built NewEvents (object payload, no seq yet) to
 * MessageRows. These adapters are pure — no DB access — so they run even
 * when the better-sqlite3 native module is on the Electron ABI.
 */
describe('Plan 489 P0.3 — NewEvent broadcast adapter', () => {
  it('newEventToIpcMessage maps in-memory events (object payload) to visible rows', () => {
    // Simulates the db-bridge message:append broadcast path: the events
    // were just built by ipcMessageToNewEvent and handed to appendBatch —
    // their payload is still an OBJECT (no rollout-file round-trip, no
    // seq assigned yet).
    const event = ipcMessageToNewEvent(
      'sess-1',
      { ...makeAssistantDTO('m-rt-sm', 40), source: 'send_message' } as never,
    );

    const row = newEventToIpcMessage(event);
    expect(row).not.toBeNull();
    expect(row!.id).toBe('m-rt-sm');
    expect(row!.session_id).toBe('sess-1');
    expect(row!.source).toBe('send_message');
    expect(row!.seq_index).toBe(-1); // sentinel — seq assigned at storage time
  });

  it('newEventToIpcMessage never broadcasts a null row for send_message traffic', () => {
    // Regression lock: feeding a NewEvent (object payload) to
    // storedEventToIpcMessage JSON.parses "[object Object]" and returns
    // null — this is exactly what silenced the message:new realtime
    // merge in BotDirectChatView (refresh-only transcripts).
    const event = ipcMessageToNewEvent(
      'sess-1',
      { ...makeAssistantDTO('m-rt-null', 41), source: 'send_message' } as never,
    );
    expect(storedEventToIpcMessage(event as never)).toBeNull();
    expect(newEventToIpcMessage(event)).not.toBeNull();
  });
});
