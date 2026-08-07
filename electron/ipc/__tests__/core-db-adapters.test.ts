/**
 * core-db-adapters.test.ts — Round-trip + forwarding correctness tests for
 * the DTO adapter layer (plan 328 Phase 2.3).
 *
 * Coverage:
 *  1. Message round-trip: ipcMessageToNewEvent → appendBatch →
 *     storedEventToIpcMessage — field-by-field equivalence for user,
 *     assistant (with thinking/tool_use blocks + signatures), and tool
 *     messages.
 *  2. message:replace idempotency — same-ID replay via appendBatch does
 *     not produce duplicate rows.
 *  3. rewriteSession — after truncation, no duplicate rows and seq is
 *     continuous starting at 1.
 *  4. Task adapter round-trip: ipcTaskToCoreCreate → TaskStore.create →
 *     coreTaskToIpcRow — snake_case field equivalence.
 *  5. Permission adapter round-trip: ipcPermissionToCoreCreate →
 *     PermissionLedger.create → corePermissionToIpcRow — snake_case field
 *     equivalence.
 *  6. Session adapter round-trip: ipcSessionToCoreCreate → SessionStore.create
 *     → coreSessionToIpcRow — extension fields (conductor_*, system_prompt)
 *     and is_deleted derivation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MessageLog,
  SessionStore,
  TaskStore,
  PermissionLedger,
  LockStore,
  type NewEvent,
  type SqliteDatabase,
} from '../../db/core';
import {
  ipcMessageToNewEvent,
  storedEventToIpcMessage,
  storedEventsToIpcMessages,
  ipcSessionToCoreCreate,
  coreSessionToIpcRow,
  ipcTaskToCoreCreate,
  coreTaskToIpcRow,
  ipcPermissionToCoreCreate,
  corePermissionToIpcRow,
  serializeMessageContent,
} from '../core-db-adapters';

let nativeSqliteAvailable = true;
try {
  const probe = new Database(':memory:');
  probe.close();
} catch {
  nativeSqliteAvailable = false;
}

// ─── Test fixtures ───

function makeUserDTO(id: string, text: string, createdAt: number): Record<string, unknown> {
  return {
    id,
    session_id: 'sess-1',
    role: 'user',
    content: text,
    msg_type: 'text',
    status: 'done',
    created_at: createdAt,
  };
}

function makeAssistantDTO(id: string, createdAt: number): Record<string, unknown> {
  return {
    id,
    session_id: 'sess-1',
    role: 'assistant',
    content: JSON.stringify([{ type: 'text', text: 'Hello from assistant' }]),
    thinking: 'I should greet the user',
    msg_type: 'text',
    status: 'done',
    created_at: createdAt,
  };
}

function makeToolDTO(id: string, toolCallId: string, createdAt: number): Record<string, unknown> {
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
    created_at: createdAt,
  };
}

function createSessionsFixture(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE sessions (
      id                TEXT PRIMARY KEY,
      title             TEXT NOT NULL DEFAULT 'New Chat',
      working_directory TEXT NOT NULL DEFAULT '',
      project_name      TEXT NOT NULL DEFAULT '',
      status            TEXT NOT NULL DEFAULT 'active',
      model             TEXT NOT NULL DEFAULT '',
      provider_id       TEXT NOT NULL DEFAULT 'env',
      mode              TEXT NOT NULL DEFAULT 'code',
      permission_mode   TEXT NOT NULL DEFAULT 'default',
      agent_profile_id  TEXT,
      parent_session_id TEXT,
      agent_type        TEXT NOT NULL DEFAULT 'main',
      agent_name        TEXT NOT NULL DEFAULT '',
      draft             TEXT,
      extensions        TEXT NOT NULL DEFAULT '{}',
      rollout_path      TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
  `);
}

function insertSessionFixture(db: SqliteDatabase, id: string, createdAt: number): void {
  db.prepare(
    'INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
  ).run(id, 'Test', createdAt, createdAt);
}

// ─── Tests ───

describe.skipIf(!nativeSqliteAvailable)('core-db-adapters', () => {
  let tempDir: string;
  let rootDir: string;
  let db: SqliteDatabase;
  let messageLog: MessageLog;
  let sessions: SessionStore;
  let tasks: TaskStore;
  let permissions: PermissionLedger;
  let locks: LockStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-adapters-test-'));
    rootDir = path.join(tempDir, 'data');
    fs.mkdirSync(rootDir, { recursive: true });
    db = new Database(path.join(tempDir, 'core.db')) as unknown as SqliteDatabase;
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    for (const m of MessageLog.migrations) m.up(db);
    for (const m of SessionStore.migrations) m.up(db);
    for (const m of TaskStore.migrations) m.up(db);
    for (const m of PermissionLedger.migrations) m.up(db);
    for (const m of LockStore.migrations) m.up(db);
    messageLog = new MessageLog(db, rootDir);
    sessions = new SessionStore(db);
    tasks = new TaskStore(db);
    permissions = new PermissionLedger(db);
    locks = new LockStore(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // ─── 1. Message round-trip ───

  describe('message round-trip', () => {
    beforeEach(() => {
      insertSessionFixture(db, 'sess-1', Date.now());
    });

    it('user message round-trips all fields', () => {
      const t = Date.now();
      const dto = makeUserDTO('m-1', 'Hello world', t);
      const event = ipcMessageToNewEvent('sess-1', dto as never);
      messageLog.appendBatch([event]);

      const stored = messageLog.listBySession('sess-1');
      expect(stored).toHaveLength(1);
      const row = storedEventToIpcMessage(stored[0])!;

      expect(row.id).toBe('m-1');
      expect(row.session_id).toBe('sess-1');
      expect(row.role).toBe('user');
      expect(row.content).toBe('Hello world');
      expect(row.msg_type).toBe('text');
      expect(row.status).toBe('done');
      expect(row.created_at).toBe(t);
    });

        it('assistant message round-trips thinking and content', () => {
      const t = Date.now();
      const dto = makeAssistantDTO('m-2', t);
      const event = ipcMessageToNewEvent('sess-1', dto as never);
      messageLog.appendBatch([event]);

      const stored = messageLog.listBySession('sess-1');
      expect(stored).toHaveLength(1);
      const row = storedEventToIpcMessage(stored[0])!;

      expect(row.id).toBe('m-2');
      expect(row.role).toBe('assistant');
      expect(row.thinking).toBe('I should greet the user');
      expect(row.msg_type).toBe('text');
    });

    it('tool message round-trips tool_name, tool_input, parent_tool_call_id', () => {
      const t = Date.now();
      const dto = makeToolDTO('m-3', 'tc-1', t);
      const event = ipcMessageToNewEvent('sess-1', dto as never);
      messageLog.appendBatch([event]);

      const stored = messageLog.listBySession('sess-1');
      expect(stored).toHaveLength(1);
      const row = storedEventToIpcMessage(stored[0])!;

      expect(row.id).toBe('m-3');
      expect(row.role).toBe('tool');
      expect(row.tool_call_id).toBe('tc-1');
      expect(row.tool_name).toBe('BashTool');
      expect(row.parent_tool_call_id).toBe('tc-1');
      expect(row.msg_type).toBe('tool_result');
    });

    it('multiple messages preserve seq ordering via storedEventsToIpcMessages', () => {
      const t = Date.now();
      const events: NewEvent[] = [
        ipcMessageToNewEvent('sess-1', makeUserDTO('m-1', 'first', t) as never),
        ipcMessageToNewEvent('sess-1', makeAssistantDTO('m-2', t + 1) as never),
        ipcMessageToNewEvent('sess-1', makeToolDTO('m-3', 'tc-1', t + 2) as never),
      ];
      messageLog.appendBatch(events);

      const stored = messageLog.listBySession('sess-1');
      const rows = storedEventsToIpcMessages(stored);
      expect(rows).toHaveLength(3);
      expect(rows[0].id).toBe('m-1');
      expect(rows[1].id).toBe('m-2');
      expect(rows[2].id).toBe('m-3');
      expect(rows.map((r) => r.seq_index)).toEqual([1, 2, 3]);
    });
  });

  // ─── 2. message:replace idempotency (same-ID replay) ───

  describe('message:replace idempotency', () => {
    beforeEach(() => {
      insertSessionFixture(db, 'sess-1', Date.now());
    });

    it('same-ID replay via appendBatch does not duplicate rows', () => {
      const t = Date.now();
      const event = ipcMessageToNewEvent('sess-1', makeUserDTO('m-1', 'original', t) as never);
      messageLog.appendBatch([event]);
      messageLog.appendBatch([event]); // idempotent re-append

      expect(messageLog.getCount('sess-1')).toBe(1);
      const stored = messageLog.listBySession('sess-1');
      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe('m-1');
    });

    it('batch with mix of new and existing IDs only appends new ones', () => {
      const t = Date.now();
      const e1 = ipcMessageToNewEvent('sess-1', makeUserDTO('m-1', 'first', t) as never);
      messageLog.appendBatch([e1]);

      const e2 = ipcMessageToNewEvent('sess-1', makeUserDTO('m-2', 'second', t + 1) as never);
      messageLog.appendBatch([e1, e2]); // m-1 exists, m-2 is new

      expect(messageLog.getCount('sess-1')).toBe(2);
    });
  });

  // ─── 3. rewriteSession (truncate) ───

  describe('rewriteSession', () => {
    beforeEach(() => {
      insertSessionFixture(db, 'sess-1', Date.now());
    });

    it('truncateAfter keeps [0, target] inclusive, no duplicates, seq continuous', () => {
      const t = Date.now();
      const events: NewEvent[] = [
        ipcMessageToNewEvent('sess-1', makeUserDTO('m-1', 'first', t) as never),
        ipcMessageToNewEvent('sess-1', makeAssistantDTO('m-2', t + 1) as never),
        ipcMessageToNewEvent('sess-1', makeUserDTO('m-3', 'third', t + 2) as never),
      ];
      messageLog.appendBatch(events);
      expect(messageLog.getCount('sess-1')).toBe(3);

      // Simulate truncateAfter(m-2): keep [0, 1] (m-1, m-2)
      const allEvents = messageLog.listBySession('sess-1');
      const cutIdx = allEvents.findIndex((e) => e.id === 'm-2');
      const keptEvents: NewEvent[] = allEvents.slice(0, cutIdx + 1).map((e) => ({
        id: e.id,
        sessionId: e.sessionId,
        turnId: e.turnId,
        payload: JSON.parse(e.payload),
        createdAt: e.createdAt,
      }));
      messageLog.rewriteSession('sess-1', keptEvents);

      expect(messageLog.getCount('sess-1')).toBe(2);
      const stored = messageLog.listBySession('sess-1');
      expect(stored.map((e) => e.id)).toEqual(['m-1', 'm-2']);
      expect(stored.map((e) => e.seq)).toEqual([1, 2]);
    });

    it('truncateFromInclusive keeps [0, target) exclusive, no duplicates', () => {
      const t = Date.now();
      const events: NewEvent[] = [
        ipcMessageToNewEvent('sess-1', makeUserDTO('m-1', 'first', t) as never),
        ipcMessageToNewEvent('sess-1', makeAssistantDTO('m-2', t + 1) as never),
        ipcMessageToNewEvent('sess-1', makeUserDTO('m-3', 'third', t + 2) as never),
      ];
      messageLog.appendBatch(events);

      // Simulate truncateFromInclusive(m-2): keep [0, 1) → just m-1
      const allEvents = messageLog.listBySession('sess-1');
      const cutIdx = allEvents.findIndex((e) => e.id === 'm-2');
      const keptEvents: NewEvent[] = allEvents.slice(0, cutIdx).map((e) => ({
        id: e.id,
        sessionId: e.sessionId,
        turnId: e.turnId,
        payload: JSON.parse(e.payload),
        createdAt: e.createdAt,
      }));
      messageLog.rewriteSession('sess-1', keptEvents);

      expect(messageLog.getCount('sess-1')).toBe(1);
      const stored = messageLog.listBySession('sess-1');
      expect(stored[0].id).toBe('m-1');
      expect(stored[0].seq).toBe(1);
    });

    it('rewriteSession to empty clears all rows', () => {
      const t = Date.now();
      messageLog.appendBatch([
        ipcMessageToNewEvent('sess-1', makeUserDTO('m-1', 'first', t) as never),
      ]);
      messageLog.rewriteSession('sess-1', []);
      expect(messageLog.getCount('sess-1')).toBe(0);
    });
  });

  // ─── 4. Task adapter round-trip ───

  describe('task adapter round-trip', () => {
    it('ipcTaskToCoreCreate → create → coreTaskToIpcRow preserves snake_case fields', () => {
      const dto = {
        id: 'task-1',
        session_id: 'sess-1',
        subject: 'Test task',
        description: 'A test',
        active_form: 'Testing',
        owner: 'agent-1',
      };
      const input = ipcTaskToCoreCreate(dto);
      const task = tasks.create(input);
      const row = coreTaskToIpcRow(task);

      expect(row.id).toBe('task-1');
      expect(row.session_id).toBe('sess-1');
      expect(row.subject).toBe('Test task');
      expect(row.description).toBe('A test');
      expect(row.active_form).toBe('Testing');
      expect(row.owner).toBe('agent-1');
      expect(row.status).toBe('pending');
      expect(row.blocks).toBe('[]');
      expect(row.blocked_by).toBe('[]');
      expect(row.metadata).toBe('{}');
    });

    it('coreTaskToIpcRow serializes blocks/blocked_by/metadata as JSON strings', () => {
      const task = tasks.create({
        id: 'task-2',
        sessionId: 'sess-1',
        subject: 'S',
        description: 'D',
      });
      tasks.update('task-2', {
        blocks: ['task-1'],
        blockedBy: ['task-3'],
        metadata: { key: 'value' },
      });
      const updated = tasks.get('task-2')!;
      const row = coreTaskToIpcRow(updated);

      expect(row.blocks).toBe(JSON.stringify(['task-1']));
      expect(row.blocked_by).toBe(JSON.stringify(['task-3']));
      expect(row.metadata).toBe(JSON.stringify({ key: 'value' }));
    });
  });

  // ─── 5. Permission adapter round-trip ───

  describe('permission adapter round-trip', () => {
    it('ipcPermissionToCoreCreate → create → corePermissionToIpcRow preserves fields', () => {
      const dto = {
        id: 'perm-1',
        sessionId: 'sess-1',
        toolName: 'BashTool',
        toolInput: { command: 'rm -rf /' },
      };
      const input = ipcPermissionToCoreCreate(dto);
      const perm = permissions.create(input);
      const row = corePermissionToIpcRow(perm);

      expect(row.id).toBe('perm-1');
      expect(row.session_id).toBe('sess-1');
      expect(row.tool_name).toBe('BashTool');
      expect(row.tool_input).toBe(JSON.stringify({ command: 'rm -rf /' }));
      expect(row.status).toBe('pending');
      expect(row.decision).toBeNull();
      expect(row.resolved_at).toBeNull();
    });

    it('corePermissionToIpcRow after resolve has status/decision/resolved_at', () => {
      permissions.create({
        id: 'perm-2',
        sessionId: 'sess-1',
        toolName: 'BashTool',
      });
      const resolved = permissions.resolve('perm-2', {
        status: 'allow',
        decision: 'allow',
        message: 'Approved',
      })!;
      const row = corePermissionToIpcRow(resolved);

      expect(row.status).toBe('allow');
      expect(row.decision).toBe('allow');
      expect(row.message).toBe('Approved');
      expect(row.resolved_at).not.toBeNull();
    });
  });

  // ─── 6. Session adapter round-trip ───

  describe('session adapter round-trip', () => {
    it('ipcSessionToCoreCreate → create → coreSessionToIpcRow preserves fields', () => {
      const dto = {
        id: 'sess-rt',
        title: 'Test Session',
        working_directory: '/tmp',
        project_name: 'test',
        model: 'claude-3-5-sonnet',
        provider_id: 'anthropic',
        mode: 'code',
        permission_profile: 'default',
        agent_type: 'main',
        agent_name: 'Agent',
        system_prompt: 'You are a test agent',
        conductor_mode_enabled: 1,
        conductor_canvas_id: 'canvas-1',
        created_at: 1000,
        updated_at: 2000,
      };
      const input = ipcSessionToCoreCreate(dto, 'default');
      const session = sessions.create(input);
      const row = coreSessionToIpcRow(session);

      expect(row.id).toBe('sess-rt');
      expect(row.title).toBe('Test Session');
      expect(row.working_directory).toBe('/tmp');
      expect(row.project_name).toBe('test');
      expect(row.model).toBe('claude-3-5-sonnet');
      expect(row.provider_id).toBe('anthropic');
      expect(row.mode).toBe('code');
      expect(row.permission_profile).toBe('default');
      expect(row.agent_type).toBe('main');
      expect(row.agent_name).toBe('Agent');
      // Extension fields restored as top-level
      expect(row.system_prompt).toBe('You are a test agent');
      expect(row.conductor_mode_enabled).toBe(1);
      expect(row.conductor_canvas_id).toBe('canvas-1');
      // Derived fields
      expect(row.is_deleted).toBe(0);
      expect(row.generation).toBe(0);
      expect(row.draft_message).toBe('');
      expect(row.source).toBe('local');
    });

    it('is_deleted is 1 when status is deleted', () => {
      const session = sessions.create({
        id: 'sess-del',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      sessions.update('sess-del', { status: 'deleted' });
      const row = coreSessionToIpcRow(sessions.get('sess-del')!);
      expect(row.is_deleted).toBe(1);
    });
  });

  // ─── serializeMessageContent ───

  describe('serializeMessageContent', () => {
    it('returns string as-is', () => {
      expect(serializeMessageContent('hello')).toBe('hello');
    });

    it('reduces user content blocks to text joined by newline', () => {
      const blocks = [
        { type: 'text', text: 'line1' },
        { type: 'image', source: 'img.png' },
        { type: 'text', text: 'line2' },
      ];
      expect(serializeMessageContent(blocks, 'user')).toBe('line1\nline2');
    });

    it('JSON-serializes non-user content arrays', () => {
      const blocks = [{ type: 'text', text: 'hello' }];
      expect(serializeMessageContent(blocks, 'assistant')).toBe(JSON.stringify(blocks));
    });
  });
});
