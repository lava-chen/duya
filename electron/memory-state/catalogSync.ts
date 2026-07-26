import type { Database } from 'better-sqlite3';
import { getLogger, LogComponent } from '../logging/logger';
import { resolveProject } from './projectResolver';
import {
  computeSourceFingerprint,
  readMessagesForFingerprint,
  type MessageForHash,
} from './sourceFingerprint';
import type { AgentType, ScopeKind } from './schema';

/**
 * Main-DB catalog sync (Plan 301 Phase C).
 *
 * One-way read from `chat_sessions` + `messages` in `duya-main.db`,
 * materializing one `rollout_catalog` row per session in
 * `memory-state.db`. Plan 305 will wire this into the memory-worker;
 * until then there are no production callers (shadow mode).
 *
 * Sync performs NO eligibility filtering (Plan 302 owns that) and NO
 * agent_type / mode derivation — values are copied verbatim from
 * `chat_sessions`. Deleted sessions are tombstoned, not row-deleted,
 * so memory entries that already cite them keep their provenance.
 */

export interface SyncResult {
  inserted: number;
  updated: number;
  tombstoned: number; // sessions deleted in main DB
  errors: number;
  durationMs: number;
}

export interface SyncSessionResult {
  status: 'inserted' | 'updated' | 'tombstoned' | 'unchanged';
}

interface ChatSessionRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  model: string;
  system_prompt: string;
  working_directory: string;
  project_name: string;
  status: string;
  mode: string;
  permission_profile: string;
  provider_id: string;
  context_summary: string;
  context_summary_updated_at: number;
  is_deleted: number;
  generation: number;
  agent_profile_id: string | null;
  parent_id: string | null;
  agent_type: string;
  agent_name: string;
  conductor_mode_enabled: number;
  conductor_canvas_id: string | null;
}

interface ExistingRolloutRow {
  rollout_id: string;
  first_seen_at: number;
  source_fingerprint: string | null;
  generation: number;
  message_count: number;
  last_message_id: string | null;
  last_message_at: number | null;
}

const SESSION_COLUMNS = `
  id, title, created_at, updated_at, model, system_prompt,
  working_directory, project_name, status, mode, permission_profile,
  provider_id, context_summary, context_summary_updated_at, is_deleted,
  generation, agent_profile_id, parent_id, agent_type, agent_name,
  conductor_mode_enabled, conductor_canvas_id
`;

const SELECT_ALL_SESSIONS_SQL = `SELECT ${SESSION_COLUMNS} FROM chat_sessions`;
const SELECT_ONE_SESSION_SQL = `SELECT ${SESSION_COLUMNS} FROM chat_sessions WHERE id = ?`;

const SELECT_EXISTING_ROLLOUT_SQL = `
  SELECT rollout_id, first_seen_at, source_fingerprint, generation,
         message_count, last_message_id, last_message_at
  FROM rollout_catalog
  WHERE rollout_id = ?
`;

/**
 * UPSERT for an active (non-deleted) session.
 *
 * `first_seen_at` is set on INSERT only — the ON CONFLICT clause does
 * NOT update it. `last_seen_at` is always set to :now. `generation`
 * and `source_fingerprint` are passed as parameters so the caller can
 * decide whether to bump (new content) or carry forward (unchanged).
 */
const UPSERT_ACTIVE_SQL = `
  INSERT INTO rollout_catalog (
    rollout_id, scope_kind, project_id, agent_type, parent_id, mode,
    working_directory, working_directory_normalized, git_root,
    agent_profile_id, message_count, last_message_id, last_message_at,
    source_status, source_missing_at, source_deleted_at,
    generation, source_fingerprint, last_seen_at, first_seen_at
  ) VALUES (
    @rollout_id, @scope_kind, @project_id, @agent_type, @parent_id, @mode,
    @working_directory, @working_directory_normalized, @git_root,
    @agent_profile_id, @message_count, @last_message_id, @last_message_at,
    @source_status, @source_missing_at, @source_deleted_at,
    @generation, @source_fingerprint, @last_seen_at, @first_seen_at
  )
  ON CONFLICT(rollout_id) DO UPDATE SET
    scope_kind = excluded.scope_kind,
    project_id = excluded.project_id,
    agent_type = excluded.agent_type,
    parent_id = excluded.parent_id,
    mode = excluded.mode,
    working_directory = excluded.working_directory,
    working_directory_normalized = excluded.working_directory_normalized,
    git_root = excluded.git_root,
    agent_profile_id = excluded.agent_profile_id,
    message_count = excluded.message_count,
    last_message_id = excluded.last_message_id,
    last_message_at = excluded.last_message_at,
    source_status = excluded.source_status,
    source_missing_at = excluded.source_missing_at,
    source_deleted_at = excluded.source_deleted_at,
    generation = excluded.generation,
    source_fingerprint = excluded.source_fingerprint,
    last_seen_at = excluded.last_seen_at
`;

/**
 * UPSERT for a deleted/tombstoned session. Only touches `source_status`,
 * `source_deleted_at`, `last_seen_at` on conflict. Preserves the
 * existing `source_fingerprint`, `generation`, and `first_seen_at` so
 * memory entries that cite the deleted session keep their provenance.
 *
 * The INSERT branch (no existing row) carries the verbatim `agent_type`
 * from `chat_sessions` because the catalog CHECK constraint requires it.
 * Provenance fields default to NULL/0 when no prior row exists.
 */
const UPSERT_TOMBSTONE_SQL = `
  INSERT INTO rollout_catalog (
    rollout_id, scope_kind, project_id, agent_type, parent_id, mode,
    working_directory, working_directory_normalized, git_root,
    agent_profile_id, message_count, last_message_id, last_message_at,
    source_status, source_missing_at, source_deleted_at,
    generation, source_fingerprint, last_seen_at, first_seen_at
  ) VALUES (
    @rollout_id, 'global', NULL, @agent_type, @parent_id, @mode,
    @working_directory, NULL, NULL,
    @agent_profile_id, 0, NULL, NULL,
    'deleted', NULL, @source_deleted_at,
    @generation, @source_fingerprint, @last_seen_at, @first_seen_at
  )
  ON CONFLICT(rollout_id) DO UPDATE SET
    source_status = 'deleted',
    source_deleted_at = @source_deleted_at,
    last_seen_at = @last_seen_at
`;

const UPDATE_HEARTBEAT_SQL = `
  UPDATE rollout_catalog
  SET last_seen_at = @last_seen_at,
      message_count = @message_count,
      last_message_id = @last_message_id,
      last_message_at = @last_message_at
  WHERE rollout_id = @rollout_id
`;

/**
 * Resolve a session's scope (global vs project) via the Phase B
 * project resolver. Returns `scope_kind='global'` and `project_id=null`
 * if the session has no usable working directory.
 *
 * D6: `agent_profile_id` is passed through as provenance only — it
 * never affects scope or visibility. D3: resolution order is
 * override → working_directory → cwd fallback. We never substitute
 * the Electron process cwd for a historical session that lacks a
 * working directory; such sessions become global.
 */
function resolveScope(opts: {
  workingDirectory: string;
  agentProfileId: string | null;
  cwd?: string;
  workspaceOverridesPath?: string;
  memoryDb: Database;
}): {
  scope_kind: ScopeKind;
  project_id: string | null;
  working_directory: string | null;
  working_directory_normalized: string | null;
} {
  const workingDirectory = opts.workingDirectory?.trim() ?? '';
  if (!workingDirectory) {
    // No valid workspace — global scope. Never substitute caller cwd
    // for a historical session (D6/D7).
    return {
      scope_kind: 'global',
      project_id: null,
      working_directory: null,
      working_directory_normalized: null,
    };
  }
  try {
    const resolved = resolveProject({
      workingDirectory,
      agent_profile_id: opts.agentProfileId ?? undefined,
      cwd: opts.cwd,
      workspaceOverridesPath: opts.workspaceOverridesPath,
      memoryDb: opts.memoryDb,
    });
    return {
      scope_kind: 'project',
      project_id: resolved.project_id,
      working_directory: workingDirectory,
      working_directory_normalized: resolved.absolute_normalized_path,
    };
  } catch (err) {
    // Resolver failure must not break the sync — fall back to global
    // so the catalog row still materializes with provenance.
    const logger = getLogger();
    logger.warn(
      'memory-state: project resolution failed; falling back to global scope',
      {
        workingDirectory,
        error: err instanceof Error ? err.message : String(err),
      },
      LogComponent.DB
    );
    return {
      scope_kind: 'global',
      project_id: null,
      working_directory: workingDirectory,
      working_directory_normalized: null,
    };
  }
}

/**
 * Compute message metadata (count, last_message_id, last_message_at)
 * from the projected message list. The caller already has the
 * messages array; we avoid a second DB round-trip.
 *
 * `readMessagesForFingerprint` returns rows in
 * `ORDER BY created_at ASC, rowid ASC`, so the last element is the
 * latest message.
 */
function computeMessageMetadata(messages: MessageForHash[]): {
  message_count: number;
  last_message_id: string | null;
  last_message_at: number | null;
} {
  if (messages.length === 0) {
    return { message_count: 0, last_message_id: null, last_message_at: null };
  }
  const last = messages[messages.length - 1];
  return {
    message_count: messages.length,
    last_message_id: last.id,
    last_message_at: last.created_at,
  };
}

/**
 * Sync a single session from the main DB into the memory DB.
 *
 * Wrapped in a single transaction so a half-written row never escapes
 * to readers. Returns the status:
 *   - 'inserted'   — new rollout_catalog row
 *   - 'updated'    — fingerprint changed, generation bumped
 *   - 'tombstoned' — session is deleted/archived/purged in main DB
 *   - 'unchanged'  — fingerprint matches; only heartbeat fields touched
 */
export function syncSessionFromMainDb(opts: {
  mainDb: Database;
  memoryDb: Database;
  sessionId: string;
  cwd?: string;
  workspaceOverridesPath?: string;
}): SyncSessionResult {
  const logger = getLogger();
  const { mainDb, memoryDb, sessionId } = opts;

  const session = mainDb.prepare(SELECT_ONE_SESSION_SQL).get(sessionId) as
    | ChatSessionRow
    | undefined;

  if (!session) {
    // Session no longer exists in main DB. Tombstone it so the
    // catalog row retains provenance for memory entries that cite it.
    const now = Date.now();
    const txn = memoryDb.transaction(() => {
      markRolloutDeleted(memoryDb, sessionId, now);
    });
    txn();
    return { status: 'tombstoned' };
  }

  // Per-session transaction. One txn per session (NOT one big txn for
  // all sessions) so the lock is held briefly and a single failure
  // does not roll back the entire sync.
  const txn = memoryDb.transaction(() => {
    return syncOneSession(mainDb, memoryDb, session, opts);
  });

  try {
    return txn();
  } catch (err) {
    logger.error(
      'memory-state: per-session sync failed',
      err instanceof Error ? err : new Error(String(err)),
      { sessionId, sessionStatus: session.status, isDeleted: session.is_deleted },
      LogComponent.DB
    );
    throw err;
  }
}

/**
 * Full sync — iterate every chat_sessions row and materialize a
 * rollout_catalog row for each. Called at worker startup (Plan 305
 * wires this in; shadow mode = no production caller yet).
 *
 * Each session is synced in its own transaction so a single failure
 * does not roll back the entire sync. The error counter tracks how
 * many sessions failed; the sync continues on to the next session.
 */
export function syncAllFromMainDb(opts: {
  mainDb: Database;
  memoryDb: Database;
  cwd?: string;
  workspaceOverridesPath?: string;
}): SyncResult {
  const logger = getLogger();
  const start = Date.now();
  let inserted = 0;
  let updated = 0;
  let tombstoned = 0;
  let errors = 0;

  const sessions = opts.mainDb.prepare(SELECT_ALL_SESSIONS_SQL).all() as ChatSessionRow[];

  for (const session of sessions) {
    try {
      const txn = opts.memoryDb.transaction(() => {
        return syncOneSession(opts.mainDb, opts.memoryDb, session, opts);
      });
      const result = txn();
      switch (result.status) {
        case 'inserted':
          inserted++;
          break;
        case 'updated':
          updated++;
          break;
        case 'tombstoned':
          tombstoned++;
          break;
        case 'unchanged':
          // No counter — unchanged is a no-op for metrics.
          break;
      }
    } catch (err) {
      errors++;
      logger.error(
        'memory-state: session sync failed during syncAll',
        err instanceof Error ? err : new Error(String(err)),
        { sessionId: session.id },
        LogComponent.DB
      );
    }
  }

  const durationMs = Date.now() - start;
  logger.info(
    'memory-state: catalog sync complete',
    { inserted, updated, tombstoned, errors, durationMs, totalSessions: sessions.length },
    LogComponent.DB
  );

  return { inserted, updated, tombstoned, errors, durationMs };
}

/**
 * Mark a rollout's source as missing. Called by the reaper (Plan 305)
 * when `last_seen_at` is older than 30 days AND the main DB still has
 * the session row — i.e. we somehow missed the deletion event.
 *
 * Does NOT delete the row. Only flips `source_status` to 'missing'
 * and records when we noticed.
 */
export function markSourceMissing(opts: {
  memoryDb: Database;
  sessionId: string;
}): void {
  const now = Date.now();
  opts.memoryDb
    .prepare(
      `UPDATE rollout_catalog
         SET source_status = 'missing',
             source_missing_at = ?,
             last_seen_at = ?
       WHERE rollout_id = ?`
    )
    .run(now, now, opts.sessionId);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Sync one session. Assumes the caller has already opened a transaction
 * on `memoryDb`. Reads `messages` from `mainDb` (read-only) and writes
 * the `rollout_catalog` row to `memoryDb`.
 */
function syncOneSession(
  mainDb: Database,
  memoryDb: Database,
  session: ChatSessionRow,
  opts: { cwd?: string; workspaceOverridesPath?: string }
): SyncSessionResult {
  const now = Date.now();

  // Deleted / archived / purged sessions are tombstoned. We do NOT
  // recompute the fingerprint — keep the existing one if present so
  // memory entries that cite this session keep their provenance.
  if (session.is_deleted === 1 || session.status === 'archived' || session.status === 'purged') {
    return tombstoneRollout(memoryDb, session, now);
  }

  // Active session — compute fingerprint and message metadata.
  const messages = readMessagesForFingerprint(mainDb, session.id);
  return activeSync(memoryDb, session, messages, opts, now);
}

function activeSync(
  memoryDb: Database,
  session: ChatSessionRow,
  messages: MessageForHash[],
  opts: { cwd?: string; workspaceOverridesPath?: string },
  now: number
): SyncSessionResult {
  const fingerprint = computeSourceFingerprint(messages);
  const meta = computeMessageMetadata(messages);

  const existing = memoryDb.prepare(SELECT_EXISTING_ROLLOUT_SQL).get(session.id) as
    | ExistingRolloutRow
    | undefined;

  // Fingerprint unchanged AND message metadata unchanged → heartbeat-only.
  // No generation bump, no fingerprint rewrite. Return 'unchanged'.
  if (
    existing &&
    existing.source_fingerprint === fingerprint &&
    existing.message_count === meta.message_count &&
    existing.last_message_id === meta.last_message_id &&
    existing.last_message_at === meta.last_message_at
  ) {
    memoryDb.prepare(UPDATE_HEARTBEAT_SQL).run({
      rollout_id: session.id,
      last_seen_at: now,
      message_count: meta.message_count,
      last_message_id: meta.last_message_id,
      last_message_at: meta.last_message_at,
    });
    return { status: 'unchanged' };
  }

  const scope = resolveScope({
    workingDirectory: session.working_directory,
    agentProfileId: session.agent_profile_id,
    cwd: opts.cwd,
    workspaceOverridesPath: opts.workspaceOverridesPath,
    memoryDb,
  });

  // Generation bump: existing.generation + 1 if existing, else 0.
  // (A brand-new row starts at generation=0; the first content change
  // after insertion bumps to 1.)
  const nextGeneration = existing ? existing.generation + 1 : 0;

  memoryDb.prepare(UPSERT_ACTIVE_SQL).run({
    rollout_id: session.id,
    scope_kind: scope.scope_kind,
    project_id: scope.project_id,
    agent_type: session.agent_type as AgentType,
    parent_id: session.parent_id,
    mode: session.mode,
    working_directory: scope.working_directory,
    working_directory_normalized: scope.working_directory_normalized,
    git_root: null, // Git probing is optional metadata; sync never sets it.
    agent_profile_id: session.agent_profile_id,
    message_count: meta.message_count,
    last_message_id: meta.last_message_id,
    last_message_at: meta.last_message_at,
    source_status: 'active',
    source_missing_at: null,
    source_deleted_at: null,
    generation: nextGeneration,
    source_fingerprint: fingerprint,
    last_seen_at: now,
    first_seen_at: existing ? existing.first_seen_at : now,
  });

  return { status: existing ? 'updated' : 'inserted' };
}

/**
 * Tombstone a rollout for a session that is deleted/archived/purged
 * in the main DB. The session row is still present in `chat_sessions`,
 * so we can read its `agent_type`, `mode`, etc. for the INSERT branch
 * (in case there's no existing rollout row to update).
 */
function tombstoneRollout(
  memoryDb: Database,
  session: ChatSessionRow,
  now: number
): SyncSessionResult {
  const existing = memoryDb
    .prepare('SELECT first_seen_at, source_fingerprint, generation FROM rollout_catalog WHERE rollout_id = ?')
    .get(session.id) as
    | { first_seen_at: number; source_fingerprint: string | null; generation: number }
    | undefined;

  memoryDb.prepare(UPSERT_TOMBSTONE_SQL).run({
    rollout_id: session.id,
    agent_type: session.agent_type as AgentType,
    parent_id: session.parent_id,
    mode: session.mode,
    working_directory: session.working_directory || null,
    agent_profile_id: session.agent_profile_id,
    source_deleted_at: now,
    generation: existing ? existing.generation : 0,
    source_fingerprint: existing ? existing.source_fingerprint : null,
    last_seen_at: now,
    first_seen_at: existing ? existing.first_seen_at : now,
  });

  return { status: 'tombstoned' };
}

/**
 * Mark an existing rollout row as deleted. Used when the session is
 * GONE from `chat_sessions` entirely (not just soft-deleted). The
 * catalog row's prior metadata is preserved; only `source_status`,
 * `source_deleted_at`, and `last_seen_at` are touched.
 *
 * If no rollout row exists yet, there is nothing to tombstone — log
 * and skip. We cannot synthesize a row without knowing the original
 * `agent_type` (CHECK constraint).
 */
function markRolloutDeleted(memoryDb: Database, sessionId: string, now: number): void {
  const result = memoryDb
    .prepare(
      `UPDATE rollout_catalog
         SET source_status = 'deleted',
             source_deleted_at = ?,
             last_seen_at = ?
       WHERE rollout_id = ?`
    )
    .run(now, now, sessionId);

  if (result.changes === 0) {
    const logger = getLogger();
    logger.warn(
      'memory-state: cannot tombstone missing rollout (no existing row)',
      { sessionId },
      LogComponent.DB
    );
  }
}
