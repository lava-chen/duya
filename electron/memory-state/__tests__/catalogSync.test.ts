import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrations';
import { syncAllFromMainDb, syncSessionFromMainDb, markSourceMissing } from '../catalogSync';
import { SessionStore, MessageLog } from '../../db/core';
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
 * Create the core DB (duya-core.db shape) with the real `sessions` +
 * `message_index` tables and a live SessionStore. Mirrors
 * electron/db/core (plan 328 Phase 5).
 */
function createCoreDb(dbPath: string): { db: Database.Database; sessions: SessionStore } {
  const db = new Database(dbPath);
  for (const m of [...SessionStore.migrations, ...MessageLog.migrations].sort((a, b) => a.id - b.id)) {
    m.up(db);
  }
  return { db, sessions: new SessionStore(db) };
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
  agent_profile_id?: string | null;
  parent_id?: string | null;
  agent_type?: string;
  permission_profile?: string;
}

function insertSession(sessions: SessionStore, opts: InsertSessionOpts): void {
  const now = Date.now();
  sessions.create({
    id: opts.id,
    title: opts.title ?? 'Test',
    workingDirectory: opts.working_directory ?? '',
    status: opts.status ?? 'active',
    mode: opts.mode ?? 'code',
    permissionMode: opts.permission_profile ?? 'default',
    agentProfileId: opts.agent_profile_id ?? null,
    parentSessionId: opts.parent_id ?? null,
    agentType: opts.agent_type ?? 'main',
    createdAt: opts.created_at ?? now,
    updatedAt: opts.updated_at ?? opts.created_at ?? now,
  });
}

interface InsertMessageOpts {
  id: string;
  session_id: string;
  created_at?: number;
}

function insertMessageIndex(db: Database.Database, opts: InsertMessageOpts): void {
  const row = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM message_index WHERE session_id = ?')
    .get(opts.session_id) as { m: number };
  const seq = row.m + 1;
  db.prepare(
    `INSERT INTO message_index (id, session_id, seq, turn_id, kind, created_at, file_offset, byte_len)
     VALUES (?, ?, ?, NULL, 'text', ?, 0, 0)`
  ).run(opts.id, opts.session_id, seq, opts.created_at ?? Date.now());
}

function getRollout(db: Database.Database, rolloutId: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM rollout_catalog WHERE rollout_id = ?').get(rolloutId) as
    | Record<string, unknown>
    | undefined;
}

describe('memory-state catalogSync', () => {
  let temp: TempDbDir;
  let coreDb: Database.Database;
  let sessions: SessionStore;
  let memoryDb: Database.Database;

  beforeEach(() => {
    temp = createTempDbDir();
    const core = createCoreDb(`${temp.dir}/core.db`);
    coreDb = core.db;
    sessions = core.sessions;
    memoryDb = createMemoryDb(`${temp.dir}/memory.db`);
    resolverCalls.length = 0;
    mocks.logger.info.mockClear();
    mocks.logger.warn.mockClear();
    mocks.logger.error.mockClear();
  });

  afterEach(() => {
    memoryDb.close();
    coreDb.close();
    temp.cleanup();
  });

  const syncAll = (extra: Record<string, unknown> = {}) =>
    syncAllFromMainDb({ coreDb, sessions, memoryDb, ...extra } as Parameters<typeof syncAllFromMainDb>[0]);
  const syncOne = (sessionId: string) =>
    syncSessionFromMainDb({ coreDb, sessions, memoryDb, sessionId });

  it('1. empty core DB, empty memory DB → sync returns all-zero metrics', () => {
    const result = syncAll();
    expect(result).toEqual({
      inserted: 0,
      updated: 0,
      tombstoned: 0,
      errors: 0,
      durationMs: expect.any(Number) as number,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('2. one new session in core DB → inserted into memory DB', () => {
    insertSession(sessions, {
      id: 'sess-1',
      working_directory: 'D:/projects/alpha',
      created_at: 1000,
      updated_at: 2000,
    });
    insertMessageIndex(coreDb, {
      id: 'msg-1',
      session_id: 'sess-1',
      created_at: 1500,
    });

    const result = syncAll();
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
    insertSession(sessions, { id: 'sess-1', working_directory: 'D:/projects/alpha' });
    insertMessageIndex(coreDb, { id: 'msg-1', session_id: 'sess-1', created_at: 1000 });

    syncAll();
    const before = getRollout(memoryDb, 'sess-1');
    const fingerprintBefore = before?.['source_fingerprint'];
    const generationBefore = before?.['generation'];

    // Add a new message → fingerprint must change, generation must bump.
    insertMessageIndex(coreDb, { id: 'msg-2', session_id: 'sess-1', created_at: 2000 });

    const result = syncOne('sess-1');
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

  it('4. session status=deleted in core DB → source_status=deleted, source_deleted_at set; NOT row-deleted', () => {
    insertSession(sessions, { id: 'sess-1', working_directory: 'D:/projects/alpha' });
    insertMessageIndex(coreDb, { id: 'msg-1', session_id: 'sess-1', created_at: 1000 });

    // First sync to materialize the row with source_status='active'.
    syncAll();
    const before = getRollout(memoryDb, 'sess-1');
    expect(before?.['source_status']).toBe('active');
    const fingerprintBefore = before?.['source_fingerprint'];
    const generationBefore = before?.['generation'];
    const firstSeenBefore = before?.['first_seen_at'];

    // Soft-delete the session (status='deleted').
    sessions.update('sess-1', { status: 'deleted' });

    const result = syncOne('sess-1');
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

  it('5. session with parent_id set → agent_type copied VERBATIM from core sessions.agent_type (sub-agent)', () => {
    insertSession(sessions, { id: 'parent-1', working_directory: 'D:/projects/alpha' });
    insertSession(sessions, {
      id: 'child-1',
      working_directory: 'D:/projects/alpha',
      parent_id: 'parent-1',
      agent_type: 'sub-agent',
    });
    insertMessageIndex(coreDb, { id: 'm-parent', session_id: 'parent-1', created_at: 1000 });
    insertMessageIndex(coreDb, { id: 'm-child', session_id: 'child-1', created_at: 2000 });

    syncAll();

    const child = getRollout(memoryDb, 'child-1');
    // Verbatim copy — NO derivation from parent_id to 'subagent' or similar.
    expect(child?.['agent_type']).toBe('sub-agent');
    expect(child?.['parent_id']).toBe('parent-1');
  });

  it('6. session with mode=automation and default agent_type=main → catalog keeps both verbatim', () => {
    insertSession(sessions, {
      id: 'sess-auto',
      working_directory: 'D:/projects/alpha',
      mode: 'automation',
      agent_type: 'main',
    });
    insertMessageIndex(coreDb, { id: 'm1', session_id: 'sess-auto', created_at: 1000 });

    syncAll();

    const rollout = getRollout(memoryDb, 'sess-auto');
    expect(rollout?.['agent_type']).toBe('main');
    expect(rollout?.['mode']).toBe('automation');
    expect(rollout?.['source_status']).toBe('active');
  });

  it('7. working_directory empty in core DB → scope_kind=global, project_id=NULL; no cwd substitution', () => {
    insertSession(sessions, { id: 'sess-1', working_directory: '' });
    insertMessageIndex(coreDb, { id: 'm1', session_id: 'sess-1', created_at: 1000 });

    // Pass a cwd to verify it is NOT substituted for the empty working_directory.
    syncAllFromMainDb({ coreDb, sessions, memoryDb, cwd: 'D:/electron-process-cwd' });

    const rollout = getRollout(memoryDb, 'sess-1');
    expect(rollout?.['scope_kind']).toBe('global');
    expect(rollout?.['project_id']).toBeNull();
    expect(rollout?.['working_directory']).toBeNull();
    expect(rollout?.['working_directory_normalized']).toBeNull();
    // Resolver must NOT have been called for this session.
    expect(resolverCalls.filter((c) => c.cwd === 'D:/electron-process-cwd')).toHaveLength(0);
  });

  it('8. two sessions from different Agent Profiles with same working_directory → same project_id; profile IDs are provenance only', () => {
    insertSession(sessions, {
      id: 'sess-A',
      working_directory: 'D:/projects/alpha',
      agent_profile_id: 'profile-A',
    });
    insertSession(sessions, {
      id: 'sess-B',
      working_directory: 'D:/projects/alpha',
      agent_profile_id: 'profile-B',
    });
    insertMessageIndex(coreDb, { id: 'mA1', session_id: 'sess-A', created_at: 1000 });
    insertMessageIndex(coreDb, { id: 'mB1', session_id: 'sess-B', created_at: 2000 });

    syncAll();

    const a = getRollout(memoryDb, 'sess-A');
    const b = getRollout(memoryDb, 'sess-B');
    expect(a?.['project_id']).toBe(b?.['project_id']);
    expect(a?.['project_id']).toBe('proj-alpha-uuid');
    // agent_profile_id preserved as provenance — does not affect scope.
    expect(a?.['agent_profile_id']).toBe('profile-A');
    expect(b?.['agent_profile_id']).toBe('profile-B');
  });

  it('9. two sessions with same valid working_directory → same project_id; two distinct catalog rows', () => {
    insertSession(sessions, { id: 'sess-1', working_directory: 'D:/projects/alpha' });
    insertSession(sessions, { id: 'sess-2', working_directory: 'D:/projects/alpha' });
    insertMessageIndex(coreDb, { id: 'm1', session_id: 'sess-1', created_at: 1000 });
    insertMessageIndex(coreDb, { id: 'm2', session_id: 'sess-2', created_at: 2000 });

    syncAll();

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
    insertSession(sessions, { id: 'sess-global', working_directory: '' });
    insertSession(sessions, { id: 'sess-project', working_directory: 'D:/projects/alpha' });
    insertMessageIndex(coreDb, { id: 'mg', session_id: 'sess-global', created_at: 1000 });
    insertMessageIndex(coreDb, { id: 'mp', session_id: 'sess-project', created_at: 2000 });

    const result = syncAll();
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
    insertSession(sessions, { id: 'sess-1', working_directory: 'D:/projects/alpha' });
    insertMessageIndex(coreDb, { id: 'm1', session_id: 'sess-1', created_at: 1000 });

    // First sync materializes the row.
    syncOne('sess-1');
    const before = getRollout(memoryDb, 'sess-1');
    const fingerprintBefore = before?.['source_fingerprint'];
    const generationBefore = before?.['generation'];

    // Re-run with no changes.
    const result = syncOne('sess-1');
    expect(result.status).toBe('unchanged');

    const after = getRollout(memoryDb, 'sess-1');
    expect(after?.['source_fingerprint']).toBe(fingerprintBefore);
    expect(after?.['generation']).toBe(generationBefore);
    // last_seen_at is refreshed (heartbeat), so it should be >= the previous value.
    expect(after?.['last_seen_at'] as number).toBeGreaterThanOrEqual(
      before?.['last_seen_at'] as number
    );
  });

  it('12. syncSessionFromMainDb on a session missing from core DB → tombstones existing rollout', () => {
    // Materialize a row first.
    insertSession(sessions, { id: 'sess-1', working_directory: 'D:/projects/alpha' });
    insertMessageIndex(coreDb, { id: 'm1', session_id: 'sess-1', created_at: 1000 });
    syncAll();

    // Hard-delete the session from core DB (not just status='deleted').
    coreDb.prepare('DELETE FROM sessions WHERE id = ?').run('sess-1');

    const result = syncOne('sess-1');
    expect(result.status).toBe('tombstoned');

    const rollout = getRollout(memoryDb, 'sess-1');
    expect(rollout).toBeDefined(); // Row still exists.
    expect(rollout?.['source_status']).toBe('deleted');
    expect(rollout?.['source_deleted_at']).toBeTypeOf('number');
  });

  it('13. markSourceMissing flips source_status to missing and sets source_missing_at', () => {
    insertSession(sessions, { id: 'sess-1', working_directory: 'D:/projects/alpha' });
    insertMessageIndex(coreDb, { id: 'm1', session_id: 'sess-1', created_at: 1000 });
    syncAll();

    markSourceMissing({ memoryDb, sessionId: 'sess-1' });

    const rollout = getRollout(memoryDb, 'sess-1');
    expect(rollout?.['source_status']).toBe('missing');
    expect(rollout?.['source_missing_at']).toBeTypeOf('number');
    expect(rollout?.['source_missing_at']).toBeGreaterThan(0);
  });

  it('14. session with status=archived → tombstoned (not row-deleted)', () => {
    insertSession(sessions, {
      id: 'sess-archived',
      working_directory: 'D:/projects/alpha',
      status: 'archived',
    });
    insertMessageIndex(coreDb, { id: 'm1', session_id: 'sess-archived', created_at: 1000 });

    syncAll();

    const rollout = getRollout(memoryDb, 'sess-archived');
    expect(rollout).toBeDefined();
    expect(rollout?.['source_status']).toBe('deleted');
    expect(rollout?.['source_deleted_at']).toBeTypeOf('number');
  });

  it('15. session with empty messages → fingerprint is sha256 of "[]", generation=0', () => {
    insertSession(sessions, { id: 'sess-empty', working_directory: 'D:/projects/alpha' });
    // No messages inserted.

    syncAll();

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
