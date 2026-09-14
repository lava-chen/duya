/**
 * project-store.ts — ProjectStore aggregate for `duya-core.db` (plan 534).
 *
 * `projects` / `project_bots` were misplaced in `memory-state.db` (plan 525).
 * This store is the canonical home: DDL migration id 18 plus typed CRUD and
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

import type { Migration, SqliteDatabase } from './database';

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
  /** Migration id=18: create projects + project_bots. */
  static readonly migrations: Migration[] = [
    {
      id: 18,
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
    const projectId = input.project_id ?? cryptoRandomUuid();
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
    const r = this.db.prepare('DELETE FROM projects WHERE project_id = ?').run(projectId);
    return Number(r.changes) > 0;
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

// RandomUUID shared with node:crypto (better-sqlite3 target is CommonJS/Electron).
let _crypto: typeof import('node:crypto') | null = null;
function cryptoRandomUuid(): string {
  const c = _crypto ?? (require('node:crypto') as typeof import('node:crypto'));
  _crypto ??= c;
  return c.randomUUID();
}