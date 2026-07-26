import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrations';
import { syncAllFromMainDb, syncSessionFromMainDb, markSourceMissing } from '../catalogSync';
import { createTempDbDir, type TempDbDir } from './fixture';

// Stub the Phase B project resolver. The real resolver is owned by
// Phase B; here we only need deterministic project_id assignment so
// we can verify scope_kind/project_id behavior. The mock records calls
// so tests can assert provenance metadata was passed through.
//
// The mock ALSO inserts a `projects` row (INSERT OR IGNORE) so the
// rollout_catalog FK constraint is satisfied. The real Phase B
// resolver is responsible for project registration; the mock mirrors
// that contract so catalogSync tests stay isolated.
interface ResolverCall {
  workingDirectory: string;
  agent_profile_id?: string;
  cwd?: string;
  workspaceOverridesPath?: string;
}

interface ResolverInput extends ResolverCall {
  memoryDb?: Database.Database;
}

interface ResolverResult {
  project_id: string;
  canonical_root: string;
  resolution_source: 'override' | 'working_directory' | 'cwd';
  alias_kind: 'workspace_override' | 'working_directory' | 'cwd';
  absolute_normalized_path: string;
}

const PROJECT_IDS: Record<string, string> = {
  'D:/projects/alpha': 'proj-alpha-uuid',
  'D:/projects/beta': 'proj-beta-uuid',
};

// vi.mock is hoisted; the factory runs before any import. We capture
// calls into the `resolverCalls` array via vi.hoisted so the factory
// and test bodies share one list.
const hoisted = vi.hoisted(() => ({
  resolver: vi.fn((input: ResolverInput): ResolverResult => {
    const normalized = input.workingDirectory.replace(/\\/g, '/').replace(/\/$/, '');
    const projectId = PROJECT_IDS[normalized] ?? `proj-${normalized.replace(/[^a-z0-9]/gi, '-')}`;
    // Insert the projects row so the rollout_catalog FK is satisfied.
    // INSERT OR IGNORE keeps this idempotent across re-syncs.
    if (input.memoryDb) {
      const now = Date.now();
      input.memoryDb
        .prepare(
          'INSERT OR IGNORE INTO projects (project_id, canonical_root, created_at, last_seen_at) VALUES (?, ?, ?, ?)'
        )
        .run(projectId, normalized, now, now);
    }
    return {
      project_id: projectId,
      canonical_root: normalized,
      resolution_source: 'working_directory',
      alias_kind: 'working_directory',
      absolute_normalized_path: normalized,
    };
  }),
}));

// `resolverCalls` is captured by the mock factory closure. The factory
// is hoisted above this `const`, but `resolveProject` is only called at
// test time (after module load), so the binding is initialized by then.
// `beforeEach` resets it via `.length = 0`.
const resolverCalls: ResolverCall[] = [];

vi.mock('../projectResolver', () => ({
  resolveProject: (input: ResolverInput): ResolverResult => {
    resolverCalls.push({
      workingDirectory: input.workingDirectory,
      agent_profile_id: input.agent_profile_id,
      cwd: input.cwd,
      workspaceOverridesPath: input.workspaceOverridesPath,
    });
    return hoisted.resolver(input);
  },
}));

// Shared mock logger — must be hoisted so vi.mock (also hoisted) sees it.
const mocks = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => mocks.logger,
  LogComponent: {
    DB: 'DB',
    DBMigration: 'DBMigration',
  },
}));

/**
 * Create the main DB (duya-main.db shape) with chat_sessions + messages.
 * Mirrors electron/db/schema.ts.
 */
function createMainDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
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
      context_summary TEXT NOT NULL DEFAULT '',
      context_summary_updated_at INTEGER NOT NULL DEFAULT 0,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      generation INTEGER NOT NULL DEFAULT 0,
      agent_profile_id TEXT DEFAULT NULL,
      parent_id TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
      agent_type TEXT NOT NULL DEFAULT 'main',
      agent_name TEXT NOT NULL DEFAULT '',
      conductor_mode_enabled INTEGER NOT NULL DEFAULT 0,
      conductor_canvas_id TEXT DEFAULT NULL
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
      msg_type TEXT NOT NULL DEFAULT 'text',
      thinking TEXT,
      tool_name TEXT,
      tool_input TEXT,
      parent_tool_call_id TEXT,
      viz_spec TEXT,
      status TEXT NOT NULL DEFAULT 'done',
      seq_index INTEGER,
      duration_ms INTEGER,
      sub_agent_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );
  `);
  return db;
}

/**
 * Create the memory DB with the Phase A schema (migration 0001).
 */
function createMemoryDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  runMigrations(db);
  return db;
}

interface InsertSessionOpts {
  id: string;
  title?: string;
  created_at?: number;
  updated_at?: number;
  working_directory?: string;
  status?: string;
  mode?: string;
  is_deleted?: number;
  agent_profile_id?: string | null;
  parent_id?: string | null;
  agent_type?: string;
  permission_profile?: string;
}

function insertSession(db: Database.Database, opts: InsertSessionOpts): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO chat_sessions (id, title, created_at, updated_at, working_directory,
                                 status, mode, is_deleted, agent_profile_id, parent_id,
                                 agent_type, permission_profile)
     VALUES (@id, @title, @created_at, @updated_at, @working_directory,
             @status, @mode, @is_deleted, @agent_profile_id, @parent_id,
             @agent_type, @permission_profile)`
  ).run({
    id: opts.id,
    title: opts.title ?? 'Test',
    created_at: opts.created_at ?? now,
    updated_at: opts.updated_at ?? now,
    working_directory: opts.working_directory ?? '',
    status: opts.status ?? 'active',
    mode: opts.mode ?? 'code',
    is_deleted: opts.is_deleted ?? 0,
    agent_profile_id: opts.agent_profile_id ?? null,
    parent_id: opts.parent_id ?? null,
    agent_type: opts.agent_type ?? 'main',
    permission_profile: opts.permission_profile ?? 'default',
  });
}

interface InsertMessageOpts {
  id: string;
  session_id: string;
  role?: string;
  content?: string;
  msg_type?: string;
  thinking?: string | null;
  status?: string;
  seq_index?: number | null;
  created_at?: number;
}

function insertMessage(db: Database.Database, opts: InsertMessageOpts): void {
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, msg_type, thinking, status,
                           seq_index, created_at)
     VALUES (@id, @session_id, @role, @content, @msg_type, @thinking, @status,
             @seq_index, @created_at)`
  ).run({
    id: opts.id,
    session_id: opts.session_id,
    role: opts.role ?? 'user',
    content: opts.content ?? '',
    msg_type: opts.msg_type ?? 'text',
    thinking: opts.thinking ?? null,
    status: opts.status ?? 'done',
    seq_index: opts.seq_index ?? null,
    created_at: opts.created_at ?? Date.now(),
  });
}

function getRollout(db: Database.Database, rolloutId: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM rollout_catalog WHERE rollout_id = ?').get(rolloutId) as
    | Record<string, unknown>
    | undefined;
}

describe('memory-state catalogSync', () => {
  let temp: TempDbDir;
  let mainDb: Database.Database;
  let memoryDb: Database.Database;

  beforeEach(() => {
    temp = createTempDbDir();
    mainDb = createMainDb(`${temp.dir}/main.db`);
    memoryDb = createMemoryDb(`${temp.dir}/memory.db`);
    resolverCalls.length = 0;
    mocks.logger.info.mockClear();
    mocks.logger.warn.mockClear();
    mocks.logger.error.mockClear();
  });

  afterEach(() => {
    memoryDb.close();
    mainDb.close();
    temp.cleanup();
  });

  it('1. empty main DB, empty memory DB → sync returns all-zero metrics', () => {
    const result = syncAllFromMainDb({ mainDb, memoryDb });
    expect(result).toEqual({
      inserted: 0,
      updated: 0,
      tombstoned: 0,
      errors: 0,
      durationMs: expect.any(Number) as number,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('2. one new session in main DB → inserted into memory DB', () => {
    insertSession(mainDb, {
      id: 'sess-1',
      working_directory: 'D:/projects/alpha',
      created_at: 1000,
      updated_at: 2000,
    });
    insertMessage(mainDb, {
      id: 'msg-1',
      session_id: 'sess-1',
      content: 'hello',
      created_at: 1500,
    });

    const result = syncAllFromMainDb({ mainDb, memoryDb });
    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(0);

    const rollout = getRollout(memoryDb, 'sess-1');
    expect(rollout).toBeDefined();
    expect(rollout?.['scope_kind']).toBe('project');
    expect(rollout?.['project_id']).toBe('proj-alpha-uuid');
    expect(rollout?.['agent_type']).toBe('main');
    expect(rollout?.['mode']).toBe('code');
    expect(rollout?.['source_status']).toBe('active');
    expect(rollout?.['generation']).toBe(0);
    expect(rollout?.['message_count']).toBe(1);
    expect(rollout?.['last_message_id']).toBe('msg-1');
    expect(rollout?.['last_message_at']).toBe(1500);
    expect(rollout?.['source_fingerprint']).toMatch(/^[0-9a-f]{64}$/);
    expect(rollout?.['first_seen_at']).toBe(rollout?.['last_seen_at']);
  });

  it('3. same session with new message → generation increments; new fingerprint', () => {
    insertSession(mainDb, { id: 'sess-1', working_directory: 'D:/projects/alpha' });
    insertMessage(mainDb, { id: 'msg-1', session_id: 'sess-1', created_at: 1000 });

    syncAllFromMainDb({ mainDb, memoryDb });
    const before = getRollout(memoryDb, 'sess-1');
    const fingerprintBefore = before?.['source_fingerprint'];
    const generationBefore = before?.['generation'];

    // Add a new message → fingerprint must change, generation must bump.
    insertMessage(mainDb, { id: 'msg-2', session_id: 'sess-1', created_at: 2000 });

    const result = syncSessionFromMainDb({ mainDb, memoryDb, sessionId: 'sess-1' });
    expect(result.status).toBe('updated');

    const after = getRollout(memoryDb, 'sess-1');
    expect(after?.['generation']).toBe((generationBefore as number) + 1);
    expect(after?.['source_fingerprint']).not.toBe(fingerprintBefore);
    expect(after?.['message_count']).toBe(2);
    expect(after?.['last_message_id']).toBe('msg-2');
    expect(after?.['last_message_at']).toBe(2000);
    // first_seen_at is preserved on conflict.
    expect(after?.['first_seen_at']).toBe(before?.['first_seen_at']);
  });

  it('4. session is_deleted=1 in main DB → source_status=deleted, source_deleted_at set; NOT row-deleted', () => {
    insertSession(mainDb, { id: 'sess-1', working_directory: 'D:/projects/alpha' });
    insertMessage(mainDb, { id: 'msg-1', session_id: 'sess-1', created_at: 1000 });

    // First sync to materialize the row with source_status='active'.
    syncAllFromMainDb({ mainDb, memoryDb });
    const before = getRollout(memoryDb, 'sess-1');
    expect(before?.['source_status']).toBe('active');
    const fingerprintBefore = before?.['source_fingerprint'];
    const generationBefore = before?.['generation'];
    const firstSeenBefore = before?.['first_seen_at'];

    // Mark the session as deleted.
    mainDb.prepare('UPDATE chat_sessions SET is_deleted = 1 WHERE id = ?').run('sess-1');

    const result = syncSessionFromMainDb({ mainDb, memoryDb, sessionId: 'sess-1' });
    expect(result.status).toBe('tombstoned');

    const after = getRollout(memoryDb, 'sess-1');
    expect(after).toBeDefined(); // Row was NOT deleted.
    expect(after?.['source_status']).toBe('deleted');
    expect(after?.['source_deleted_at']).toBeTypeOf('number');
    expect(after?.['source_deleted_at']).toBeGreaterThan(0);
    // Fingerprint and generation preserved on tombstone.
    expect(after?.['source_fingerprint']).toBe(fingerprintBefore);
    expect(after?.['generation']).toBe(generationBefore);
    expect(after?.['first_seen_at']).toBe(firstSeenBefore);
  });

  it('5. session with parent_id set → agent_type copied VERBATIM from chat_sessions.agent_type (sub-agent)', () => {
    // Parent session first (FK constraint).
    insertSession(mainDb, { id: 'parent-1', working_directory: 'D:/projects/alpha' });
    insertSession(mainDb, {
      id: 'child-1',
      working_directory: 'D:/projects/alpha',
      parent_id: 'parent-1',
      agent_type: 'sub-agent', // live value from SubagentTool.ts:275
    });
    insertMessage(mainDb, { id: 'm-parent', session_id: 'parent-1', created_at: 1000 });
    insertMessage(mainDb, { id: 'm-child', session_id: 'child-1', created_at: 2000 });

    syncAllFromMainDb({ mainDb, memoryDb });

    const child = getRollout(memoryDb, 'child-1');
    // Verbatim copy — NO derivation from parent_id to 'subagent' or similar.
    expect(child?.['agent_type']).toBe('sub-agent');
    expect(child?.['parent_id']).toBe('parent-1');
  });

  it('6. session with mode=automation and default agent_type=main → catalog keeps both verbatim', () => {
    // The live automation persistence writes agent_type='main' with mode='automation'.
    // Sync must copy both verbatim — eligibility filtering is Plan 302's job.
    insertSession(mainDb, {
      id: 'sess-auto',
      working_directory: 'D:/projects/alpha',
      mode: 'automation',
      agent_type: 'main',
    });
    insertMessage(mainDb, { id: 'm1', session_id: 'sess-auto', created_at: 1000 });

    syncAllFromMainDb({ mainDb, memoryDb });

    const rollout = getRollout(memoryDb, 'sess-auto');
    expect(rollout?.['agent_type']).toBe('main');
    expect(rollout?.['mode']).toBe('automation');
    expect(rollout?.['source_status']).toBe('active');
  });

  it('7. working_directory empty in main DB → scope_kind=global, project_id=NULL; no cwd substitution', () => {
    insertSession(mainDb, { id: 'sess-1', working_directory: '' });
    insertMessage(mainDb, { id: 'm1', session_id: 'sess-1', created_at: 1000 });

    // Pass a cwd to verify it is NOT substituted for the empty working_directory.
    syncAllFromMainDb({ mainDb, memoryDb, cwd: 'D:/electron-process-cwd' });

    const rollout = getRollout(memoryDb, 'sess-1');
    expect(rollout?.['scope_kind']).toBe('global');
    expect(rollout?.['project_id']).toBeNull();
    expect(rollout?.['working_directory']).toBeNull();
    expect(rollout?.['working_directory_normalized']).toBeNull();
    // Resolver must NOT have been called for this session.
    expect(resolverCalls.filter((c) => c.cwd === 'D:/electron-process-cwd')).toHaveLength(0);
  });

  it('8. two sessions from different Agent Profiles with same working_directory → same project_id; profile IDs are provenance only', () => {
    insertSession(mainDb, {
      id: 'sess-A',
      working_directory: 'D:/projects/alpha',
      agent_profile_id: 'profile-A',
    });
    insertSession(mainDb, {
      id: 'sess-B',
      working_directory: 'D:/projects/alpha',
      agent_profile_id: 'profile-B',
    });
    insertMessage(mainDb, { id: 'mA1', session_id: 'sess-A', created_at: 1000 });
    insertMessage(mainDb, { id: 'mB1', session_id: 'sess-B', created_at: 2000 });

    syncAllFromMainDb({ mainDb, memoryDb });

    const a = getRollout(memoryDb, 'sess-A');
    const b = getRollout(memoryDb, 'sess-B');
    expect(a?.['project_id']).toBe(b?.['project_id']);
    expect(a?.['project_id']).toBe('proj-alpha-uuid');
    // agent_profile_id preserved as provenance — does not affect scope.
    expect(a?.['agent_profile_id']).toBe('profile-A');
    expect(b?.['agent_profile_id']).toBe('profile-B');
  });

  it('9. two sessions with same valid working_directory → same project_id; two distinct catalog rows', () => {
    insertSession(mainDb, { id: 'sess-1', working_directory: 'D:/projects/alpha' });
    insertSession(mainDb, { id: 'sess-2', working_directory: 'D:/projects/alpha' });
    insertMessage(mainDb, { id: 'm1', session_id: 'sess-1', created_at: 1000 });
    insertMessage(mainDb, { id: 'm2', session_id: 'sess-2', created_at: 2000 });

    syncAllFromMainDb({ mainDb, memoryDb });

    const r1 = getRollout(memoryDb, 'sess-1');
    const r2 = getRollout(memoryDb, 'sess-2');
    expect(r1?.['project_id']).toBe(r2?.['project_id']);
    expect(r1?.['project_id']).toBe('proj-alpha-uuid');
    // Two distinct rows — rollout_id is the PK.
    expect(r1?.['rollout_id']).toBe('sess-1');
    expect(r2?.['rollout_id']).toBe('sess-2');
    const count = memoryDb
      .prepare('SELECT COUNT(*) AS n FROM rollout_catalog WHERE project_id = ?')
      .get('proj-alpha-uuid') as { n: number };
    expect(count.n).toBe(2);
  });

  it('10. global and project sessions coexist → scope CHECK and nullable FK remain valid', () => {
    insertSession(mainDb, { id: 'sess-global', working_directory: '' });
    insertSession(mainDb, { id: 'sess-project', working_directory: 'D:/projects/alpha' });
    insertMessage(mainDb, { id: 'mg', session_id: 'sess-global', created_at: 1000 });
    insertMessage(mainDb, { id: 'mp', session_id: 'sess-project', created_at: 2000 });

    const result = syncAllFromMainDb({ mainDb, memoryDb });
    expect(result.inserted).toBe(2);
    expect(result.errors).toBe(0);

    const g = getRollout(memoryDb, 'sess-global');
    const p = getRollout(memoryDb, 'sess-project');
    expect(g?.['scope_kind']).toBe('global');
    expect(g?.['project_id']).toBeNull();
    expect(p?.['scope_kind']).toBe('project');
    expect(p?.['project_id']).toBe('proj-alpha-uuid');

    // The FK constraint is valid: project_id is NULL for global, non-null for project.
    // (If the CHECK or FK were wrong, the INSERT would have thrown.)
    expect(g).toBeDefined();
    expect(p).toBeDefined();
  });

  it('11. syncSessionFromMainDb re-runs unchanged → returns unchanged, no fingerprint/generation change', () => {
    insertSession(mainDb, { id: 'sess-1', working_directory: 'D:/projects/alpha' });
    insertMessage(mainDb, { id: 'm1', session_id: 'sess-1', created_at: 1000 });

    // First sync materializes the row.
    syncSessionFromMainDb({ mainDb, memoryDb, sessionId: 'sess-1' });
    const before = getRollout(memoryDb, 'sess-1');
    const fingerprintBefore = before?.['source_fingerprint'];
    const generationBefore = before?.['generation'];

    // Re-run with no changes.
    const result = syncSessionFromMainDb({ mainDb, memoryDb, sessionId: 'sess-1' });
    expect(result.status).toBe('unchanged');

    const after = getRollout(memoryDb, 'sess-1');
    expect(after?.['source_fingerprint']).toBe(fingerprintBefore);
    expect(after?.['generation']).toBe(generationBefore);
    // last_seen_at is refreshed (heartbeat), so it should be >= the previous value.
    expect(after?.['last_seen_at'] as number).toBeGreaterThanOrEqual(
      before?.['last_seen_at'] as number
    );
  });

  it('12. syncSessionFromMainDb on a session missing from main DB → tombstones existing rollout', () => {
    // Materialize a row first.
    insertSession(mainDb, { id: 'sess-1', working_directory: 'D:/projects/alpha' });
    insertMessage(mainDb, { id: 'm1', session_id: 'sess-1', created_at: 1000 });
    syncAllFromMainDb({ mainDb, memoryDb });

    // Hard-delete the session from main DB (not just is_deleted=1).
    mainDb.prepare('DELETE FROM chat_sessions WHERE id = ?').run('sess-1');

    const result = syncSessionFromMainDb({ mainDb, memoryDb, sessionId: 'sess-1' });
    expect(result.status).toBe('tombstoned');

    const rollout = getRollout(memoryDb, 'sess-1');
    expect(rollout).toBeDefined(); // Row still exists.
    expect(rollout?.['source_status']).toBe('deleted');
    expect(rollout?.['source_deleted_at']).toBeTypeOf('number');
  });

  it('13. markSourceMissing flips source_status to missing and sets source_missing_at', () => {
    insertSession(mainDb, { id: 'sess-1', working_directory: 'D:/projects/alpha' });
    insertMessage(mainDb, { id: 'm1', session_id: 'sess-1', created_at: 1000 });
    syncAllFromMainDb({ mainDb, memoryDb });

    markSourceMissing({ memoryDb, sessionId: 'sess-1' });

    const rollout = getRollout(memoryDb, 'sess-1');
    expect(rollout?.['source_status']).toBe('missing');
    expect(rollout?.['source_missing_at']).toBeTypeOf('number');
    expect(rollout?.['source_missing_at']).toBeGreaterThan(0);
  });

  it('14. session with status=archived → tombstoned (not row-deleted)', () => {
    insertSession(mainDb, {
      id: 'sess-archived',
      working_directory: 'D:/projects/alpha',
      status: 'archived',
    });
    insertMessage(mainDb, { id: 'm1', session_id: 'sess-archived', created_at: 1000 });

    syncAllFromMainDb({ mainDb, memoryDb });

    const rollout = getRollout(memoryDb, 'sess-archived');
    expect(rollout).toBeDefined();
    expect(rollout?.['source_status']).toBe('deleted');
    expect(rollout?.['source_deleted_at']).toBeTypeOf('number');
  });

  it('15. session with empty messages → fingerprint is sha256 of "[]", generation=0', () => {
    insertSession(mainDb, { id: 'sess-empty', working_directory: 'D:/projects/alpha' });
    // No messages inserted.

    syncAllFromMainDb({ mainDb, memoryDb });

    const rollout = getRollout(memoryDb, 'sess-empty');
    expect(rollout?.['message_count']).toBe(0);
    expect(rollout?.['last_message_id']).toBeNull();
    expect(rollout?.['last_message_at']).toBeNull();
    expect(rollout?.['generation']).toBe(0);
    // sha256("[]") — verify by computing it directly.
    const expected = require('crypto')
      .createHash('sha256')
      .update('[]', 'utf8')
      .digest('hex');
    expect(rollout?.['source_fingerprint']).toBe(expected);
  });
});
