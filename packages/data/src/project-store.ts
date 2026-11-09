/**
 * project-store.ts — ProjectStore aggregate for `duya-core.db` (plan 534).
 *
 * `projects` / `project_bots` were misplaced in `memory-state.db` (plan 525).
 * This store is the canonical home: project migrations 61–65 plus typed CRUD and
 * the path-JSON helpers. The schema is a verbatim carry-over of the accumulated
 * memory-state migrations (0001 base + 0012 entity + 0013 icon/color) so reads
 * behave identically.
 *
 * Notes preserved from the original schema:
 *   - `project_id` is a stable UUID, NOT a path hash. `canonical_root` is UNIQUE.
 *   - `projects.paths` is a JSON array of `{path, description}` entries. Parse
 *     with `parseProjectPaths` — never `JSON.parse` directly.
 *   - `project_bots.bot_id` has NO foreign key: `agents` lives in duya-main.db
 *     and SQLite cannot enforce cross-database FKs.
 *
 * Consumers: projectService (entity CRUD behind IPC), projectResolver (identity
 * registration by path), db-bridge (path→project grouping). All must use the
 * same core `projects` table to avoid a split-brain between entity reads and
 * session-registration writes.
 */

import { randomUUID } from 'node:crypto';
import type { Migration, SqliteDatabase } from './core-database.js';

export interface ProjectRow {
  project_id: string;
  canonical_root: string;
  /** Display name (migration 0012). Empty string when unset. */
  name: string;
  /** One-line description (migration 0012). NULL when unset. */
  description: string | null;
  /**
   * JSON-encoded array of {path, description} entries (migration 0012).
   * Parse with `parseProjectPaths`.
   */
  paths: string;
  /** Avatar icon name (migration 0013). NULL = default. */
  icon: string | null;
  /** Avatar accent color keyword (migration 0013). NULL = default. */
  color: string | null;
  created_at: number;
  last_seen_at: number;
  coordinator_session_id: string | null;
}

/** One entry of the `projects.paths` JSON column. */
export interface ProjectPathEntry {
  path: string;
  /** NULL when no description — never an empty string. */
  description: string | null;
}

export interface ProjectBotRow {
  project_id: string;
  bot_id: string;
  joined_at: number;
}

export interface ProjectTaskLinkRow {
  project_id: string;
  task_id: string;
  coordinator_session_id: string;
  work_session_id: string | null;
  updated_at: number;
  acceptance_status: 'pending' | 'accepted' | 'rejected';
}

export interface ProjectDecisionRow {
  project_id: string; decision_key: string; content: string;
  status: 'proposed' | 'accepted' | 'superseded'; revision: number;
  source_type: string; source_id: string; updated_at: number;
}
export interface ProjectMemoryRow {
  project_id: string; memory_key: string; content: string;
  status: 'candidate' | 'active' | 'superseded' | 'retired'; revision: number;
  source_type: string; source_id: string; updated_at: number;
}
export interface ProjectActivityRow {
  event_id: number; project_id: string; event_type: string; task_id: string | null;
  session_id: string | null; run_id: string | null; source_type: string;
  source_id: string; payload: string; created_at: number;
}

export interface InsertProjectInput {
  project_id?: string;
  canonical_root: string;
  name?: string;
  description?: string | null;
  paths?: string;
  icon?: string | null;
  color?: string | null;
  created_at?: number;
  last_seen_at?: number;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  /** Replacement path list; paths[0].path becomes the new canonical_root. */
  paths?: string;
  /** Re-derived canonical_root; pair with `paths` when re-rooting. */
  canonical_root?: string;
  icon?: string | null;
  color?: string | null;
}

/**
 * Parse the `projects.paths` JSON column.
 *
 * Corrupted or malformed payloads degrade to `[]` — never throw, because a
 * broken JSON blob must not take down project resolution. Entries missing
 * `path` or with a non-string path are dropped; a missing/empty description is
 * normalized to NULL.
 */
export function parseProjectPaths(raw: string | null | undefined): ProjectPathEntry[] {
  if (raw == null || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: ProjectPathEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const { path, description } = item as Record<string, unknown>;
    if (typeof path !== 'string' || path === '') continue;
    entries.push({
      path,
      description: typeof description === 'string' && description !== '' ? description : null,
    });
  }
  return entries;
}

/** Serialize `projects.paths` entries to the JSON column value. Always valid JSON array. */
export function serializeProjectPaths(entries: ProjectPathEntry[]): string {
  return JSON.stringify(entries);
}

/** Parsed path entries of a project row (convenience; shared with service/resolver). */
export function projectPaths(row: Pick<ProjectRow, 'paths'>): ProjectPathEntry[] {
  return parseProjectPaths(row.paths);
}

export class ProjectStore {
  /** Project migrations use ids 61–65, above the current core schema maximum. */
  static readonly migrations: Migration[] = [
    {
      id: 61,
      name: 'create_projects',
      up: (db) => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS projects (
            project_id      TEXT PRIMARY KEY,
            canonical_root  TEXT NOT NULL UNIQUE,
            name            TEXT NOT NULL DEFAULT '',
            description     TEXT,
            paths           TEXT NOT NULL DEFAULT '[]',
            icon            TEXT,
            color           TEXT,
            created_at      INTEGER NOT NULL,
            last_seen_at    INTEGER NOT NULL
          );

          CREATE TABLE IF NOT EXISTS project_bots (
            project_id  TEXT NOT NULL,
            bot_id      TEXT NOT NULL,
            joined_at   INTEGER NOT NULL,
            PRIMARY KEY (project_id, bot_id)
          );

          CREATE INDEX IF NOT EXISTS idx_project_bots_bot ON project_bots(bot_id);
          CREATE INDEX IF NOT EXISTS idx_projects_last_seen ON projects(last_seen_at);
        `);
      },
    },
    {
      id: 62,
      name: 'project_coordinator_session',
      up: (db) => {
        const columns = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
        if (!columns.some((column) => column.name === 'coordinator_session_id')) {
          db.exec('ALTER TABLE projects ADD COLUMN coordinator_session_id TEXT');
        }
      },
    },
    {
      id: 63,
      name: 'project_task_session_links',
      up: (db) => {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
        const hasTasks = tables.some((table) => table.name === 'tasks');
        const hasSessions = tables.some((table) => table.name === 'sessions');
        db.exec(`
        CREATE TABLE IF NOT EXISTS project_task_sessions (
          project_id TEXT NOT NULL,
          task_id TEXT NOT NULL UNIQUE,
          coordinator_session_id TEXT NOT NULL,
          work_session_id TEXT,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (project_id, task_id),
          FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
          ${hasTasks ? ', FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE' : ''}
          ${hasSessions ? ', FOREIGN KEY (work_session_id) REFERENCES sessions(id) ON DELETE SET NULL' : ''}
        );
        CREATE INDEX IF NOT EXISTS idx_project_task_sessions_project ON project_task_sessions(project_id, updated_at);
        `);
      },
    },
    {
      id: 64,
      name: 'project_continuity_records',
      up: (db) => {
        // A migration can have applied its DDL before its ledger row was
        // committed (for example after an interrupted upgrade). Inspect the
        // actual schema as well as the ledger so replay is safe.
        const taskLinkColumns = db.prepare('PRAGMA table_info(project_task_sessions)').all() as Array<{ name: string }>;
        if (taskLinkColumns.length && !taskLinkColumns.some((column) => column.name === 'acceptance_status')) {
          db.exec(`ALTER TABLE project_task_sessions ADD COLUMN acceptance_status TEXT NOT NULL DEFAULT 'pending'
            CHECK (acceptance_status IN ('pending','accepted','rejected'))`);
        }
        db.exec(`
        CREATE TABLE IF NOT EXISTS project_continuity_state (
          project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1,
          current_state TEXT NOT NULL DEFAULT '', next_step TEXT NOT NULL DEFAULT '',
          source_type TEXT NOT NULL, source_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS project_decisions (
          project_id TEXT NOT NULL, decision_key TEXT NOT NULL, content TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('proposed','accepted','superseded')),
          revision INTEGER NOT NULL DEFAULT 1, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
          updated_at INTEGER NOT NULL, PRIMARY KEY(project_id, decision_key),
          FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS project_memories (
          project_id TEXT NOT NULL, memory_key TEXT NOT NULL, content TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('candidate','active','superseded','retired')),
          revision INTEGER NOT NULL DEFAULT 1, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
          updated_at INTEGER NOT NULL, PRIMARY KEY(project_id, memory_key),
          FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS project_memory_history (
          project_id TEXT NOT NULL, memory_key TEXT NOT NULL, revision INTEGER NOT NULL,
          content TEXT NOT NULL, status TEXT NOT NULL, source_type TEXT NOT NULL,
          source_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY(project_id, memory_key, revision),
          FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS project_decision_history (
          project_id TEXT NOT NULL, decision_key TEXT NOT NULL, revision INTEGER NOT NULL,
          content TEXT NOT NULL, status TEXT NOT NULL, source_type TEXT NOT NULL,
          source_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY(project_id, decision_key, revision),
          FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS project_activity (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
          event_type TEXT NOT NULL, task_id TEXT, session_id TEXT, run_id TEXT,
          source_type TEXT NOT NULL, source_id TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_project_activity_cursor ON project_activity(project_id, event_id);
      `);
      },
    },
    {
      id: 65,
      name: 'project_activity_run_terminal_dedupe',
      up: (db) => {
        // A retried settle and a restart reconciliation must converge on ONE
        // `run.terminal` row per Run. Keep the earliest row if an interrupted
        // build already produced duplicates, then let the index enforce it.
        db.exec(`
          DELETE FROM project_activity
            WHERE event_type = 'run.terminal' AND source_type = 'run'
              AND event_id NOT IN (
                SELECT MIN(event_id) FROM project_activity
                  WHERE event_type = 'run.terminal' AND source_type = 'run'
                  GROUP BY project_id, source_id
              );
          CREATE UNIQUE INDEX IF NOT EXISTS uq_project_activity_run_terminal
            ON project_activity(project_id, source_id)
            WHERE event_type = 'run.terminal' AND source_type = 'run';
          CREATE INDEX IF NOT EXISTS idx_project_task_sessions_work_session
            ON project_task_sessions(work_session_id);
        `);
      },
    },
  ];

  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  /** Raw handle — needed by projectResolver for multi-statement IMMEDIATE txns. */
  get raw(): SqliteDatabase {
    return this.db;
  }

  insert(input: InsertProjectInput): ProjectRow {
    const now = Date.now();
    const projectId = input.project_id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO projects (
          project_id, canonical_root, name, description, paths, icon, color,
          created_at, last_seen_at
        ) VALUES (
          @project_id, @canonical_root, @name, @description, @paths, @icon, @color,
          @created_at, @last_seen_at
        )`,
      )
      .run({
        project_id: projectId,
        canonical_root: input.canonical_root,
        name: input.name ?? '',
        description: input.description ?? null,
        paths: input.paths ?? '[]',
        icon: input.icon ?? null,
        color: input.color ?? null,
        created_at: input.created_at ?? now,
        last_seen_at: input.last_seen_at ?? now,
      });
    return this.get(projectId)!;
  }

  get(projectId: string): ProjectRow | null {
    if (!projectId || typeof projectId !== 'string') return null;
    const row = this.db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) as
      | ProjectRow
      | undefined;
    return row ?? null;
  }

  getByCanonicalRoot(canonicalRoot: string): ProjectRow | null {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE canonical_root = ?')
      .get(canonicalRoot) as ProjectRow | undefined;
    return row ?? null;
  }

  getByCoordinatorSession(sessionId: string): ProjectRow | null {
    if (!sessionId) return null;
    const row = this.db.prepare('SELECT * FROM projects WHERE coordinator_session_id = ? ORDER BY last_seen_at DESC LIMIT 1')
      .get(sessionId) as ProjectRow | undefined;
    return row ?? null;
  }

  /** Full scan over `paths` for a matching normalized path (small table). */
  findByPath(path: string): ProjectRow | null {
    const rows = this.db
      .prepare('SELECT * FROM projects')
      .all() as ProjectRow[];
    return rows.find((row) =>
      parseProjectPaths(row.paths).some((entry) => entry.path === path),
    ) ?? null;
  }

  list(opts?: { orderBy?: 'created_at' | 'last_seen_at' }): ProjectRow[] {
    const orderBy = opts?.orderBy ?? 'created_at';
    return this.db
      .prepare(`SELECT * FROM projects ORDER BY ${orderBy}`)
      .all() as ProjectRow[];
  }

  update(projectId: string, patch: UpdateProjectInput): boolean {
    const sets: string[] = [];
    const params: Record<string, unknown> = { project_id: projectId };
    if (typeof patch.name === 'string') {
      sets.push('name = @name');
      params.name = patch.name;
    }
    if (patch.description !== undefined) {
      sets.push('description = @description');
      params.description = patch.description;
    }
    if (patch.paths !== undefined) {
      sets.push('paths = @paths');
      params.paths = patch.paths;
    }
    if (patch.canonical_root !== undefined) {
      sets.push('canonical_root = @canonical_root');
      params.canonical_root = patch.canonical_root;
    }
    if (patch.icon !== undefined) {
      sets.push('icon = @icon');
      params.icon = patch.icon;
    }
    if (patch.color !== undefined) {
      sets.push('color = @color');
      params.color = patch.color;
    }
    if (sets.length === 0) return this.get(projectId) !== null;
    const r = this.db
      .prepare(`UPDATE projects SET ${sets.join(', ')} WHERE project_id = @project_id`)
      .run(params);
    return Number(r.changes) > 0;
  }

  touch(projectId: string, at = Date.now()): void {
    this.db.prepare('UPDATE projects SET last_seen_at = ? WHERE project_id = ?').run(at, projectId);
  }

  /** Append a path entry to a project's `paths` JSON if not already present. */
  appendPath(projectId: string, path: string): void {
    const row = this.get(projectId);
    if (!row) return;
    const entries = projectPaths(row);
    if (entries.some((entry) => entry.path === path)) return;
    entries.push({ path, description: null });
    this.db
      .prepare('UPDATE projects SET paths = ? WHERE project_id = ?')
      .run(serializeProjectPaths(entries), projectId);
  }

  delete(projectId: string): boolean {
    return this.db.transaction(() => {
      // Keep the link store usable in isolated ProjectStore databases too;
      // Task and Session tables are owned by separate aggregates and may not
      // exist in migration rehearsals/imports.
      this.db.prepare('DELETE FROM project_task_sessions WHERE project_id = ?').run(projectId);
      const r = this.db.prepare('DELETE FROM projects WHERE project_id = ?').run(projectId);
      return Number(r.changes) > 0;
    })();
  }

  bindCoordinatorSession(projectId: string, sessionId: string): ProjectRow | null {
    const row = this.db.prepare('SELECT project_id FROM projects WHERE project_id = ?').get(projectId);
    if (!row) return null;
    this.db.prepare('UPDATE projects SET coordinator_session_id = ? WHERE project_id = ?').run(sessionId, projectId);
    return this.get(projectId);
  }

  listTaskLinks(projectId: string): ProjectTaskLinkRow[] {
    return this.db.prepare('SELECT * FROM project_task_sessions WHERE project_id = ? ORDER BY updated_at DESC, task_id')
      .all(projectId) as ProjectTaskLinkRow[];
  }

  getTaskLink(taskId: string): ProjectTaskLinkRow | null {
    return (this.db.prepare('SELECT * FROM project_task_sessions WHERE task_id = ?').get(taskId) as ProjectTaskLinkRow | undefined) ?? null;
  }

  /** The newest link that dispatched the given work Session, if any. */
  getTaskLinkByWorkSession(workSessionId: string): ProjectTaskLinkRow | null {
    return (this.db.prepare('SELECT * FROM project_task_sessions WHERE work_session_id = ? ORDER BY updated_at DESC LIMIT 1')
      .get(workSessionId) as ProjectTaskLinkRow | undefined) ?? null;
  }

  bindTask(projectId: string, taskId: string, coordinatorSessionId: string): ProjectTaskLinkRow {
    const now = Date.now();
    const bind = this.db.transaction((): ProjectTaskLinkRow => {
      const existing = this.db.prepare('SELECT * FROM project_task_sessions WHERE task_id = ?').get(taskId) as ProjectTaskLinkRow | undefined;
      if (existing) {
        if (existing.project_id !== projectId || existing.coordinator_session_id !== coordinatorSessionId) {
          throw new Error(`Task "${taskId}" is already bound to a different Project coordinator`);
        }
        return existing;
      }
      this.db.prepare(`INSERT INTO project_task_sessions
        (project_id, task_id, coordinator_session_id, work_session_id, updated_at)
        VALUES (?, ?, ?, NULL, ?)`)
        .run(projectId, taskId, coordinatorSessionId, now);
      this.appendActivity({ project_id: projectId, event_type: 'task.bound', task_id: taskId, session_id: null,
        run_id: null, source_type: 'session', source_id: coordinatorSessionId, payload: '{}' });
      return this.db.prepare('SELECT * FROM project_task_sessions WHERE task_id = ?').get(taskId) as ProjectTaskLinkRow;
    });
    return bind();
  }

  bindWorkSession(projectId: string, taskId: string, workSessionId: string): ProjectTaskLinkRow | null {
    const now = Date.now();
    const result = this.db.transaction(() => {
      const updated = this.db.prepare(`UPDATE project_task_sessions SET work_session_id = ?, updated_at = ?
        WHERE project_id = ? AND task_id = ?`).run(workSessionId, now, projectId, taskId);
      if (updated.changes) this.appendActivity({ project_id: projectId, event_type: 'task.work_session_bound', task_id: taskId,
        session_id: workSessionId, run_id: null, source_type: 'session', source_id: workSessionId, payload: '{}' });
      return updated;
    })();
    return result.changes ? this.db.prepare('SELECT * FROM project_task_sessions WHERE task_id = ?').get(taskId) as ProjectTaskLinkRow : null;
  }

  setTaskAcceptance(projectId: string, taskId: string, status: ProjectTaskLinkRow['acceptance_status'], sourceType: string, sourceId: string): ProjectTaskLinkRow | null {
    const result = this.db.transaction(() => {
      const updated = this.db.prepare('UPDATE project_task_sessions SET acceptance_status = ?, updated_at = ? WHERE project_id = ? AND task_id = ?')
        .run(status, Date.now(), projectId, taskId);
      if (updated.changes) this.appendActivity({ project_id: projectId, event_type: `task.${status}`, task_id: taskId,
        session_id: null, run_id: null, source_type: sourceType, source_id: sourceId, payload: JSON.stringify({ acceptanceStatus: status }) });
      return updated;
    })();
    return result.changes ? this.db.prepare('SELECT * FROM project_task_sessions WHERE project_id = ? AND task_id = ?').get(projectId, taskId) as ProjectTaskLinkRow : null;
  }

  getContinuityState(projectId: string): { project_id: string; revision: number; current_state: string; next_step: string; source_type: string; source_id: string; updated_at: number } | null {
    return (this.db.prepare('SELECT * FROM project_continuity_state WHERE project_id = ?').get(projectId) as ReturnType<ProjectStore['getContinuityState']>) ?? null;
  }

  updateContinuityState(input: { projectId: string; expectedRevision: number; currentState: string; nextStep: string; sourceType: string; sourceId: string }): { revision: number; updatedAt: number } | null {
    return this.db.transaction(() => {
      const now = Date.now();
      const existing = this.getContinuityState(input.projectId);
      if ((existing?.revision ?? 0) !== input.expectedRevision) return null;
      const revision = input.expectedRevision + 1;
      this.db.prepare(`INSERT INTO project_continuity_state
      (project_id, revision, current_state, next_step, source_type, source_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,
        current_state=excluded.current_state, next_step=excluded.next_step,
        source_type=excluded.source_type, source_id=excluded.source_id, updated_at=excluded.updated_at`)
        .run(input.projectId, revision, input.currentState, input.nextStep, input.sourceType, input.sourceId, now);
      this.appendActivity({ project_id: input.projectId, event_type: 'state.updated', task_id: null, session_id: null,
        run_id: null, source_type: input.sourceType, source_id: input.sourceId, payload: JSON.stringify({ revision }) });
      return { revision, updatedAt: now };
    })();
  }

  listDecisions(projectId: string) { return this.db.prepare('SELECT * FROM project_decisions WHERE project_id = ? ORDER BY updated_at DESC, decision_key').all(projectId) as ProjectDecisionRow[]; }
  upsertDecision(input: Omit<ProjectDecisionRow, 'revision' | 'updated_at'> & { expectedRevision: number }): ProjectDecisionRow | null {
    return this.db.transaction(() => {
      const prior = this.db.prepare('SELECT revision FROM project_decisions WHERE project_id = ? AND decision_key = ?').get(input.project_id, input.decision_key) as { revision: number } | undefined;
      if ((prior?.revision ?? 0) !== input.expectedRevision) return null;
      const now = Date.now(), revision = input.expectedRevision + 1;
      this.db.prepare(`INSERT INTO project_decisions(project_id,decision_key,content,status,revision,source_type,source_id,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,decision_key) DO UPDATE SET content=excluded.content,
      status=excluded.status,revision=excluded.revision,source_type=excluded.source_type,source_id=excluded.source_id,updated_at=excluded.updated_at`)
        .run(input.project_id,input.decision_key,input.content,input.status,revision,input.source_type,input.source_id,now);
      this.db.prepare(`INSERT INTO project_decision_history(project_id,decision_key,revision,content,status,source_type,source_id,updated_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(input.project_id,input.decision_key,revision,input.content,input.status,input.source_type,input.source_id,now);
      this.appendActivity({ project_id: input.project_id, event_type: `decision.${input.status}`, task_id: null, session_id: null,
        run_id: null, source_type: input.source_type, source_id: input.source_id, payload: JSON.stringify({ key: input.decision_key, revision }) });
      return this.db.prepare('SELECT * FROM project_decisions WHERE project_id = ? AND decision_key = ?').get(input.project_id,input.decision_key) as ProjectDecisionRow;
    })();
  }
  listMemories(projectId: string, limit = 30) { return this.db.prepare('SELECT * FROM project_memories WHERE project_id = ? AND status IN (\'candidate\',\'active\') ORDER BY CASE status WHEN \'active\' THEN 0 ELSE 1 END, updated_at DESC, memory_key LIMIT ?').all(projectId, Math.max(1, Math.min(100, limit))) as ProjectMemoryRow[]; }
  upsertMemory(input: Omit<ProjectMemoryRow, 'revision' | 'updated_at'> & { expectedRevision: number }): ProjectMemoryRow | null {
    return this.db.transaction(() => {
      const prior = this.db.prepare('SELECT revision FROM project_memories WHERE project_id = ? AND memory_key = ?').get(input.project_id, input.memory_key) as { revision: number } | undefined;
      if ((prior?.revision ?? 0) !== input.expectedRevision) return null;
      const now = Date.now(), revision = input.expectedRevision + 1;
      this.db.prepare(`INSERT INTO project_memories(project_id,memory_key,content,status,revision,source_type,source_id,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,memory_key) DO UPDATE SET content=excluded.content,
      status=excluded.status,revision=excluded.revision,source_type=excluded.source_type,source_id=excluded.source_id,updated_at=excluded.updated_at`)
        .run(input.project_id,input.memory_key,input.content,input.status,revision,input.source_type,input.source_id,now);
      this.db.prepare(`INSERT INTO project_memory_history(project_id,memory_key,revision,content,status,source_type,source_id,updated_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(input.project_id,input.memory_key,revision,input.content,input.status,input.source_type,input.source_id,now);
      this.appendActivity({ project_id: input.project_id, event_type: `memory.${input.status}`, task_id: null, session_id: null,
        run_id: null, source_type: input.source_type, source_id: input.source_id, payload: JSON.stringify({ key: input.memory_key, revision }) });
      return this.db.prepare('SELECT * FROM project_memories WHERE project_id = ? AND memory_key = ?').get(input.project_id,input.memory_key) as ProjectMemoryRow;
    })();
  }
  listMemoryHistory(projectId: string, memoryKey: string, limit = 20) {
    return this.db.prepare('SELECT * FROM project_memory_history WHERE project_id = ? AND memory_key = ? ORDER BY revision DESC LIMIT ?')
      .all(projectId, memoryKey, Math.max(1, Math.min(100, limit))) as Array<ProjectMemoryRow>;
  }
  listDecisionHistory(projectId: string, decisionKey: string, limit = 20) {
    return this.db.prepare('SELECT * FROM project_decision_history WHERE project_id = ? AND decision_key = ? ORDER BY revision DESC LIMIT ?')
      .all(projectId, decisionKey, Math.max(1, Math.min(100, limit))) as Array<ProjectDecisionRow>;
  }
  appendActivity(input: Omit<ProjectActivityRow, 'event_id' | 'created_at'>): ProjectActivityRow {
    const now = Date.now();
    const result = this.db.prepare(`INSERT INTO project_activity(project_id,event_type,task_id,session_id,run_id,source_type,source_id,payload,created_at)
      VALUES(@project_id,@event_type,@task_id,@session_id,@run_id,@source_type,@source_id,@payload,@created_at)`).run({...input, created_at: now});
    return this.db.prepare('SELECT * FROM project_activity WHERE event_id = ?').get(Number(result.lastInsertRowid)) as ProjectActivityRow;
  }
  /**
   * Append an activity row unless `(project, event_type, source)` already has
   * one. The live settlement hook and a restart reconciliation both call this,
   * so the second caller must observe `created: false` rather than duplicate
   * the project's history.
   */
  appendActivityOnce(input: Omit<ProjectActivityRow, 'event_id' | 'created_at'>): { row: ProjectActivityRow; created: boolean } {
    return this.db.transaction(() => {
      const existing = this.db.prepare(
        'SELECT * FROM project_activity WHERE project_id = ? AND event_type = ? AND source_type = ? AND source_id = ? ORDER BY event_id LIMIT 1',
      ).get(input.project_id, input.event_type, input.source_type, input.source_id) as ProjectActivityRow | undefined;
      if (existing) return { row: existing, created: false };
      return { row: this.appendActivity(input), created: true };
    })();
  }
  listActivity(projectId: string, after = 0, limit = 50) {
    return this.db.prepare('SELECT * FROM project_activity WHERE project_id = ? AND event_id > ? ORDER BY event_id LIMIT ?')
      .all(projectId, Math.max(0, after), Math.max(1, Math.min(100, limit))) as ProjectActivityRow[];
  }
  listRecentActivity(projectId: string, limit = 10) {
    return this.db.prepare('SELECT * FROM project_activity WHERE project_id = ? ORDER BY event_id DESC LIMIT ?')
      .all(projectId, Math.max(1, Math.min(50, limit))).reverse() as ProjectActivityRow[];
  }

  // ─── project_bots ───

  addBot(projectId: string, botId: string, joinedAt = Date.now()): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO project_bots (project_id, bot_id, joined_at) VALUES (?, ?, ?)',
      )
      .run(projectId, botId, joinedAt);
  }

  removeBot(projectId: string, botId: string): void {
    this.db
      .prepare('DELETE FROM project_bots WHERE project_id = ? AND bot_id = ?')
      .run(projectId, botId);
  }

  listBotsByProject(projectId: string): ProjectBotRow[] {
    return this.db
      .prepare('SELECT * FROM project_bots WHERE project_id = ? ORDER BY bot_id')
      .all(projectId) as ProjectBotRow[];
  }

  deleteBotsByProject(projectId: string): void {
    this.db.prepare('DELETE FROM project_bots WHERE project_id = ?').run(projectId);
  }
}

