import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentMessage } from '@duya/agent/message';
import { CoreDatabase, type SqliteDatabase, type SqliteCtor } from '../database';
import { MessageLog } from '../message-log';
import { SessionStore } from '../session-store';
import { Mailbox } from '../mailbox';
import { TaskStore, PermissionLedger, LockStore } from '../stores';
import {
  LegacyImport,
  readLegacyRows,
  legacyRowToNewEvent,
  sortSessionMessages,
  type LegacyMessageRow,
  type LegacyRows,
} from '../legacy-import';
import type { CoreStores } from '../../core-connection';

// ─── Core store helpers (replicate the init sequence in core-connection.ts) ───

const ALL_MIGRATIONS = [
  ...MessageLog.migrations,
  ...SessionStore.migrations,
  ...Mailbox.migrations,
  ...TaskStore.migrations,
  ...PermissionLedger.migrations,
  ...LockStore.migrations,
].sort((a, b) => a.id - b.id);

function makeCoreStores(dbPath: string, rootDir: string): CoreStores {
  const coreDb = new CoreDatabase({ filename: dbPath, sqlite: Database as unknown as SqliteCtor, migrations: ALL_MIGRATIONS });
  const db = coreDb.db;
  return {
    coreDb,
    messageLog: new MessageLog(db, rootDir),
    sessions: new SessionStore(db),
    mailbox: new Mailbox(db),
    tasks: new TaskStore(db),
    permissions: new PermissionLedger(db),
    locks: new LockStore(db),
  };
}

// ─── Legacy fixture ───

function createLegacyFixture(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Chat',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      working_directory TEXT NOT NULL DEFAULT '',
      project_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      mode TEXT NOT NULL DEFAULT 'code',
      permission_profile TEXT NOT NULL DEFAULT 'default',
      provider_id TEXT NOT NULL DEFAULT 'env',
      context_summary TEXT,
      context_summary_updated_at INTEGER,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      generation INTEGER NOT NULL DEFAULT 1,
      agent_profile_id TEXT,
      parent_id TEXT,
      agent_type TEXT NOT NULL DEFAULT 'main',
      agent_name TEXT NOT NULL DEFAULT '',
      conductor_mode_enabled INTEGER NOT NULL DEFAULT 0,
      conductor_canvas_id TEXT
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      display_content TEXT,
      name TEXT,
      tool_call_id TEXT,
      token_usage TEXT,
      msg_type TEXT NOT NULL DEFAULT '',
      thinking TEXT,
      tool_name TEXT,
      tool_input TEXT,
      parent_tool_call_id TEXT,
      viz_spec TEXT,
      status TEXT,
      seq_index INTEGER,
      duration_ms INTEGER,
      sub_agent_id TEXT,
      created_at INTEGER NOT NULL,
      provider_state TEXT,
      thinking_signature TEXT,
      tool_signature TEXT,
      text_signature TEXT
    );

    CREATE TABLE agent_mailbox (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      submitted_during_run_id TEXT NOT NULL,
      content TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 100,
      constraints_json TEXT,
      attachments_json TEXT,
      source TEXT NOT NULL DEFAULT 'ui',
      client_msg_id TEXT,
      created_at INTEGER NOT NULL,
      claim_token TEXT,
      claim_expires_at INTEGER,
      observed_at INTEGER,
      observed_at_checkpoint TEXT,
      observed_by_run_id TEXT,
      claim_attempts INTEGER NOT NULL DEFAULT 0,
      last_claim_error TEXT,
      edit_locked_at INTEGER,
      apply_mode TEXT,
      applied_at INTEGER,
      applied_at_checkpoint TEXT,
      applied_summary TEXT,
      resulting_user_msg_id TEXT,
      failure_reason TEXT,
      edit_history_json TEXT,
      cancelled_at INTEGER,
      cancelled_by TEXT,
      cancel_reason TEXT
    );

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      active_form TEXT,
      owner TEXT,
      blocks TEXT NOT NULL DEFAULT '[]',
      blocked_by TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE permission_requests (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      tool_name TEXT NOT NULL,
      tool_input TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      decision TEXT,
      message TEXT,
      updated_permissions TEXT,
      updated_input TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );

    CREATE TABLE session_runtime_locks (
      session_id TEXT PRIMARY KEY,
      lock_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
}

function insertSessionsFixture(db: SqliteDatabase): void {
  const ins = db.prepare(
    `INSERT INTO chat_sessions (
      id, title, created_at, updated_at, model, system_prompt, working_directory,
      project_name, status, mode, permission_profile, provider_id, context_summary,
      context_summary_updated_at, is_deleted, generation, agent_profile_id, parent_id,
      agent_type, agent_name, conductor_mode_enabled, conductor_canvas_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  ins.run('s1', 'S1', 100, 300, 'claude', '', '/wd1', 'p1', 'active', 'code', 'default', 'anthropic', null, null, 0, 1, null, null, 'main', '', 0, null);
  ins.run('s2', 'S2', 200, 400, 'gpt', '', '', '', 'active', 'research', 'bypass', 'openai', null, null, 0, 2, null, null, 'main', '', 0, null);
  ins.run('s3', 'S3', 300, 500, '', '', '', '', 'active', 'code', 'default', 'env', null, null, 1, 1, null, null, 'main', '', 0, null);
  ins.run('s4', 'S4', 400, 600, 'claude', 'be nice', '', '', 'active', 'code', 'default', 'anthropic', 'summary-text', 610, 0, 1, 'agent-a', 'parent-x', 'main', 'helper', 1, 'canvas-1');
}

function insertMessagesFixture(db: SqliteDatabase): void {
  const ins = db.prepare(
    `INSERT INTO messages (
      id, session_id, role, content, display_content, name, tool_call_id, token_usage,
      msg_type, thinking, tool_name, tool_input, parent_tool_call_id, viz_spec, status,
      seq_index, duration_ms, sub_agent_id, created_at, provider_state,
      thinking_signature, tool_signature, text_signature
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // s1 — complete seq_index (0..3), no renumber.
  ins.run('m1', 's1', 'user', 'hello', null, null, null, null, 'user', null, null, null, null, null, null, 0, null, null, 100, null, null, null, null);
  ins.run('m2', 's1', 'assistant', '[{"type":"text","text":"hi there"}]', null, null, null, '{"input_tokens":10,"output_tokens":5}', 'text', null, null, null, null, null, 'completed', 1, 50, null, 110, null, null, null, 'sig-1');
  ins.run('m3', 's1', 'assistant', '[{"type":"tool_use","id":"tool-1","name":"bash","input":{"cmd":"ls"}}]', null, null, null, null, 'tool_use', null, 'bash', '{"cmd":"ls"}', null, null, null, 2, null, null, 120, null, null, 'sig-2', null);
  ins.run('m4', 's1', 'tool', '{"exit_code":0}', null, null, 'tool-1', null, 'tool_result', null, null, null, 'tool-1', null, 'completed', 3, 10, null, 130, null, null, null, null);

  // s2 — seq_index all NULL → renumbered by created_at,id. m7 has the earliest created_at.
  ins.run('m5', 's2', 'user', 'a', null, null, null, null, 'user', null, null, null, null, null, null, null, null, null, 200, null, null, null, null);
  ins.run('m6', 's2', 'assistant', '[{"type":"text","text":"B"}]', null, null, null, null, 'text', null, null, null, null, null, null, null, null, null, 210, null, null, null, null);
  ins.run('m7', 's2', 'assistant', '[{"type":"text","text":"Ctrl"}]', null, null, null, null, 'text', null, null, null, null, null, null, null, null, null, 150, null, null, null, null);

  // s3 — deleted session, one user message.
  ins.run('m8', 's3', 'user', 'deleted', null, null, null, null, 'user', null, null, null, null, null, null, 0, null, null, 300, null, null, null, null);

  // s4 — thinking (with thinking_signature) + text (with text_signature) + provider_state.
  ins.run('m9', 's4', 'assistant', 'thinking', null, null, null, null, 'thinking', 'Let me think', null, null, null, null, null, 0, null, null, 400, '{"api":"anthropic","providerId":"anthropic","model":"claude"}', 'sig-t', null, null);
  ins.run('m10', 's4', 'assistant', '[{"type":"text","text":"answer"}]', null, null, null, null, 'text', null, null, null, null, null, null, 1, null, null, 410, null, null, null, 'sig-tx');
}

function insertMailboxFixture(db: SqliteDatabase): void {
  const ins = db.prepare(
    `INSERT INTO agent_mailbox (
      id, session_id, submitted_during_run_id, content, kind, status, priority,
      constraints_json, attachments_json, source, client_msg_id, created_at,
      claim_token, claim_expires_at, observed_at, observed_at_checkpoint,
      observed_by_run_id, claim_attempts, last_claim_error, edit_locked_at,
      apply_mode, applied_at, applied_at_checkpoint, applied_summary,
      resulting_user_msg_id, failure_reason, edit_history_json, cancelled_at,
      cancelled_by, cancel_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Column order: id, session_id, submitted_during_run_id, content, kind, status,
  // priority, constraints_json, attachments_json, source, client_msg_id, created_at,
  // claim_token, claim_expires_at, observed_at, observed_at_checkpoint,
  // observed_by_run_id, claim_attempts, last_claim_error, edit_locked_at, apply_mode,
  // applied_at, applied_at_checkpoint, applied_summary, resulting_user_msg_id,
  // failure_reason, edit_history_json, cancelled_at, cancelled_by, cancel_reason.
  // three kinds: queued / followup / background_notification.
  ins.run(
    'mb1', 's1', 'run-1', 'queued body', 'queued', 'pending', 100,
    '{"mode":"x"}', null, 'ui', 'cm-1', 1000,
    null, null, null, null, null, 0, null, null, null, null, null, null, null, null,
    '[{"editedAt":1,"prevContent":"old"}]', null, null, null,
  );
  ins.run(
    'mb2', 's1', 'run-2', 'followup body', 'followup', 'applied', 10,
    null, null, 'agent', null, 1100,
    null, null, null, null, null, 0, null, null, 'runtime_instruction', 1200,
    'before_model_turn', 'ok', 'result-1', 'failed once', null, null, null, null,
  );
  ins.run(
    'mb3', 's2', 'run-3', 'notif body', 'background_notification', 'observed', 50,
    null, null, 'system', null, 1200,
    'tok-1', 9000, 1300, 'before_final_answer', 'run-3', 1, null, 1300, null, null,
    null, null, null, null, null, null, null, 'agent',
  );
}

function insertTasksPermissionsLocksFixture(db: SqliteDatabase): void {
  db.prepare(
    `INSERT INTO tasks (id, session_id, subject, description, status, active_form, owner, blocks, blocked_by, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('t1', 's1', 'subject', 'desc', 'pending', null, null, '[]', '[]', '{}', 1000, 1000);
  db.prepare(
    `INSERT INTO permission_requests (id, session_id, tool_name, tool_input, status, decision, message, updated_permissions, updated_input, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('p1', 's1', 'bash', '{"cmd":"ls"}', 'pending', null, null, null, null, 1000, null);
  db.prepare(
    `INSERT INTO session_runtime_locks (session_id, lock_id, owner, expires_at)
     VALUES (?, ?, ?, ?)`,
  ).run('s1', 'lock-1', 'owner-1', 9999);
}

function buildLegacyFixture(db: SqliteDatabase): void {
  createLegacyFixture(db);
  insertSessionsFixture(db);
  insertMessagesFixture(db);
  insertMailboxFixture(db);
  insertTasksPermissionsLocksFixture(db);
}

// ─── Test harness ───

// Module-level mutable harness state (shared by the describe block and the
// module-scope helpers below so `collectFileLines` can reach the rollout root).
let tempDir: string;
let rootDir: string;
let legacyPath: string;
let corePath: string;
let stores: CoreStores;
let importer: LegacyImport;
/** Canonical legacy rows, captured once per fixture build. */
let legacyRows: LegacyRows;

describe('LegacyImport', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-legacy-import-'));
    rootDir = path.join(tempDir, 'rollout');
    fs.mkdirSync(rootDir, { recursive: true });
    legacyPath = path.join(tempDir, 'duya-main.db');
    corePath = path.join(tempDir, 'duya-core.db');

    const legacyDb = new Database(legacyPath) as unknown as SqliteDatabase;
    buildLegacyFixture(legacyDb);
    legacyRows = readLegacyRows(legacyDb);
    legacyDb.close();

    stores = makeCoreStores(corePath, rootDir);
    importer = new LegacyImport(stores, legacyPath, Database as unknown as SqliteCtor);
  });

  afterEach(() => {
    try {
      stores.coreDb.close();
    } catch {
      /* already closed */
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('needsImport is true before import and false after', () => {
    expect(importer.needsImport()).toBe(true);
    importer.run();
    expect(importer.needsImport()).toBe(false);
  });

  it('imports all six aggregates with correct counts and meta marker', () => {
    const report = importer.run();
    expect(report.sessions).toBe(4);
    expect(report.events).toBe(10);
    expect(report.mailboxItems).toBe(3);
    expect(report.tasks).toBe(1);
    expect(report.permissions).toBe(1);
    expect(report.locks).toBe(1);
    expect(report.renumberedSessions).toEqual(['s2']);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);

    const marker = stores.coreDb.db
      .prepare("SELECT value FROM meta WHERE key = 'imported_from_legacy'")
      .get() as { value: string } | undefined;
    expect(marker).toBeDefined();
    expect(marker!.value.startsWith('v46@')).toBe(true);
  });

  it('maps session fields: extensions, deleted status, permission_mode, parent', () => {
    importer.run();

    const s1 = stores.sessions.get('s1')!;
    expect(s1.status).toBe('active');
    expect(s1.permissionMode).toBe('default');
    expect(s1.rolloutPath).toBeTruthy();

    const s3 = stores.sessions.get('s3')!;
    expect(s3.status).toBe('deleted');

    const s4 = stores.sessions.get('s4')!;
    expect(s4.extensions.system_prompt).toBe('be nice');
    expect(s4.extensions.conductor_mode_enabled).toBe(1);
    expect(s4.extensions.conductor_canvas_id).toBe('canvas-1');
    expect(s4.extensions.legacy_context_summary).toBe('summary-text');
    expect(s4.parentSessionId).toBe('parent-x');
    expect(s4.agentProfileId).toBe('agent-a');
  });

  it('maps mailbox rows: column renames + meta merge + failure_reason->cancel_reason', () => {
    importer.run();

    const mb1 = stores.mailbox.get('mb1')!;
    expect(mb1.kind).toBe('queued');
    expect(mb1.status).toBe('pending');
    expect(mb1.submittedRunId).toBe('run-1');
    expect(mb1.meta.constraints).toEqual({ mode: 'x' });
    expect(mb1.meta.editHistory).toEqual([{ editedAt: 1, prevContent: 'old' }]);

    const mb2 = stores.mailbox.get('mb2')!;
    expect(mb2.status).toBe('applied');
    expect(mb2.resultingEventId).toBe('result-1');
    expect(mb2.applyMode).toBe('runtime_instruction');
    // failure_reason collapses into cancel_reason when cancel_reason is null.
    expect(mb2.cancelReason).toBe('failed once');

    const mb3 = stores.mailbox.get('mb3')!;
    expect(mb3.kind).toBe('background_notification');
    expect(mb3.status).toBe('observed');
    expect(mb3.claimToken).toBe('tok-1');
  });

  it('round-trips message payloads: kind mapping + signature/provider_state rehydration', () => {
    importer.run();
    const projected = stores.messageLog.project('s1');
    expect(projected).toHaveLength(4);

    // user
    expect(projected[0].entry.message.role).toBe('user');
    expect(projected[0].entry.message.id).toBe('m1');
    // assistant text with text_signature rehydrated
    const m2 = projected[1].entry.message as AgentMessage;
    expect(m2.role).toBe('assistant');
    expect(m2.id).toBe('m2');
    expect(m2.content).toEqual([{ type: 'text', text: 'hi there', textSignature: 'sig-1' }]);
    expect((m2 as unknown as { tokenUsage: unknown }).tokenUsage).toEqual({ input_tokens: 10, output_tokens: 5 });
    // tool_use with thoughtSignature rehydrated
    const m3 = projected[2].entry.message as AgentMessage;
    expect(m3.role).toBe('assistant');
    expect(m3.content).toEqual([
      { type: 'tool_use', id: 'tool-1', name: 'bash', input: { cmd: 'ls' }, thoughtSignature: 'sig-2' },
    ]);
    // tool_result
    const m4 = projected[3].entry.message as AgentMessage;
    expect(m4.role).toBe('tool');
    expect(m4.tool_call_id).toBe('tool-1');
  });

  it('rehydrates thinking_signature and provider_state into content blocks', () => {
    importer.run();
    const projected = stores.messageLog.project('s4');
    expect(projected).toHaveLength(2);

    const m9 = projected[0].entry.message as AgentMessage;
    expect(m9.role).toBe('assistant');
    expect(m9.content).toEqual([{ type: 'thinking', thinking: 'Let me think', thinkingSignature: 'sig-t' }]);
    expect((m9 as unknown as { providerId: string }).providerId).toBe('anthropic');
    expect((m9 as unknown as { model: string }).model).toBe('claude');

    const m10 = projected[1].entry.message as AgentMessage;
    expect((m10 as AgentMessage).content).toEqual([{ type: 'text', text: 'answer', textSignature: 'sig-tx' }]);
  });

  it('renumbers s2 by created_at,id (pure function determinism)', () => {
    const rows = legacyRows.messages.filter((r) => r.session_id === 's2');
    const { sorted, renumbered } = sortSessionMessages(rows);
    expect(renumbered).toBe(true);
    expect(sorted.map((r) => r.id)).toEqual(['m7', 'm5', 'm6']);
  });

  it('rollout file line count == message_index count == legacy messages count per session', () => {
    importer.run();
    const legacy = legacyRows.messages;
    const bySession = new Map<string, number>();
    for (const r of legacy) bySession.set(r.session_id, (bySession.get(r.session_id) ?? 0) + 1);

    for (const [sessionId, expected] of bySession) {
      expect(stores.messageLog.getCount(sessionId)).toBe(expected);
      const pathP = stores.sessions.getRolloutPath(sessionId)!;
      const abs = path.join(rootDir, pathP);
      const lines = fs.readFileSync(abs, 'utf8').split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(expected);
    }
  });

  it('is idempotent: re-run run() does not change counts or file lines', () => {
    const first = importer.run();
    const before = collectFileLines();
    const second = importer.run();

    expect(second.sessions).toBe(first.sessions);
    expect(second.events).toBe(0); // nothing new to import
    expect(second.mailboxItems).toBe(first.mailboxItems);
    expect(second.tasks).toBe(first.tasks);
    expect(second.permissions).toBe(first.permissions);
    expect(second.locks).toBe(first.locks);
    expect(collectFileLines()).toEqual(before);
  });

  it('resumes after an interrupted run: file written but index missing', () => {
    // 1) Simulate a crash between file-append and index-write: pre-create the
    //    session with a rollout_path already pointing at an orphan-only file.
    //    (importMetadata's INSERT OR IGNORE then skips the existing session,
    //    preserving the rollout_path so scan() finds the file.)
    stores.sessions.create({ id: 's1', title: 'S1', rolloutPath: 'session-s1-seeded.jsonl' });

    const s1Rel = path.join(rootDir, 'session-s1-seeded.jsonl');
    const orphan = legacyRowToNewEvent(legacyRows.messages.find((r) => r.id === 'm1')!);
    fs.appendFileSync(s1Rel, JSON.stringify(orphan.payload) + '\n', 'utf8');

    // m1 is now an orphan line with no index row.
    expect(stores.messageLog.getCount('s1')).toBe(0);

    // 2) Run import. scan() should reconcile the orphan into the index, then
    //    the resumable breakpoint (getCount) skips m1 and imports only m2..m4.
    const report = importer.run();

    // m1 indexed once by scan, m2-m4 appended: total 4, no duplicates.
    expect(stores.messageLog.getCount('s1')).toBe(4);
    const ids = stores.messageLog.project('s1').map((r) => r.entry.id);
    expect(ids).toEqual(['m1', 'm2', 'm3', 'm4']);
    // Only m2..m4 appended for s1 (3), plus s2(3) + s3(1) + s4(2) = 9 total.
    expect(report.events).toBe(9);
  });

  it('does not throw when a legacy table is missing (older legacy DB)', () => {
    // beforeEach already built a full fixture at legacyPath — replace it with a
    // minimal DB containing only chat_sessions (older legacy version).
    fs.rmSync(legacyPath, { force: true });
    const legacyDb = new Database(legacyPath) as unknown as SqliteDatabase;
    legacyDb.exec(`CREATE TABLE chat_sessions (id TEXT PRIMARY KEY)`);
    legacyDb.close();

    expect(() => importer.run()).not.toThrow();
    const report = importer.run();
    expect(report.sessions).toBe(0);
    expect(report.events).toBe(0);
  });

  it('writes a none@ marker when the legacy file does not exist', () => {
    fs.rmSync(legacyPath, { force: true });
    const imp = new LegacyImport(stores, legacyPath, Database as unknown as SqliteCtor);
    const report = imp.run();
    expect(report.sessions).toBe(0);
    const marker = stores.coreDb.db
      .prepare("SELECT value FROM meta WHERE key = 'imported_from_legacy'")
      .get() as { value: string } | undefined;
    expect(marker!.value.startsWith('none@')).toBe(true);
    // needsImport flips to false so startup stops probing.
    expect(imp.needsImport()).toBe(false);
  });

  it('projection equivalence: legacy read path == MessageLog.project for every session', () => {
    importer.run();
    const legacy = legacyRows.messages;
    const bySession = new Map<string, LegacyMessageRow[]>();
    for (const r of legacy) {
      const arr = bySession.get(r.session_id);
      if (arr) arr.push(r);
      else bySession.set(r.session_id, [r]);
    }

    for (const [sessionId, rows] of bySession) {
      const { sorted } = sortSessionMessages(rows);
      const expected = sorted.map((row) => legacyRowToNewEvent(row));
      const projected = stores.messageLog.project(sessionId);
      expect(projected).toHaveLength(expected.length);
      for (let i = 0; i < expected.length; i++) {
        const exp = expected[i].payload as { message: { id: string; role: string; content: unknown; tool_call_id?: string } };
        const got = projected[i].entry as { message: { id: string; role: string; content: unknown; tool_call_id?: string } };
        expect(got.message.id).toBe(exp.message.id);
        expect(got.message.role).toBe(exp.message.role);
        expect(got.message.content).toEqual(exp.message.content);
        expect(got.message.tool_call_id).toBe(exp.message.tool_call_id);
      }
    }
  });
});

// ─── Module-scope helper: walk the rollout dir and count JSONL lines ───

function collectFileLines(): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith('.jsonl')) {
        const lines = fs.readFileSync(abs, 'utf8').split('\n').filter((l) => l.length > 0);
        out[abs] = lines.length;
      }
    }
  };
  walk(rootDir);
  return out;
}