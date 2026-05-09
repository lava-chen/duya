/**
 * db-handlers.ts - Database Gateway for Electron Main Process (The Ledger)
 *
 * All database access MUST go through this module. This ensures:
 * 1. Single database connection (no concurrent access issues)
 * 2. Permission control and audit logging
 * 3. Unified schema management
 * 4. Database path resolved from boot.json (The Compass)
 *
 * Database file: duya-main.db (stored in path from boot.json)
 * Uses WAL mode for read/write concurrency.
 * Safe Mode: If database path is invalid, returns error instead of crashing.
 */

import { ipcMain, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { createRequire } from 'module';
import { randomUUID } from 'crypto';
import { getAgentProcessPool } from './agent-process-pool.js';
import { getAutomationScheduler } from './automation/Scheduler.js';
import { getLogger, LogComponent } from './logger.js';
import { getChannelManager } from './message-port-manager.js';
import {
  resolveDatabasePath,
  validateDatabasePath,
  initBootConfig,
  renameLegacyDatabase,
  updateDatabasePath,
  readBootConfig,
} from './boot-config';

type BetterSqlite3 = import('better-sqlite3').default;

let BetterSqlite3Ctor: typeof import('better-sqlite3').default;
let db: BetterSqlite3 | null = null;
let safeModeReason: string | null = null;

// Module-level logger instance for database operations
const dbLogger = getLogger();

function loadBetterSqlite3(): typeof import('better-sqlite3').default {
  const logger = getLogger();
  if (app.isPackaged) {
    const betterSqlite3Path = path.join(process.resourcesPath, 'better-sqlite3');
    const nativeBindingPath = path.join(betterSqlite3Path, 'build', 'Release', 'better_sqlite3.node');

    logger.info('Loading better-sqlite3', { path: betterSqlite3Path, nativeBinding: nativeBindingPath }, LogComponent.DB);

    // Load from unpacked extraResources path directly.
    // Requiring by package name here fails in production because there is no
    // node_modules tree under resources/better-sqlite3.
    const requireFromPackage = createRequire(path.join(betterSqlite3Path, 'package.json'));
    const BetterSqlite3 = requireFromPackage('./');

    BetterSqlite3Ctor = class extends BetterSqlite3 {
      constructor(filename: string) {
        super(filename, { nativeBinding: nativeBindingPath });
      }
    };

    logger.info('better-sqlite3 constructor loaded with custom nativeBinding', undefined, LogComponent.DB);
    return BetterSqlite3Ctor;
  } else {
    BetterSqlite3Ctor = require('better-sqlite3');
    return BetterSqlite3Ctor;
  }
}

// ============================================================
// Database Initialization (with Safe Mode support)
// ============================================================

export interface DbInitResult {
  success: boolean;
  dbPath?: string;
  error?: string;
  safeMode?: boolean;
}

/**
 * Initialize database using path from boot.json.
 * Implements Defense 2 (Safe Mode): if DB path is invalid, returns error
 * instead of crashing the app.
 */
export function initDatabaseFromBoot(): DbInitResult {
  const logger = getLogger();
  if (db) {
    return { success: true, dbPath: getDatabasePath() };
  }

  // Step 1: Resolve database path from boot.json
  const { dbPath, needsBootWrite, needsDbRename } = resolveDatabasePath();
  logger.info('Resolved database path', { dbPath }, LogComponent.DB);

  // Step 2: Handle legacy duya.db -> duya-main.db rename
  if (needsDbRename) {
    const renamed = renameLegacyDatabase(dbPath);
    if (renamed) {
      logger.info('Renamed legacy database file', undefined, LogComponent.DB);
    }
  }

  // Step 3: Validate the database path
  const validation = validateDatabasePath(dbPath);
  if (!validation.valid) {
    logger.error('Database path validation failed', new Error(validation.reason), { dbPath }, LogComponent.DB);
    safeModeReason = validation.reason;
    return {
      success: false,
      dbPath,
      error: validation.reason,
      safeMode: true,
    };
  }

  // Step 4: Write boot.json if needed (first run or migration)
  if (needsBootWrite) {
    initBootConfig(dbPath);
  }

  // Step 5: Initialize the database
  try {
    if (!BetterSqlite3Ctor) {
      BetterSqlite3Ctor = loadBetterSqlite3();
    }

    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      logger.info('Creating directory', { dbDir }, LogComponent.DB);
      fs.mkdirSync(dbDir, { recursive: true });
    }

    db = new BetterSqlite3Ctor(dbPath);
    logger.info('Database opened successfully', { dbPath }, LogComponent.DB);

    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');

    initializeSchema(db);

    safeModeReason = null;
    return { success: true, dbPath };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error('Failed to initialize database', error instanceof Error ? error : new Error(errorMsg), { dbPath }, LogComponent.DB);
    safeModeReason = errorMsg;
    return {
      success: false,
      dbPath,
      error: errorMsg,
      safeMode: true,
    };
  }
}

/**
 * Legacy initDatabase function - kept for backward compatibility.
 * Now delegates to initDatabaseFromBoot().
 */
export function initDatabase(dbDir: string): BetterSqlite3 {
  const logger = getLogger();
  if (db) return db;

  if (!BetterSqlite3Ctor) {
    BetterSqlite3Ctor = loadBetterSqlite3();
  }

  const dbPath = path.join(dbDir, 'duya-main.db');

  // Also check for old duya.db
  const oldDbPath = path.join(dbDir, 'duya.db');
  if (fs.existsSync(oldDbPath) && !fs.existsSync(dbPath)) {
    fs.renameSync(oldDbPath, dbPath);
    const oldWal = oldDbPath + '-wal';
    const newWal = dbPath + '-wal';
    if (fs.existsSync(oldWal)) fs.renameSync(oldWal, newWal);
    const oldShm = oldDbPath + '-shm';
    const newShm = dbPath + '-shm';
    if (fs.existsSync(oldShm)) fs.renameSync(oldShm, newShm);
    logger.info('Renamed legacy duya.db to duya-main.db', undefined, LogComponent.DB);
  }

  logger.info('Initializing database', { dbPath }, LogComponent.DB);

  if (!fs.existsSync(dbDir)) {
    logger.info('Creating directory', { dbDir }, LogComponent.DB);
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new BetterSqlite3Ctor(dbPath);
  logger.info('Database opened successfully', { dbPath }, LogComponent.DB);

  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  initializeSchema(db);

  return db;
}

export function getDatabase(): BetterSqlite3 | null {
  return db;
}

export function getDatabasePath(): string {
  if (db) {
    return db.name;
  }
  return resolveDatabasePath().dbPath;
}

export function isSafeMode(): boolean {
  return safeModeReason !== null;
}

export function getSafeModeReason(): string | null {
  return safeModeReason;
}

export interface DatabaseStats {
  /** Database file path */
  path: string;
  /** File size in bytes */
  sizeBytes: number;
  /** File size in human-readable format */
  sizeFormatted: string;
  /** Total message count */
  messageCount: number;
  /** Total session count */
  sessionCount: number;
  /** WAL file size in bytes (0 if WAL not present) */
  walSizeBytes: number;
}

/**
 * Get database file size and message statistics.
 * Returns null if database is not initialized.
 */
export function getDatabaseStats(): DatabaseStats | null {
  if (!db) return null;

  const dbPath = db.name;

  let sizeBytes = 0;
  let walSizeBytes = 0;

  try {
    const stat = fs.statSync(dbPath);
    sizeBytes = stat.size;
  } catch {
    // File may not exist yet
  }

  try {
    const walPath = dbPath + '-wal';
    if (fs.existsSync(walPath)) {
      walSizeBytes = fs.statSync(walPath).size;
    }
  } catch {
    // WAL file may not exist
  }

  let messageCount = 0;
  let sessionCount = 0;

  try {
    const messageRow = db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };
    messageCount = messageRow?.count ?? 0;
  } catch {
    // Table may not exist yet
  }

  try {
    const sessionRow = db.prepare('SELECT COUNT(*) as count FROM chat_sessions').get() as { count: number };
    sessionCount = sessionRow?.count ?? 0;
  } catch {
    // Table may not exist yet
  }

  const totalSize = sizeBytes + walSizeBytes;

  return {
    path: dbPath,
    sizeBytes: totalSize,
    sizeFormatted: formatBytes(totalSize),
    messageCount,
    sessionCount,
    walSizeBytes,
  };
}

/**
 * Check if database size exceeds the recommended threshold.
 * Returns a warning message if threshold exceeded, null otherwise.
 */
export function checkDatabaseSizeWarning(): string | null {
  const stats = getDatabaseStats();
  if (!stats) return null;

  const SIZE_WARNING_THRESHOLD = 100 * 1024 * 1024; // 100 MB

  if (stats.sizeBytes > SIZE_WARNING_THRESHOLD) {
    return `Database size (${stats.sizeFormatted}) exceeds 100MB. Consider running VACUUM to reclaim space. Messages: ${stats.messageCount}, Sessions: ${stats.sessionCount}`;
  }

  return null;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(1)} ${units[i]}`;
}

function initializeSchema(db: BetterSqlite3): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
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
      parent_id TEXT REFERENCES chat_sessions(id),
      agent_type TEXT NOT NULL DEFAULT 'main',
      agent_name TEXT NOT NULL DEFAULT ''
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      system_prompt TEXT,
      prompt_base_mode TEXT DEFAULT 'full',
      prompt_overlays TEXT,
      tool_profile_id TEXT DEFAULT 'full',
      allowed_tools TEXT,
      disallowed_tools TEXT,
      default_model TEXT,
      mcp_servers TEXT,
      skills TEXT,
      memory_space_id TEXT,
      share_global_memory INTEGER DEFAULT 1,
      identity_name TEXT,
      identity_emoji TEXT,
      identity_avatar_url TEXT,
      identity_theme_color TEXT,
      subagent_allow_agent_types TEXT,
      subagent_max_spawn_depth INTEGER DEFAULT 1,
      subagent_max_concurrent INTEGER DEFAULT 3,
      is_preset INTEGER DEFAULT 0,
      is_enabled INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      allowed_tool_groups TEXT,
      denied_tool_groups TEXT,
      is_preset INTEGER DEFAULT 0
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
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
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS session_runtime_locks (
      session_id TEXT PRIMARY KEY,
      lock_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS permission_requests (
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
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
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
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_bindings (
      id TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      duya_session_id TEXT NOT NULL,
      sdk_session_id TEXT NOT NULL DEFAULT '',
      working_directory TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'code',
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_offsets (
      channel_type TEXT NOT NULL,
      offset_key TEXT NOT NULL,
      offset_value TEXT NOT NULL,
      offset_type TEXT NOT NULL DEFAULT 'long_polling',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (channel_type, offset_key)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_permission_links (
      permission_request_id TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL DEFAULT '',
      tool_name TEXT NOT NULL DEFAULT '',
      suggestions TEXT NOT NULL DEFAULT '[]',
      resolved INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS weixin_accounts (
      account_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      base_url TEXT NOT NULL DEFAULT '',
      cdn_base_url TEXT NOT NULL DEFAULT '',
      token TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 0,
      last_login_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS weixin_context_tokens (
      account_id TEXT NOT NULL,
      peer_user_id TEXT NOT NULL,
      context_token TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, peer_user_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_crons (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      schedule_kind TEXT NOT NULL CHECK(schedule_kind IN ('at', 'every', 'cron')),
      schedule_at TEXT,
      schedule_every_ms INTEGER,
      schedule_cron_expr TEXT,
      schedule_cron_tz TEXT,
      workflow_id TEXT,
      prompt TEXT NOT NULL DEFAULT '',
      input_params TEXT NOT NULL DEFAULT '{}',
      session_target TEXT NOT NULL DEFAULT 'isolated' CHECK(session_target IN ('isolated')),
      delivery_mode TEXT NOT NULL DEFAULT 'none' CHECK(delivery_mode IN ('none')),
      status TEXT NOT NULL DEFAULT 'enabled' CHECK(status IN ('enabled', 'disabled', 'error')),
      model TEXT NOT NULL,
      last_run_at INTEGER,
      next_run_at INTEGER,
      last_error TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      concurrency_policy TEXT NOT NULL DEFAULT 'skip' CHECK(concurrency_policy IN ('skip', 'parallel', 'queue', 'replace')),
      max_retries INTEGER NOT NULL DEFAULT 3,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_cron_runs (
      id TEXT PRIMARY KEY,
      cron_id TEXT NOT NULL,
      run_status TEXT NOT NULL CHECK(run_status IN ('pending', 'running', 'success', 'failed', 'cancelled')),
      started_at INTEGER,
      ended_at INTEGER,
      output TEXT,
      error_message TEXT,
      logs TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (cron_id) REFERENCES automation_crons(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conductor_canvases (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      layout_config TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conductor_widgets (
      id TEXT PRIMARY KEY,
      canvas_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      type TEXT NOT NULL,
      position TEXT NOT NULL,
      config TEXT NOT NULL,
      data TEXT NOT NULL,
      data_version INTEGER NOT NULL DEFAULT 1,
      source_code TEXT,
      state TEXT NOT NULL DEFAULT 'idle',
      permissions TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (canvas_id) REFERENCES conductor_canvases(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conductor_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canvas_id TEXT NOT NULL,
      widget_id TEXT,
      actor TEXT NOT NULL,
      action_type TEXT NOT NULL,
      payload TEXT,
      result_patch TEXT,
      merged_from TEXT,
      reversible INTEGER NOT NULL DEFAULT 1,
      ts INTEGER NOT NULL,
      undone_at INTEGER,
      FOREIGN KEY (canvas_id) REFERENCES conductor_canvases(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conductor_elements (
      id TEXT PRIMARY KEY,
      canvas_id TEXT NOT NULL,
      element_kind TEXT NOT NULL,
      position TEXT NOT NULL DEFAULT '{"x":0,"y":0,"w":4,"h":3,"zIndex":0,"rotation":0}',
      config TEXT NOT NULL DEFAULT '{}',
      viz_spec TEXT,
      source_code TEXT,
      state TEXT NOT NULL DEFAULT 'idle',
      data_version INTEGER NOT NULL DEFAULT 1,
      permissions TEXT NOT NULL DEFAULT '{"agentCanRead":true,"agentCanWrite":true,"agentCanDelete":false}',
      metadata TEXT NOT NULL DEFAULT '{"label":"","tags":[],"createdBy":"user"}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (canvas_id) REFERENCES conductor_canvases(id) ON DELETE CASCADE
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON chat_sessions(updated_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_working_directory ON chat_sessions(working_directory)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_permission_requests_session ON permission_requests(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);

  // Migration: add owner, metadata columns for existing databases
  try { db.exec(`ALTER TABLE tasks ADD COLUMN owner TEXT`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE tasks ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'`); } catch { /* already exists */ }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_channel_bindings_active ON channel_bindings(channel_type, active)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_channel_offsets_updated ON channel_offsets(updated_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_automation_crons_status ON automation_crons(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_automation_crons_next_run ON automation_crons(next_run_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_automation_cron_runs_cron ON automation_cron_runs(cron_id, created_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conductor_widgets_canvas ON conductor_widgets(canvas_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conductor_actions_canvas_ts ON conductor_actions(canvas_id, ts)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conductor_actions_widget_ts ON conductor_actions(widget_id, ts)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conductor_actions_undone ON conductor_actions(undone_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_elements_canvas ON conductor_elements(canvas_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_elements_kind ON conductor_elements(element_kind)`);

  // Gateway tables: platform user → session mapping, message tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_user_map (
      id                TEXT PRIMARY KEY,
      platform          TEXT NOT NULL,
      platform_user_id  TEXT NOT NULL,
      platform_chat_id  TEXT NOT NULL,
      session_id        TEXT NOT NULL,
      linked_user_id    TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      UNIQUE(platform, platform_chat_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_message_map (
      platform          TEXT NOT NULL,
      platform_msg_id   TEXT NOT NULL,
      duya_message_id   TEXT NOT NULL,
      session_id        TEXT NOT NULL,
      direction         TEXT NOT NULL DEFAULT 'inbound',
      created_at        INTEGER NOT NULL,
      PRIMARY KEY(platform, platform_msg_id)
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_gateway_user_map_session ON gateway_user_map(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_gateway_user_map_platform ON gateway_user_map(platform, platform_chat_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_gateway_message_map_session ON gateway_message_map(session_id)`);

  initializeFts5(db);

  const insertSetting = db.prepare(`
    INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)
  `);
  insertSetting.run('theme', 'dark', Date.now());
  insertSetting.run('collapsedProjects', '[]', Date.now());
  insertSetting.run('remote_bridge_enabled', 'false', Date.now());
  insertSetting.run('bridge_auto_start', 'false', Date.now());
  insertSetting.run('skillNudgeInterval', '10', Date.now());
  insertSetting.run('summaryLLMEnabled', 'false', Date.now());
  insertSetting.run('summaryLLMConfig', 'null', Date.now());

  const insertCanvas = db.prepare(`
    INSERT OR IGNORE INTO conductor_canvases (id, name, description, layout_config, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  insertCanvas.run('default', '工作台', null, '{}', 0, now, now);

  runMigrations(db);
}

function initializeFts5(db: Database.Database): void {
  const logger = getLogger();
  try {
    const fts5Available = db.prepare(
      "SELECT 1 FROM pragma_compile_options WHERE compile_options = 'ENABLE_FTS5'"
    ).get();
    if (!fts5Available) {
      logger.info('FTS5 not available, session search will use LIKE fallback', undefined, LogComponent.DB);
      return;
    }

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        session_id,
        content,
        tokenize='porter unicode61'
      )
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages WHEN new.msg_type IN ('text', 'tool_result') BEGIN
        INSERT INTO messages_fts(rowid, session_id, content)
        VALUES (new.rowid, new.session_id, new.content);
      END
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages WHEN old.msg_type IN ('text', 'tool_result') BEGIN
        DELETE FROM messages_fts WHERE rowid = old.rowid;
      END
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages WHEN old.msg_type IN ('text', 'tool_result') OR new.msg_type IN ('text', 'tool_result') BEGIN
        DELETE FROM messages_fts WHERE rowid = old.rowid;
        INSERT INTO messages_fts(rowid, session_id, content)
        VALUES (new.rowid, new.session_id, new.content);
      END
    `);
  } catch (error) {
    logger.error('Failed to initialize FTS5', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.DB);
  }
}

// ============================================================
// Schema Migration System
// ============================================================

interface AppliedMigration {
  id: number;
  name: string;
  applied_at: number;
}

interface Migration {
  id: number;
  name: string;
  migrate: (db: Database.Database) => void;
}

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') * 1000 AS INTEGER))
    )
  `);
}

function isMigrationApplied(db: Database.Database, migrationId: number): boolean {
  const result = db.prepare('SELECT id FROM _schema_migrations WHERE id = ?').get(migrationId);
  return !!result;
}

function markMigrationApplied(db: Database.Database, migration: Migration): void {
  db.prepare('INSERT OR IGNORE INTO _schema_migrations (id, name, applied_at) VALUES (?, ?, ?)')
    .run(migration.id, migration.name, Date.now());
}

const migrations: Migration[] = [
  {
    id: 1,
    name: 'ensure_chat_sessions_columns',
    migrate: (db) => {
      const tableInfo = db.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>;
      const columns = tableInfo.map(col => col.name);

      if (!columns.includes('permission_profile')) {
        db.exec(`ALTER TABLE chat_sessions ADD COLUMN permission_profile TEXT NOT NULL DEFAULT 'default'`);
      }
      if (!columns.includes('generation')) {
        db.exec(`ALTER TABLE chat_sessions ADD COLUMN generation INTEGER NOT NULL DEFAULT 0`);
      }
      if (!columns.includes('context_summary')) {
        db.exec(`ALTER TABLE chat_sessions ADD COLUMN context_summary TEXT NOT NULL DEFAULT ''`);
      }
      if (!columns.includes('context_summary_updated_at')) {
        db.exec(`ALTER TABLE chat_sessions ADD COLUMN context_summary_updated_at INTEGER NOT NULL DEFAULT 0`);
      }
    },
  },
  {
    id: 2,
    name: 'ensure_messages_columns',
    migrate: (db) => {
      const tableInfo = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
      const columns = tableInfo.map(col => col.name);

      if (!columns.includes('name')) {
        db.exec(`ALTER TABLE messages ADD COLUMN name TEXT`);
      }
      if (!columns.includes('tool_call_id')) {
        db.exec(`ALTER TABLE messages ADD COLUMN tool_call_id TEXT`);
      }
      if (!columns.includes('token_usage')) {
        db.exec(`ALTER TABLE messages ADD COLUMN token_usage TEXT`);
      }
    },
  },
  {
    id: 3,
    name: 'create_session_runtime_locks',
    migrate: (db) => {
      const tableExists = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='session_runtime_locks'
      `).get();

      if (!tableExists) {
        db.exec(`
          CREATE TABLE session_runtime_locks (
            session_id TEXT PRIMARY KEY,
            lock_id TEXT NOT NULL,
            owner TEXT NOT NULL,
            expires_at INTEGER NOT NULL
          )
        `);
      }
    },
  },
  {
    id: 4,
    name: 'ensure_fts_triggers',
    migrate: (db) => {
      try {
        const fts5Available = db.prepare(
          "SELECT 1 FROM pragma_compile_options WHERE compile_options = 'ENABLE_FTS5'"
        ).get();
        if (!fts5Available) {
          return;
        }

        db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            session_id,
            content,
            tokenize='porter unicode61'
          )
        `);

        db.exec(`
          CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages WHEN new.role = 'user' BEGIN
            INSERT INTO messages_fts(rowid, session_id, content)
            VALUES (new.rowid, new.session_id, new.content);
          END
        `);

        db.exec(`
          CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages WHEN old.role = 'user' BEGIN
            DELETE FROM messages_fts WHERE rowid = old.rowid;
          END
        `);

        db.exec(`
          CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages WHEN old.role = 'user' OR new.role = 'user' BEGIN
            DELETE FROM messages_fts WHERE rowid = old.rowid;
            INSERT INTO messages_fts(rowid, session_id, content)
            VALUES (new.rowid, new.session_id, new.content);
          END
        `);

        const ftsCount = db.prepare('SELECT COUNT(*) as cnt FROM messages_fts').get() as { cnt: number };
        if (ftsCount.cnt === 0) {
          db.exec(`
            INSERT INTO messages_fts(rowid, session_id, content)
            SELECT rowid, session_id, content FROM messages WHERE role = 'user'
          `);
        }
      } catch {
        // FTS5 is optional, ignore errors
      }
    },
  },
  {
    id: 5,
    name: 'ensure_indexes',
    migrate: (db) => {
      const indexes = [
        'CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id)',
        'CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)',
        'CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON chat_sessions(updated_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_sessions_working_directory ON chat_sessions(working_directory)',
        'CREATE INDEX IF NOT EXISTS idx_permission_requests_session ON permission_requests(session_id)',
        'CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id)',
        'CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)',
        'CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner)',
        'CREATE INDEX IF NOT EXISTS idx_channel_bindings_active ON channel_bindings(channel_type, active)',
        'CREATE INDEX IF NOT EXISTS idx_channel_offsets_updated ON channel_offsets(updated_at)',
      ];

      for (const idx of indexes) {
        try {
          db.exec(idx);
        } catch {
          // Index may already exist, ignore
        }
      }
    },
  },
  {
    id: 6,
    name: 'drop_api_providers_table',
    migrate: (db) => {
      db.exec('DROP TABLE IF EXISTS api_providers');
    },
  },
  {
    id: 7,
    name: 'add_message_structured_fields',
    migrate: (db) => {
      const tableInfo = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
      const columns = tableInfo.map(col => col.name);

      const newColumns: Array<{ name: string; def: string }> = [
        { name: 'msg_type', def: "TEXT NOT NULL DEFAULT 'text'" },
        { name: 'thinking', def: 'TEXT' },
        { name: 'tool_name', def: 'TEXT' },
        { name: 'tool_input', def: 'TEXT' },
        { name: 'parent_tool_call_id', def: 'TEXT' },
        { name: 'viz_spec', def: 'TEXT' },
        { name: 'status', def: "TEXT NOT NULL DEFAULT 'done'" },
        { name: 'seq_index', def: 'INTEGER' },
        { name: 'duration_ms', def: 'INTEGER' },
        { name: 'sub_agent_id', def: 'TEXT' },
      ];

      for (const col of newColumns) {
        if (!columns.includes(col.name)) {
          db.exec(`ALTER TABLE messages ADD COLUMN ${col.name} ${col.def}`);
        }
      }

      db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_msg_type ON messages(msg_type)`);
    },
  },
  {
    id: 8,
    name: 'update_fts_triggers_for_msg_type',
    migrate: (db) => {
      try {
        const fts5Available = db.prepare(
          "SELECT 1 FROM pragma_compile_options WHERE compile_options = 'ENABLE_FTS5'"
        ).get();
        if (!fts5Available) {
          return;
        }

        db.exec(`DROP TRIGGER IF EXISTS messages_ai`);
        db.exec(`DROP TRIGGER IF EXISTS messages_ad`);
        db.exec(`DROP TRIGGER IF EXISTS messages_au`);

        db.exec(`
          CREATE TRIGGER messages_ai AFTER INSERT ON messages
          WHEN new.msg_type IN ('text', 'tool_result') BEGIN
            INSERT INTO messages_fts(rowid, session_id, content)
            VALUES (new.rowid, new.session_id, new.content);
          END
        `);

        db.exec(`
          CREATE TRIGGER messages_ad AFTER DELETE ON messages
          WHEN old.msg_type IN ('text', 'tool_result') BEGIN
            DELETE FROM messages_fts WHERE rowid = old.rowid;
          END
        `);

        db.exec(`
          CREATE TRIGGER messages_au AFTER UPDATE ON messages
          WHEN old.msg_type IN ('text', 'tool_result') OR new.msg_type IN ('text', 'tool_result') BEGIN
            DELETE FROM messages_fts WHERE rowid = old.rowid;
            INSERT INTO messages_fts(rowid, session_id, content)
            VALUES (new.rowid, new.session_id, new.content);
          END
        `);

        const ftsCount = db.prepare('SELECT COUNT(*) as cnt FROM messages_fts').get() as { cnt: number };
        if (ftsCount.cnt === 0) {
          db.exec(`
            INSERT INTO messages_fts(rowid, session_id, content)
            SELECT rowid, session_id, content FROM messages WHERE msg_type IN ('text', 'tool_result')
          `);
        }
      } catch {
        // FTS5 is optional, ignore errors
      }
    },
  },
  {
    id: 9,
    name: 'cleanup_metadata_messages',
    migrate: (db) => {
      try {
        const metadataPatterns = [
          '{"type":"ready%',
          '{"type":"chat:status%',
          '{"type":"chat:token_usage%',
          '{"type":"chat:context_usage%',
          '{"type":"chat:db_persisted%',
          '{"type":"chat:done%',
          '{"type":"chat:error%',
        ];
        for (const pattern of metadataPatterns) {
          db.prepare(
            "DELETE FROM messages WHERE content LIKE ?"
          ).run(pattern);
        }
        db.prepare(
          "DELETE FROM messages WHERE content LIKE '[thinking] %'"
        ).run();
      } catch {
        // Cleanup is best-effort
      }
    },
  },
  {
    id: 10,
    name: 'fix_fts_triggers_delete_syntax',
    migrate: (db) => {
      try {
        const fts5Available = db.prepare(
          "SELECT 1 FROM pragma_compile_options WHERE compile_options = 'ENABLE_FTS5'"
        ).get();
        if (!fts5Available) {
          return;
        }

        db.exec(`DROP TRIGGER IF EXISTS messages_ai`);
        db.exec(`DROP TRIGGER IF EXISTS messages_ad`);
        db.exec(`DROP TRIGGER IF EXISTS messages_au`);

        db.exec(`
          CREATE TRIGGER messages_ai AFTER INSERT ON messages
          WHEN new.msg_type IN ('text', 'tool_result') BEGIN
            INSERT INTO messages_fts(rowid, session_id, content)
            VALUES (new.rowid, new.session_id, new.content);
          END
        `);

        db.exec(`
          CREATE TRIGGER messages_ad AFTER DELETE ON messages
          WHEN old.msg_type IN ('text', 'tool_result') BEGIN
            DELETE FROM messages_fts WHERE rowid = old.rowid;
          END
        `);

        db.exec(`
          CREATE TRIGGER messages_au AFTER UPDATE ON messages
          WHEN old.msg_type IN ('text', 'tool_result') OR new.msg_type IN ('text', 'tool_result') BEGIN
            DELETE FROM messages_fts WHERE rowid = old.rowid;
            INSERT INTO messages_fts(rowid, session_id, content)
            VALUES (new.rowid, new.session_id, new.content);
          END
        `);
      } catch {
        // FTS5 is optional, ignore errors
      }
    },
  },
  {
    id: 11,
    name: 'add_source_to_chat_sessions',
    migrate: (db) => {
      const tableInfo = db.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>;
      const columns = tableInfo.map(col => col.name);

      if (!columns.includes('source')) {
        db.exec(`ALTER TABLE chat_sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'local'`);
      }
    },
  },
  {
    id: 12,
    name: 'create_automation_cron_tables',
    migrate: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS automation_crons (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          schedule_kind TEXT NOT NULL CHECK(schedule_kind IN ('at', 'every', 'cron')),
          schedule_at TEXT,
          schedule_every_ms INTEGER,
          schedule_cron_expr TEXT,
          schedule_cron_tz TEXT,
          workflow_id TEXT,
          prompt TEXT NOT NULL DEFAULT '',
          input_params TEXT NOT NULL DEFAULT '{}',
          session_target TEXT NOT NULL DEFAULT 'isolated' CHECK(session_target IN ('isolated')),
          delivery_mode TEXT NOT NULL DEFAULT 'none' CHECK(delivery_mode IN ('none')),
          status TEXT NOT NULL DEFAULT 'enabled' CHECK(status IN ('enabled', 'disabled', 'error')),
          last_run_at INTEGER,
          next_run_at INTEGER,
          last_error TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          concurrency_policy TEXT NOT NULL DEFAULT 'skip' CHECK(concurrency_policy IN ('skip', 'parallel', 'queue', 'replace')),
          max_retries INTEGER NOT NULL DEFAULT 3,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS automation_cron_runs (
          id TEXT PRIMARY KEY,
          cron_id TEXT NOT NULL,
          run_status TEXT NOT NULL CHECK(run_status IN ('pending', 'running', 'success', 'failed', 'cancelled')),
          started_at INTEGER,
          ended_at INTEGER,
          output TEXT,
          error_message TEXT,
          logs TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (cron_id) REFERENCES automation_crons(id) ON DELETE CASCADE
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_automation_crons_status ON automation_crons(status)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_automation_crons_next_run ON automation_crons(next_run_at)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_automation_cron_runs_cron ON automation_cron_runs(cron_id, created_at DESC)`);
    },
  },
  {
    id: 13,
    name: 'add_session_id_to_cron_runs',
    migrate: (db) => {
      const tableInfo = db.prepare('PRAGMA table_info(automation_cron_runs)').all() as Array<{ name: string }>;
      const columns = tableInfo.map(col => col.name);

      if (!columns.includes('session_id')) {
        db.exec(`ALTER TABLE automation_cron_runs ADD COLUMN session_id TEXT`);
      }
    },
  },
  {
    id: 14,
    name: 'add_created_at_to_weixin_accounts',
    migrate: (db) => {
      const tableInfo = db.prepare('PRAGMA table_info(weixin_accounts)').all() as Array<{ name: string }>;
      const columns = tableInfo.map(col => col.name);

      if (!columns.includes('created_at')) {
        db.exec(`ALTER TABLE weixin_accounts ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0`);
      }
    },
  },
  {
    id: 15,
    name: 'Add model column to automation_crons',
    migrate(db) {
      const tableInfo = db.prepare('PRAGMA table_info(automation_crons)').all() as Array<{ name: string }>;
      const columns = tableInfo.map(col => col.name);

      if (!columns.includes('model')) {
        db.exec(`ALTER TABLE automation_crons ADD COLUMN model TEXT NOT NULL DEFAULT ''`);
      }
    },
  },
  {
    id: 16,
    name: 'create_agent_profile_tables',
    migrate: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_profiles (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          system_prompt TEXT,
          prompt_base_mode TEXT DEFAULT 'full',
          prompt_overlays TEXT,
          tool_profile_id TEXT DEFAULT 'full',
          allowed_tools TEXT,
          disallowed_tools TEXT,
          default_model TEXT,
          mcp_servers TEXT,
          skills TEXT,
          memory_space_id TEXT,
          share_global_memory INTEGER DEFAULT 1,
          identity_name TEXT,
          identity_emoji TEXT,
          identity_avatar_url TEXT,
          identity_theme_color TEXT,
          subagent_allow_agent_types TEXT,
          subagent_max_spawn_depth INTEGER DEFAULT 1,
          subagent_max_concurrent INTEGER DEFAULT 3,
          is_preset INTEGER DEFAULT 0,
          is_enabled INTEGER DEFAULT 1,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS tool_profiles (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          allowed_tool_groups TEXT,
          denied_tool_groups TEXT,
          is_preset INTEGER DEFAULT 0
        )
      `);

      // Add agent_profile_id to chat_sessions
      const sessionInfo = db.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>;
      const sessionColumns = sessionInfo.map(col => col.name);
      if (!sessionColumns.includes('agent_profile_id')) {
        db.exec(`ALTER TABLE chat_sessions ADD COLUMN agent_profile_id TEXT DEFAULT NULL`);
      }

      // Insert preset tool profiles
      const insertToolProfile = db.prepare(`
        INSERT OR IGNORE INTO tool_profiles (id, name, description, allowed_tool_groups, denied_tool_groups, is_preset)
        VALUES (?, ?, ?, ?, ?, 1)
      `);
      insertToolProfile.run('minimal', 'Minimal', 'Read-only search tools', '["file:read", "search:*", "brief"]', '["file:write", "file:edit", "exec", "browser", "gateway"]');
      insertToolProfile.run('coding', 'Coding', 'Full file and execution tools', '["file:*", "search:*", "exec", "process", "git"]', '["browser", "gateway"]');
      insertToolProfile.run('messaging', 'Messaging', 'Communication tools', '["sessions:*", "brief"]', '["file:*", "exec", "browser", "edit", "apply_patch"]');
      insertToolProfile.run('research', 'Research', 'Read, search, and browser', '["file:read", "search:*", "browser", "brief"]', '["file:write", "file:edit", "exec"]');
      insertToolProfile.run('full', 'Full', 'All available tools', '["*"]', '[]');

      // Insert preset agent profiles
      const insertAgent = db.prepare(`
        INSERT OR IGNORE INTO agent_profiles (
          id, name, description, prompt_base_mode, tool_profile_id, is_preset, is_enabled
        ) VALUES (?, ?, ?, ?, ?, 1, 1)
      `);
      insertAgent.run('general-purpose', 'Main', 'General conversation mode', 'full', 'full');
      insertAgent.run('explore', 'Explore', 'Read-only exploration mode', 'minimal', 'minimal');
      insertAgent.run('plan', 'Plan', 'Planning and architecture design', 'full', 'minimal');
      insertAgent.run('code-expert', 'Code Expert', 'Code development expert', 'full', 'coding');
      insertAgent.run('code-review', 'Code Review', 'Code review specialist', 'full', 'coding');
      insertAgent.run('research', 'Research', 'Research and investigation', 'minimal', 'research');
      insertAgent.run('verification', 'Verification', 'Verification and auditing', 'full', 'minimal');
      insertAgent.run('coordinator', 'Coordinator', 'Task coordination and scheduling', 'full', 'full');
      insertAgent.run('personal-assistant', 'Personal Assistant', 'Personal affairs assistant', 'full', 'messaging');

      // Rename for existing databases (INSERT OR IGNORE won't overwrite)
      db.prepare("UPDATE agent_profiles SET name = 'Main', description = 'General conversation mode' WHERE id = 'general-purpose' AND name = 'General Purpose'").run();
    },
  },
  {
    id: 17,
    name: 'create_conductor_tables',
    migrate: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS conductor_canvases (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          layout_config TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS conductor_widgets (
          id TEXT PRIMARY KEY,
          canvas_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          type TEXT NOT NULL,
          position TEXT NOT NULL,
          config TEXT NOT NULL,
          data TEXT NOT NULL,
          data_version INTEGER NOT NULL DEFAULT 1,
          source_code TEXT,
          state TEXT NOT NULL DEFAULT 'idle',
          permissions TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (canvas_id) REFERENCES conductor_canvases(id) ON DELETE CASCADE
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS conductor_actions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          canvas_id TEXT NOT NULL,
          widget_id TEXT,
          actor TEXT NOT NULL,
          action_type TEXT NOT NULL,
          payload TEXT,
          result_patch TEXT,
          merged_from TEXT,
          reversible INTEGER NOT NULL DEFAULT 1,
          ts INTEGER NOT NULL,
          undone_at INTEGER,
          FOREIGN KEY (canvas_id) REFERENCES conductor_canvases(id) ON DELETE CASCADE
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_conductor_widgets_canvas ON conductor_widgets(canvas_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_conductor_actions_canvas_ts ON conductor_actions(canvas_id, ts)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_conductor_actions_widget_ts ON conductor_actions(widget_id, ts)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_conductor_actions_undone ON conductor_actions(undone_at)`);

      const insertCanvas = db.prepare(`
        INSERT OR IGNORE INTO conductor_canvases (id, name, description, layout_config, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const now = Date.now();
      insertCanvas.run('default', '工作台', null, '{}', 0, now, now);
    },
  },
  {
    id: 18,
    name: 'add_parent_id_and_agent_meta_to_chat_sessions',
    migrate: (db) => {
      const tableInfo = db.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>;
      const columns = tableInfo.map(col => col.name);

      if (!columns.includes('parent_id')) {
        db.exec(`ALTER TABLE chat_sessions ADD COLUMN parent_id TEXT REFERENCES chat_sessions(id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_parent_id ON chat_sessions(parent_id)`);
      }
      if (!columns.includes('agent_type')) {
        db.exec(`ALTER TABLE chat_sessions ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'main'`);
      }
      if (!columns.includes('agent_name')) {
        db.exec(`ALTER TABLE chat_sessions ADD COLUMN agent_name TEXT NOT NULL DEFAULT ''`);
      }
    },
  },
  {
    id: 19,
    name: 'rename_general_purpose_to_main',
    migrate: (db) => {
      db.prepare("UPDATE agent_profiles SET name = 'Main', description = 'General conversation mode' WHERE id = 'general-purpose'").run();
    },
  },
  {
    id: 20,
    name: 'add_task_owner_and_metadata',
    migrate: (db) => {
      try { db.exec(`ALTER TABLE tasks ADD COLUMN owner TEXT`); } catch { /* already exists */ }
      try { db.exec(`ALTER TABLE tasks ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'`); } catch { /* already exists */ }
      try { db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner)`); } catch { /* already exists */ }
    },
  },
  {
    id: 21,
    name: 'simplify_agent_profiles',
    migrate: (db) => {
      // Add user_visible column
      try {
        db.exec(`ALTER TABLE agent_profiles ADD COLUMN user_visible INTEGER DEFAULT 1`);
      } catch { /* already exists */ }

      // Update preset names and flags
      db.prepare(`UPDATE agent_profiles SET name = 'General', description = 'General purpose assistant for most tasks', allowed_tools = '["*"]', disallowed_tools = '[]' WHERE id = 'general-purpose' AND is_preset = 1`).run();
      db.prepare(`UPDATE agent_profiles SET name = 'Code', description = 'Code development and software engineering', allowed_tools = '["file:*","search:*","exec:*","process:*","git:*"]', disallowed_tools = '["browser:*","gateway:*"]' WHERE id = 'code-expert' AND is_preset = 1`).run();
      db.prepare(`UPDATE agent_profiles SET name = 'Research', description = 'Research, investigation and deep analysis', allowed_tools = '["file:read*","search:*","browser:*"]', disallowed_tools = '["file:write*","file:edit*","exec:*"]' WHERE id = 'research' AND is_preset = 1`).run();

      // Set user_visible=0 for sub-agent-only profiles
      db.prepare(`UPDATE agent_profiles SET user_visible = 0, description = 'Read-only exploration — sub-agent only', allowed_tools = '["file:read*","search:*"]', disallowed_tools = '["file:write*","file:edit*","exec:*","browser:*","gateway:*"]' WHERE id = 'explore' AND is_preset = 1`).run();
      db.prepare(`UPDATE agent_profiles SET user_visible = 0, description = 'Planning and architecture — sub-agent only', allowed_tools = '["file:read*","search:*"]', disallowed_tools = '["file:write*","file:edit*","exec:*","browser:*","gateway:*"]' WHERE id = 'plan' AND is_preset = 1`).run();

      // Delete obsolete presets
      db.prepare(`DELETE FROM agent_profiles WHERE id IN ('code-review', 'verification', 'coordinator', 'personal-assistant', 'conductor') AND is_preset = 1`).run();

      // Drop tool_profiles (no longer needed)
      try {
        db.exec(`DROP TABLE IF EXISTS tool_profiles`);
      } catch { /* already gone */ }
    },
  },
  {
    id: 22,
    name: 'create_conductor_elements_table',
    migrate: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS conductor_elements (
          id           TEXT PRIMARY KEY,
          canvas_id    TEXT NOT NULL REFERENCES conductor_canvases(id) ON DELETE CASCADE,
          element_kind TEXT NOT NULL,
          position     TEXT NOT NULL DEFAULT '{"x":0,"y":0,"w":4,"h":3,"zIndex":0,"rotation":0}',
          config       TEXT NOT NULL DEFAULT '{}',
          viz_spec     TEXT,
          source_code  TEXT,
          state        TEXT NOT NULL DEFAULT 'idle',
          data_version INTEGER NOT NULL DEFAULT 1,
          permissions  TEXT NOT NULL DEFAULT '{"agentCanRead":true,"agentCanWrite":true,"agentCanDelete":false}',
          metadata     TEXT NOT NULL DEFAULT '{"label":"","tags":[],"createdBy":"user"}',
          created_at   INTEGER NOT NULL,
          updated_at   INTEGER NOT NULL
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_elements_canvas ON conductor_elements(canvas_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_elements_kind ON conductor_elements(element_kind)`);

      const widgetRows = db.prepare('SELECT id, canvas_id, kind, type, position, config, data, data_version, source_code, state, permissions, created_at, updated_at FROM conductor_widgets WHERE id NOT IN (SELECT id FROM conductor_elements)').all() as Array<{
        id: string;
        canvas_id: string;
        kind: string;
        type: string;
        position: string;
        config: string;
        data: string;
        data_version: number;
        source_code: string | null;
        state: string;
        permissions: string;
        created_at: number;
        updated_at: number;
      }>;

      const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO conductor_elements (id, canvas_id, element_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const row of widgetRows) {
        const elementKind = `widget/${row.type}`;
        const metadata = JSON.stringify({
          label: `${row.kind}:${row.type}`,
          description: row.data ? JSON.stringify(row.data).substring(0, 200) : undefined,
          tags: [],
          createdBy: 'user',
        });

        insertStmt.run(
          row.id,
          row.canvas_id,
          elementKind,
          row.position,
          row.config,
          row.source_code,
          row.state,
          row.data_version,
          row.permissions,
          metadata,
          row.created_at,
          row.updated_at,
        );
      }
    },
  },
];

function runMigrations(db: Database.Database): void {
  const logger = getLogger();
  ensureMigrationsTable(db);

  for (const migration of migrations) {
    if (isMigrationApplied(db, migration.id)) {
      continue;
    }

    logger.info(`Running migration ${migration.id}: ${migration.name}`, undefined, LogComponent.DBMigration);

    try {
      const txn = db.transaction(() => {
        migration.migrate(db);
        markMigrationApplied(db, migration);
      });
      txn();
      logger.info(`Migration ${migration.id} completed successfully`, undefined, LogComponent.DBMigration);
    } catch (error) {
      logger.error(`Migration ${migration.id} failed`, error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.DBMigration);
      throw error;
    }
  }
}

// ============================================================
// IPC Handlers Registration
// ============================================================

export function registerDbHandlers(): void {
  // ==================== Safe Mode Handler ====================

  ipcMain.handle('db:safeModeStatus', () => {
    return {
      isSafeMode: isSafeMode(),
      reason: getSafeModeReason(),
      currentDbPath: getDatabasePath(),
    };
  });

  ipcMain.handle('db:relocateDatabase', async (_event, newDir: string) => {
    if (!db) {
      return { success: false, error: 'Database not initialized' };
    }

    const currentPath = db.name;
    const newDbPath = path.join(newDir, 'duya-main.db');

    if (newDbPath === currentPath) {
      return { success: false, error: 'Same path as current' };
    }

    if (fs.existsSync(newDbPath)) {
      return { success: false, error: 'Target database already exists' };
    }

    try {
      const targetDir = path.dirname(newDbPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      fs.copyFileSync(currentPath, newDbPath);

      const walPath = currentPath + '-wal';
      const shmPath = currentPath + '-shm';
      if (fs.existsSync(walPath)) fs.copyFileSync(walPath, newDbPath + '-wal');
      if (fs.existsSync(shmPath)) fs.copyFileSync(shmPath, newDbPath + '-shm');

      const bootUpdated = updateDatabasePath(newDbPath);
      if (!bootUpdated) {
        fs.unlinkSync(newDbPath);
        return { success: false, error: 'Failed to update boot.json' };
      }

      return { success: true, newPath: newDbPath };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('db:resetToDefaultPath', () => {
    const { dbPath: defaultPath } = resolveDatabasePath();
    const validation = validateDatabasePath(defaultPath);
    if (!validation.valid) {
      return { success: false, error: validation.reason };
    }

    const updated = updateDatabasePath(defaultPath);
    return { success: updated, newPath: defaultPath };
  });

  // ==================== Session Handlers ====================

  ipcMain.handle('db:session:create', (_event, data) => {
    const now = Date.now();
    db!.prepare(`
      INSERT INTO chat_sessions (
        id, title, model, system_prompt, working_directory,
        project_name, status, mode, provider_id, generation,
        parent_id, agent_type, agent_name,
        created_at, updated_at, is_deleted
      ) VALUES (
        @id, @title, @model, @system_prompt, @working_directory,
        @project_name, @status, @mode, @provider_id, @generation,
        @parent_id, @agent_type, @agent_name,
        @created_at, @updated_at, 0
      )
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        model = excluded.model,
        system_prompt = excluded.system_prompt,
        working_directory = excluded.working_directory,
        project_name = excluded.project_name,
        status = excluded.status,
        mode = excluded.mode,
        provider_id = excluded.provider_id,
        parent_id = COALESCE(excluded.parent_id, chat_sessions.parent_id),
        agent_type = COALESCE(excluded.agent_type, chat_sessions.agent_type),
        agent_name = COALESCE(excluded.agent_name, chat_sessions.agent_name),
        updated_at = excluded.updated_at
    `).run({
      id: data.id,
      title: data.title ?? 'New Chat',
      model: data.model ?? '',
      system_prompt: data.system_prompt ?? '',
      working_directory: data.working_directory ?? '',
      project_name: data.project_name ?? '',
      status: data.status ?? 'active',
      mode: data.mode ?? 'code',
      provider_id: data.provider_id ?? 'env',
      generation: data.generation ?? 0,
      parent_id: data.parent_id ?? (data as Record<string, unknown>).parent_session_id as string ?? null,
      agent_type: data.agent_type ?? 'main',
      agent_name: data.agent_name ?? '',
      created_at: now,
      updated_at: now,
    });
    return db!.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(data.id);
  });

  ipcMain.handle('db:session:get', (_event, sessionId: string) => {
    return db!.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sessionId);
  });

  ipcMain.handle('db:session:update', (_event, sessionId: string, data: Record<string, unknown>) => {
    const now = Date.now();
    const fields: string[] = ['updated_at = @updated_at'];
    const params: Record<string, unknown> = { sessionId, updated_at: now };

    const fieldMap: Record<string, string> = {
      title: 'title',
      model: 'model',
      system_prompt: 'system_prompt',
      working_directory: 'working_directory',
      project_name: 'project_name',
      status: 'status',
      mode: 'mode',
      permission_profile: 'permission_profile',
      provider_id: 'provider_id',
      context_summary: 'context_summary',
      parent_id: 'parent_id',
      agent_profile_id: 'agent_profile_id',
      agent_type: 'agent_type',
      agent_name: 'agent_name',
    };

    for (const [key, dbField] of Object.entries(fieldMap)) {
      if (data[key] !== undefined) {
        fields.push(`${dbField} = @${key}`);
        params[key] = data[key];
      }
    }

    db!.prepare(`UPDATE chat_sessions SET ${fields.join(', ')} WHERE id = @sessionId`).run(params);
    return db!.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sessionId);
  });

  ipcMain.handle('db:session:delete', (_event, sessionId: string) => {
    const txn = db!.transaction(() => {
      db!.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
      const result = db!.prepare('DELETE FROM chat_sessions WHERE id = ?').run(sessionId);
      return result.changes > 0;
    });
    return txn();
  });

  ipcMain.handle('db:session:list', () => {
    return db!.prepare("SELECT * FROM chat_sessions WHERE is_deleted = 0 AND mode != 'automation' ORDER BY updated_at DESC").all();
  });

  ipcMain.handle('db:session:listByWorkingDirectory', (_event, workingDirectory: string) => {
    if (!workingDirectory) {
      return db!.prepare(
        "SELECT * FROM chat_sessions WHERE is_deleted = 0 AND working_directory = '' ORDER BY updated_at DESC"
      ).all();
    }
    return db!.prepare(
      'SELECT * FROM chat_sessions WHERE is_deleted = 0 AND working_directory = ? ORDER BY updated_at DESC'
    ).all(workingDirectory);
  });

  ipcMain.handle('db:session:listByParentId', (_event, parentId: string) => {
    return db!.prepare(
      'SELECT * FROM chat_sessions WHERE is_deleted = 0 AND parent_id = ? ORDER BY created_at ASC'
    ).all(parentId);
  });

  // ==================== Message Handlers ====================

  ipcMain.handle('db:message:add', (_event, data: {
    id: string;
    session_id: string;
    role: string;
    content: string;
    name?: string;
    tool_call_id?: string;
    token_usage?: string;
    msg_type?: string;
    thinking?: string;
    tool_name?: string;
    tool_input?: string;
    parent_tool_call_id?: string;
    viz_spec?: string;
    status?: string;
    seq_index?: number;
    duration_ms?: number;
    sub_agent_id?: string;
  }) => {
    const now = Date.now();
    db!.prepare(`
      INSERT INTO messages (id, session_id, role, content, name, tool_call_id, token_usage, msg_type, thinking, tool_name, tool_input, parent_tool_call_id, viz_spec, status, seq_index, duration_ms, sub_agent_id, created_at)
      VALUES (@id, @session_id, @role, @content, @name, @tool_call_id, @token_usage, @msg_type, @thinking, @tool_name, @tool_input, @parent_tool_call_id, @viz_spec, @status, @seq_index, @duration_ms, @sub_agent_id, @created_at)
    `).run({
      id: data.id,
      session_id: data.session_id,
      role: data.role,
      content: data.content,
      name: data.name ?? null,
      tool_call_id: data.tool_call_id ?? null,
      token_usage: data.token_usage ?? null,
      msg_type: data.msg_type ?? 'text',
      thinking: data.thinking ?? null,
      tool_name: data.tool_name ?? null,
      tool_input: data.tool_input ?? null,
      parent_tool_call_id: data.parent_tool_call_id ?? null,
      viz_spec: data.viz_spec ?? null,
      status: data.status ?? 'done',
      seq_index: data.seq_index ?? null,
      duration_ms: data.duration_ms ?? null,
      sub_agent_id: data.sub_agent_id ?? null,
      created_at: now,
    });

    db!.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, data.session_id);

    return db!.prepare('SELECT * FROM messages WHERE id = ?').get(data.id);
  });

  ipcMain.handle('db:message:getBySession', (_event, sessionId: string) => {
    console.log('[DB] getBySession for sessionId:', sessionId);
    const result = db!.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC'
    ).all(sessionId);
    console.log('[DB] getBySession result count:', result.length);
    return result;
  });

  ipcMain.handle('db:message:getCount', (_event, sessionId: string) => {
    const result = db!.prepare(
      'SELECT COUNT(*) as count FROM messages WHERE session_id = ?'
    ).get(sessionId) as { count: number };
    return result.count;
  });

  ipcMain.handle('db:message:deleteBySession', (_event, sessionId: string) => {
    const result = db!.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    return result.changes;
  });

  ipcMain.handle('db:message:replace', (_event, sessionId: string, messages: unknown[], generation: number) => {
    const now = Date.now();

    const session = db!.prepare(
      'SELECT generation FROM chat_sessions WHERE id = ?'
    ).get(sessionId) as { generation: number } | undefined;

    if (!session) {
      return { success: false, reason: 'session_not_found' };
    }

    if (generation < session.generation) {
      return { success: false, reason: 'stale_generation' };
    }

    const newGeneration = Math.max(generation, session.generation + 1);

    try {
      db!.transaction(() => {
        db!.prepare('UPDATE chat_sessions SET generation = ?, updated_at = ? WHERE id = ?')
          .run(newGeneration, now, sessionId);

        db!.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);

        const stmt = db!.prepare(`
          INSERT INTO messages (id, session_id, role, content, name, tool_call_id, token_usage, msg_type, thinking, tool_name, tool_input, parent_tool_call_id, viz_spec, status, seq_index, duration_ms, sub_agent_id, created_at)
          VALUES (@id, @session_id, @role, @content, @name, @tool_call_id, @token_usage, @msg_type, @thinking, @tool_name, @tool_input, @parent_tool_call_id, @viz_spec, @status, @seq_index, @duration_ms, @sub_agent_id, @created_at)
        `);

        for (const rawMsg of messages) {
          const msg = rawMsg as Record<string, unknown>;
          let msgType = (msg.msg_type as string) || 'text';
          let thinking: string | null = (msg.thinking as string) || null;
          let toolName: string | null = (msg.tool_name as string) || null;
          let toolInput: string | null = (msg.tool_input as string) || null;
          let parentToolCallId: string | null = (msg.parent_tool_call_id as string) || null;
          let contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

          if (!msg.msg_type && Array.isArray(msg.content)) {
            const blocks = msg.content as Array<{ type: string; thinking?: string; name?: string; input?: unknown; tool_use_id?: string }>;
            const types = blocks.map(b => b.type);
            if (types.includes('thinking') && types.length === 1) {
              msgType = 'thinking';
              thinking = blocks[0].thinking || null;
              contentStr = thinking || '';
            } else if (types.includes('tool_use') && types.length === 1) {
              msgType = 'tool_use';
              toolName = blocks[0].name || null;
              toolInput = blocks[0].input ? JSON.stringify(blocks[0].input) : null;
              contentStr = toolInput || '';
            } else if (msg.role === 'tool') {
              msgType = 'tool_result';
              parentToolCallId = (msg.tool_call_id as string) || null;
            } else {
              const thinkingBlock = blocks.find(b => b.type === 'thinking');
              if (thinkingBlock) thinking = thinkingBlock.thinking || null;
            }
          } else if (!msg.msg_type && typeof msg.content === 'string') {
            if (msg.role === 'tool') {
              msgType = 'tool_result';
              parentToolCallId = (msg.tool_call_id as string) || null;
            }
          }

          stmt.run({
            id: (msg.id as string) || randomUUID(),
            session_id: sessionId,
            role: msg.role as string,
            content: contentStr,
            name: (msg.name as string) || null,
            tool_call_id: (msg.tool_call_id as string) || null,
            token_usage: (msg.token_usage as string) || null,
            msg_type: msgType,
            thinking,
            tool_name: toolName,
            tool_input: toolInput,
            parent_tool_call_id: parentToolCallId,
            viz_spec: (msg.viz_spec as string) || null,
            status: (msg.status as string) || 'done',
            seq_index: (msg.seq_index as number) ?? null,
            duration_ms: (msg.duration_ms as number) ?? null,
            sub_agent_id: (msg.sub_agent_id as string) || null,
            created_at: (msg.timestamp as number) || now,
          });
        }
      })();

      return { success: true, newGeneration, messageCount: (messages as unknown[]).length };
    } catch (error) {
      dbLogger.error('replaceMessages failed', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.DB);
      return { success: false, reason: error instanceof Error ? error.message : String(error) };
    }
  });

  // ==================== Lock Handlers ====================

  ipcMain.handle('db:lock:acquire', (_event, sessionId: string, lockId: string, owner: string, ttlSec = 300) => {
    const now = Date.now();
    const expiresAt = now + ttlSec * 1000;

    const txn = db!.transaction(() => {
      db!.prepare('DELETE FROM session_runtime_locks WHERE expires_at < ?').run(now);
      try {
        db!.prepare(
          'INSERT INTO session_runtime_locks (session_id, lock_id, owner, expires_at) VALUES (?, ?, ?, ?)'
        ).run(sessionId, lockId, owner, expiresAt);
        return true;
      } catch {
        return false;
      }
    });
    return txn();
  });

  ipcMain.handle('db:lock:renew', (_event, sessionId: string, lockId: string, ttlSec = 300) => {
    const now = Date.now();
    const expiresAt = now + ttlSec * 1000;
    const result = db!.prepare(
      'UPDATE session_runtime_locks SET expires_at = ? WHERE session_id = ? AND lock_id = ?'
    ).run(expiresAt, sessionId, lockId);
    return result.changes > 0;
  });

  ipcMain.handle('db:lock:release', (_event, sessionId: string, lockId: string) => {
    const result = db!.prepare(
      'DELETE FROM session_runtime_locks WHERE session_id = ? AND lock_id = ?'
    ).run(sessionId, lockId);
    return result.changes > 0;
  });

  ipcMain.handle('db:lock:isLocked', (_event, sessionId: string) => {
    const now = Date.now();
    db!.prepare('DELETE FROM session_runtime_locks WHERE expires_at < ?').run(now);
    const stmt = db!.prepare('SELECT 1 FROM session_runtime_locks WHERE session_id = ?');
    return stmt.get(sessionId) !== undefined;
  });

  // ==================== Task Handlers ====================

  ipcMain.handle('db:task:create', (_event, data: {
    id: string;
    session_id: string;
    subject: string;
    description: string;
    active_form?: string;
    owner?: string;
  }) => {
    const now = Date.now();
    db!.prepare(`
      INSERT INTO tasks (id, session_id, subject, description, active_form, owner, status, blocks, blocked_by, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', '[]', '[]', '{}', ?, ?)
    `).run(data.id, data.session_id, data.subject, data.description, data.active_form ?? null, data.owner ?? null, now, now);
    return db!.prepare('SELECT * FROM tasks WHERE id = ?').get(data.id);
  });

  ipcMain.handle('db:task:get', (_event, id: string) => {
    return db!.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  });

  ipcMain.handle('db:task:getBySession', (_event, sessionId: string) => {
    return db!.prepare('SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at ASC').all(sessionId);
  });

  ipcMain.handle('db:task:update', (_event, id: string, data: Record<string, unknown>) => {
    const now = Date.now();
    const fields: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    const fieldMap: Record<string, string> = {
      subject: 'subject',
      description: 'description',
      status: 'status',
      active_form: 'active_form',
      owner: 'owner',
    };

    for (const [key, dbField] of Object.entries(fieldMap)) {
      if (data[key] !== undefined) {
        fields.push(`${dbField} = ?`);
        values.push(data[key]);
      }
    }

    if (data.blocks !== undefined) {
      fields.push('blocks = ?');
      values.push(JSON.stringify(data.blocks));
    }
    if (data.blocked_by !== undefined) {
      fields.push('blocked_by = ?');
      values.push(JSON.stringify(data.blocked_by));
    }
    if (data.metadata !== undefined) {
      fields.push('metadata = ?');
      values.push(JSON.stringify(data.metadata));
    }

    values.push(id);
    db!.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return db!.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  });

  ipcMain.handle('db:task:delete', (_event, id: string) => {
    const result = db!.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    return result.changes > 0;
  });

  ipcMain.handle('db:task:deleteBySession', (_event, sessionId: string) => {
    db!.prepare('DELETE FROM tasks WHERE session_id = ?').run(sessionId);
  });

  ipcMain.handle('db:task:claim', (_event, id: string, owner: string) => {
    const now = Date.now();
    const row = db!.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return { success: false, reason: 'task_not_found' };
    if (row.owner && row.owner !== owner) return { success: false, reason: 'already_claimed' };
    if (row.status === 'completed') return { success: false, reason: 'already_resolved' };

    const blockedBy = JSON.parse((row.blocked_by as string) || '[]') as string[];
    if (blockedBy.length > 0) {
      const unresolvedIds = db!.prepare(
        `SELECT id FROM tasks WHERE id IN (${blockedBy.map(() => '?').join(',')}) AND status != 'completed'`
      ).all(...blockedBy) as { id: string }[];
      if (unresolvedIds.length > 0) {
        return { success: false, reason: 'blocked', blockedByTasks: unresolvedIds.map(r => r.id) };
      }
    }

    db!.prepare(`UPDATE tasks SET owner = ?, status = 'in_progress', updated_at = ? WHERE id = ?`).run(owner, now, id);
    return { success: true, task: db!.prepare('SELECT * FROM tasks WHERE id = ?').get(id) };
  });

  ipcMain.handle('db:task:block', (_event, fromId: string, toId: string) => {
    const from = db!.prepare('SELECT * FROM tasks WHERE id = ?').get(fromId) as Record<string, unknown> | undefined;
    const to = db!.prepare('SELECT * FROM tasks WHERE id = ?').get(toId) as Record<string, unknown> | undefined;
    if (!from || !to) return false;

    const fromBlocks: string[] = JSON.parse((from.blocks as string) || '[]');
    const toBlockedBy: string[] = JSON.parse((to.blocked_by as string) || '[]');

    if (!fromBlocks.includes(toId)) {
      fromBlocks.push(toId);
      db!.prepare('UPDATE tasks SET blocks = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(fromBlocks), Date.now(), fromId);
    }
    if (!toBlockedBy.includes(fromId)) {
      toBlockedBy.push(fromId);
      db!.prepare('UPDATE tasks SET blocked_by = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(toBlockedBy), Date.now(), toId);
    }
    return true;
  });

  ipcMain.handle('db:task:unassignTeammate', (_event, sessionId: string, owner: string) => {
    const now = Date.now();
    const tasks = db!.prepare(
      `SELECT id, subject FROM tasks WHERE session_id = ? AND status != 'completed' AND owner = ?`
    ).all(sessionId, owner) as { id: string; subject: string }[];
    if (tasks.length === 0) return { unassignedTasks: [], notificationMessage: '' };

    db!.prepare(
      `UPDATE tasks SET owner = NULL, status = 'pending', updated_at = ? WHERE session_id = ? AND status != 'completed' AND owner = ?`
    ).run(now, sessionId, owner);

    const taskList = tasks.map(t => `#${t.id} "${t.subject}"`).join(', ');
    return {
      unassignedTasks: tasks.map(t => ({ id: t.id, subject: t.subject })),
      notificationMessage: `${owner} was terminated. ${tasks.length} task(s) were unassigned: ${taskList}.`,
    };
  });

  ipcMain.handle('db:task:getByOwner', (_event, sessionId: string, owner: string) => {
    return db!.prepare(
      `SELECT * FROM tasks WHERE session_id = ? AND status != 'completed' AND owner = ?`
    ).all(sessionId, owner);
  });

  // ==================== Automation Handlers ====================

  ipcMain.handle('automation:cron:list', () => {
    const scheduler = getAutomationScheduler();
    if (!scheduler) {
      throw new Error('Automation scheduler is not initialized');
    }
    return scheduler.listCrons();
  });

  ipcMain.handle('automation:cron:create', (_event, data: {
    name: string;
    description?: string | null;
    schedule: { kind: 'at' | 'every' | 'cron'; at?: string; everyMs?: number; cronExpr?: string; cronTz?: string | null };
    prompt: string;
    inputParams?: Record<string, unknown>;
    concurrencyPolicy?: 'skip' | 'parallel' | 'queue' | 'replace';
    maxRetries?: number;
    enabled?: boolean;
  }) => {
    const scheduler = getAutomationScheduler();
    if (!scheduler) {
      throw new Error('Automation scheduler is not initialized');
    }
    return scheduler.createCron(data);
  });

  ipcMain.handle('automation:cron:update', (_event, id: string, patch: {
    name?: string;
    description?: string | null;
    schedule?: { kind: 'at' | 'every' | 'cron'; at?: string; everyMs?: number; cronExpr?: string; cronTz?: string | null };
    prompt?: string;
    inputParams?: Record<string, unknown>;
    concurrencyPolicy?: 'skip' | 'parallel' | 'queue' | 'replace';
    maxRetries?: number;
    status?: 'enabled' | 'disabled' | 'error';
  }) => {
    const scheduler = getAutomationScheduler();
    if (!scheduler) {
      throw new Error('Automation scheduler is not initialized');
    }
    return scheduler.updateCron(id, patch);
  });

  ipcMain.handle('automation:cron:delete', (_event, id: string) => {
    const scheduler = getAutomationScheduler();
    if (!scheduler) {
      throw new Error('Automation scheduler is not initialized');
    }
    return scheduler.deleteCron(id);
  });

  ipcMain.handle('automation:cron:run', async (_event, id: string) => {
    const scheduler = getAutomationScheduler();
    if (!scheduler) {
      throw new Error('Automation scheduler is not initialized');
    }
    return await scheduler.runCronNow(id);
  });

  ipcMain.handle('automation:cron:runs', (_event, input: {
    cronId: string;
    limit?: number;
    offset?: number;
  }) => {
    const scheduler = getAutomationScheduler();
    if (!scheduler) {
      throw new Error('Automation scheduler is not initialized');
    }
    return scheduler.listCronRuns(input);
  });

  // ==================== Settings Handlers ====================

  ipcMain.handle('db:setting:get', (_event, key: string) => {
    const row = db!.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  });

  ipcMain.handle('db:setting:set', (_event, key: string, value: string) => {
    const now = Date.now();
    db!.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, now);
  });

  ipcMain.handle('db:setting:getAll', () => {
    const rows = db!.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
    const settings: Record<string, string> = {};
    for (const row of rows) settings[row.key] = row.value;
    return settings;
  });

  ipcMain.handle('db:setting:getJson', (_event, key: string, defaultValue: unknown) => {
    const value = db!.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!value) return defaultValue;
    try {
      return JSON.parse(value.value);
    } catch {
      return defaultValue;
    }
  });

  ipcMain.handle('db:setting:setJson', (_event, key: string, value: unknown) => {
    const now = Date.now();
    db!.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), now);
  });

  // ==================== Permission Handlers ====================

  ipcMain.handle('db:permission:create', (_event, data: {
    id: string;
    sessionId?: string;
    toolName: string;
    toolInput?: Record<string, unknown>;
  }) => {
    const now = Date.now();
    db!.prepare(`
      INSERT INTO permission_requests (id, session_id, tool_name, tool_input, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(
      data.id,
      data.sessionId || null,
      data.toolName,
      data.toolInput ? JSON.stringify(data.toolInput) : null,
      now
    );
    return db!.prepare('SELECT * FROM permission_requests WHERE id = ?').get(data.id);
  });

  ipcMain.handle('db:permission:get', (_event, id: string) => {
    return db!.prepare('SELECT * FROM permission_requests WHERE id = ?').get(id);
  });

  ipcMain.handle('db:permission:resolve', (_event, id: string, status: string, extra?: {
    message?: string;
    updatedPermissions?: unknown[];
    updatedInput?: Record<string, unknown>;
  }) => {
    const now = Date.now();
    db!.prepare(`
      UPDATE permission_requests SET
        status = ?,
        decision = ?,
        message = ?,
        updated_permissions = ?,
        updated_input = ?,
        resolved_at = ?
      WHERE id = ?
    `).run(
      status,
      status,
      extra?.message || null,
      extra?.updatedPermissions ? JSON.stringify(extra.updatedPermissions) : null,
      extra?.updatedInput ? JSON.stringify(extra.updatedInput) : null,
      now,
      id
    );

    // Forward permission resolution to agent process so it can continue tool execution
    const agentPool = getAgentProcessPool();
    const sessionId = extra?.sessionId as string | undefined;
    if (sessionId && agentPool.isRunning(sessionId)) {
      dbLogger.info('Forwarding permission:resolve to agent process', { id, status, sessionId }, LogComponent.DB);
      const sent = agentPool.send(sessionId, {
        type: 'permission:resolve',
        id,
        decision: status,
      });
      if (!sent) {
        dbLogger.error('Failed to send permission:resolve to agent process', { id, status, sessionId }, LogComponent.DB);
      }
    } else {
      dbLogger.warn('Agent process not available for permission:resolve forwarding', { sessionId, isRunning: sessionId ? agentPool.isRunning(sessionId) : false }, LogComponent.DB);
    }

    return db!.prepare('SELECT * FROM permission_requests WHERE id = ?').get(id);
  });

  // ==================== Search Handlers ====================

  ipcMain.handle('db:search:sessions', (_event, query: string, limit = 10) => {
    try {
      const ftsAvailable = db!.prepare(
        "SELECT 1 FROM pragma_compile_options WHERE compile_options = 'ENABLE_FTS5'"
      ).get();
      if (ftsAvailable) {
        return db!.prepare(`
          SELECT DISTINCT m.session_id, s.* FROM messages_fts f
          JOIN messages m ON f.rowid = m.rowid
          JOIN chat_sessions s ON m.session_id = s.id
          WHERE messages_fts MATCH ? AND s.is_deleted = 0
          ORDER BY s.updated_at DESC LIMIT ?
        `).all(query, limit);
      }
    } catch {}
    return db!.prepare(`
      SELECT DISTINCT s.* FROM messages m
      JOIN chat_sessions s ON m.session_id = s.id
      WHERE m.content LIKE ? AND s.is_deleted = 0
      ORDER BY s.updated_at DESC LIMIT ?
    `).all(`%${query}%`, limit);
  });

  // ==================== Channel Binding Handlers ====================

  ipcMain.handle('db:channel:getBindings', (_event, channelType?: string) => {
    if (channelType) {
      return db!.prepare(
        'SELECT * FROM channel_bindings WHERE channel_type = ? ORDER BY updated_at DESC'
      ).all(channelType);
    }
    return db!.prepare('SELECT * FROM channel_bindings ORDER BY updated_at DESC').all();
  });

  ipcMain.handle('db:channel:getBinding', (_event, channelType: string, chatId: string) => {
    return db!.prepare(
      'SELECT * FROM channel_bindings WHERE channel_type = ? AND chat_id = ?'
    ).get(channelType, chatId);
  });

  ipcMain.handle('db:channel:upsertBinding', (_event, data: {
    id: string;
    channel_type: string;
    chat_id: string;
    duya_session_id: string;
    sdk_session_id?: string;
    working_directory?: string;
    model?: string;
    mode?: string;
  }) => {
    const now = Date.now();
    db!.prepare(`
      INSERT INTO channel_bindings (id, channel_type, chat_id, duya_session_id, sdk_session_id, working_directory, model, mode, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        duya_session_id = excluded.duya_session_id,
        sdk_session_id = COALESCE(excluded.sdk_session_id, sdk_session_id),
        working_directory = COALESCE(excluded.working_directory, working_directory),
        model = COALESCE(excluded.model, model),
        mode = COALESCE(excluded.mode, mode),
        updated_at = excluded.updated_at
    `).run(
      data.id,
      data.channel_type,
      data.chat_id,
      data.duya_session_id,
      data.sdk_session_id || '',
      data.working_directory || '',
      data.model || '',
      data.mode || 'code',
      now,
      now
    );
    return db!.prepare('SELECT * FROM channel_bindings WHERE id = ?').get(data.id);
  });

  ipcMain.handle('db:channel:getOffset', (_event, channelType: string, offsetKey: string) => {
    return db!.prepare(
      'SELECT * FROM channel_offsets WHERE channel_type = ? AND offset_key = ?'
    ).get(channelType, offsetKey);
  });

  ipcMain.handle('db:channel:setOffset', (_event, channelType: string, offsetKey: string, offsetValue: string, offsetType = 'long_polling') => {
    const now = Date.now();
    db!.prepare(`
      INSERT INTO channel_offsets (channel_type, offset_key, offset_value, offset_type, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(channel_type, offset_key) DO UPDATE SET
        offset_value = excluded.offset_value,
        offset_type = COALESCE(excluded.offset_type, offset_type),
        updated_at = excluded.updated_at
    `).run(channelType, offsetKey, offsetValue, offsetType, now);
  });

  // ==================== Project Group Handlers ====================

  ipcMain.handle('db:project:getGroups', () => {
    return db!.prepare(`
      SELECT
        working_directory,
        project_name,
        COUNT(*) as thread_count,
        MAX(updated_at) as last_activity
      FROM chat_sessions
      WHERE is_deleted = 0 AND working_directory != ''
      GROUP BY working_directory
      ORDER BY last_activity DESC
    `).all();
  });

  // ==================== Database Migration Handlers ====================

  ipcMain.handle('db:migration:getDefaultPath', () => {
    return getDatabasePath();
  });

  ipcMain.handle('db:migration:databaseExists', (_event, dbPath: string) => {
    return fs.existsSync(dbPath);
  });

  ipcMain.handle('db:migration:getDatabaseSize', (_event, dbPath: string) => {
    if (!fs.existsSync(dbPath)) {
      return '0 KB';
    }
    const stats = fs.statSync(dbPath);
    const sizeInKB = stats.size / 1024;
    if (sizeInKB < 1024) {
      return `${sizeInKB.toFixed(1)} KB`;
    } else {
      return `${(sizeInKB / 1024).toFixed(2)} MB`;
    }
  });

  ipcMain.handle('db:migration:checkNeeded', (_event, newDbPath: string) => {
    const currentPath = db ? db.name : getDatabasePath();
    const targetExists = fs.existsSync(newDbPath);
    const sourceExists = fs.existsSync(currentPath);
    const needed = sourceExists && currentPath !== newDbPath && !targetExists;

    return {
      needed,
      sourcePath: needed ? currentPath : null,
      targetExists,
    };
  });

  ipcMain.handle('db:migration:migrate', (_event, sourcePath: string, targetPath: string) => {
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Source database does not exist: ${sourcePath}`);
    }

    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    if (fs.existsSync(targetPath)) {
      throw new Error('Target database already exists');
    }

    fs.copyFileSync(sourcePath, targetPath);

    const walPath = sourcePath + '-wal';
    const shmPath = sourcePath + '-shm';

    if (fs.existsSync(walPath)) {
      fs.copyFileSync(walPath, targetPath + '-wal');
    }
    if (fs.existsSync(shmPath)) {
      fs.copyFileSync(shmPath, targetPath + '-shm');
    }

    dbLogger.info('Successfully migrated database', { sourcePath, targetPath }, LogComponent.DBMigration);
    return { success: true };
  });

  ipcMain.handle('db:migration:updateBootAndRestart', (_event, newDbPath: string) => {
    const updated = updateDatabasePath(newDbPath);
    if (!updated) {
      return { success: false, error: 'Failed to update boot.json' };
    }

    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 500);

    return { success: true };
  });

  // ==================== Weixin Account Handlers ====================

  ipcMain.handle('db:weixin:getAccounts', () => {
    return db!.prepare('SELECT * FROM weixin_accounts ORDER BY created_at DESC').all();
  });

  ipcMain.handle('db:weixin:upsertAccount', (_event, data: {
    accountId: string;
    userId?: string;
    name?: string;
    baseUrl?: string;
    cdnBaseUrl?: string;
    token: string;
    enabled?: boolean;
  }) => {
    const now = Date.now();
    db!.prepare(`
      INSERT INTO weixin_accounts (account_id, user_id, name, base_url, cdn_base_url, token, enabled, last_login_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        user_id = COALESCE(excluded.user_id, user_id),
        name = COALESCE(excluded.name, name),
        base_url = COALESCE(excluded.base_url, base_url),
        cdn_base_url = COALESCE(excluded.cdn_base_url, cdn_base_url),
        token = excluded.token,
        enabled = COALESCE(excluded.enabled, enabled),
        last_login_at = excluded.last_login_at,
        created_at = COALESCE(weixin_accounts.created_at, excluded.created_at)
    `).run(
      data.accountId,
      data.userId || '',
      data.name || data.accountId,
      data.baseUrl || '',
      data.cdnBaseUrl || '',
      data.token,
      data.enabled !== undefined ? (data.enabled ? 1 : 0) : 1,
      now,
      now
    );
    return db!.prepare('SELECT * FROM weixin_accounts WHERE account_id = ?').get(data.accountId);
  });

  ipcMain.handle('db:weixin:updateAccount', (_event, accountId: string, data: {
    enabled?: boolean;
    name?: string;
  }) => {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (data.enabled !== undefined) {
      fields.push('enabled = ?');
      values.push(data.enabled ? 1 : 0);
    }
    if (data.name !== undefined) {
      fields.push('name = ?');
      values.push(data.name);
    }

    if (fields.length === 0) return null;

    values.push(accountId);
    db!.prepare(`UPDATE weixin_accounts SET ${fields.join(', ')} WHERE account_id = ?`).run(...values);
    return db!.prepare('SELECT * FROM weixin_accounts WHERE account_id = ?').get(accountId);
  });

  ipcMain.handle('db:weixin:deleteAccount', (_event, accountId: string) => {
    db!.prepare('DELETE FROM weixin_context_tokens WHERE account_id = ?').run(accountId);
    const result = db!.prepare('DELETE FROM weixin_accounts WHERE account_id = ?').run(accountId);
    return result.changes > 0;
  });

  ipcMain.handle('db:weixin:getContextToken', (_event, accountId: string, peerUserId: string) => {
    const row = db!.prepare(
      'SELECT context_token FROM weixin_context_tokens WHERE account_id = ? AND peer_user_id = ?'
    ).get(accountId, peerUserId) as { context_token: string } | undefined;
    return row?.context_token || null;
  });

  ipcMain.handle('db:weixin:setContextToken', (_event, accountId: string, peerUserId: string, contextToken: string) => {
    const now = Date.now();
    db!.prepare(`
      INSERT INTO weixin_context_tokens (account_id, peer_user_id, context_token, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, peer_user_id) DO UPDATE SET
        context_token = excluded.context_token,
        updated_at = excluded.updated_at
    `).run(accountId, peerUserId, contextToken, now);
  });

  // ==================== Agent Profile Handlers ====================

  ipcMain.handle('db:agentProfile:list', () => {
    return db!.prepare('SELECT * FROM agent_profiles ORDER BY is_preset DESC, name ASC').all();
  });

  ipcMain.handle('db:agentProfile:get', (_event, id: string) => {
    return db!.prepare('SELECT * FROM agent_profiles WHERE id = ?').get(id);
  });

  ipcMain.handle('db:agentProfile:create', (_event, data: Record<string, unknown>) => {
    const now = Date.now();
    const id = (data.id as string) || crypto.randomUUID();
    db!.prepare(`
      INSERT INTO agent_profiles (
        id, name, description, allowed_tools, disallowed_tools, default_model,
        user_visible, is_preset, is_enabled, created_at, updated_at
      ) VALUES (
        @id, @name, @description, @allowed_tools, @disallowed_tools, @default_model,
        @user_visible, @is_preset, @is_enabled, @created_at, @updated_at
      )
    `).run({
      id,
      name: data.name || 'New Agent',
      description: data.description ?? null,
      allowed_tools: data.allowed_tools ? JSON.stringify(data.allowed_tools) : null,
      disallowed_tools: data.disallowed_tools ? JSON.stringify(data.disallowed_tools) : null,
      default_model: data.default_model ?? null,
      user_visible: data.user_visible !== undefined ? (data.user_visible ? 1 : 0) : 1,
      is_preset: data.is_preset !== undefined ? (data.is_preset ? 1 : 0) : 0,
      is_enabled: data.is_enabled !== undefined ? (data.is_enabled ? 1 : 0) : 1,
      created_at: now,
      updated_at: now,
    });
    return db!.prepare('SELECT * FROM agent_profiles WHERE id = ?').get(id);
  });

  ipcMain.handle('db:agentProfile:update', (_event, id: string, data: Record<string, unknown>) => {
    const now = Date.now();
    const fields: string[] = ['updated_at = @updated_at'];
    const params: Record<string, unknown> = { id, updated_at: now };

    const fieldMap: Record<string, [string, (v: unknown) => unknown]> = {
      name: ['name', v => v],
      description: ['description', v => v ?? null],
      allowed_tools: ['allowed_tools', v => v ? JSON.stringify(v) : null],
      disallowed_tools: ['disallowed_tools', v => v ? JSON.stringify(v) : null],
      default_model: ['default_model', v => v ?? null],
      is_enabled: ['is_enabled', v => v !== undefined ? (v ? 1 : 0) : 1],
    };

    for (const [key, [dbField, transform]] of Object.entries(fieldMap)) {
      if (data[key] !== undefined) {
        fields.push(`${dbField} = @${dbField}`);
        params[dbField] = transform(data[key]);
      }
    }

    db!.prepare(`UPDATE agent_profiles SET ${fields.join(', ')} WHERE id = @id`).run(params);
    return db!.prepare('SELECT * FROM agent_profiles WHERE id = ?').get(id);
  });

  ipcMain.handle('db:agentProfile:delete', (_event, id: string) => {
    // Prevent deleting preset profiles
    const profile = db!.prepare('SELECT is_preset FROM agent_profiles WHERE id = ?').get(id) as { is_preset: number } | undefined;
    if (!profile) return false;
    if (profile.is_preset === 1) {
      throw new Error('Cannot delete preset agent profiles');
    }
    const result = db!.prepare('DELETE FROM agent_profiles WHERE id = ?').run(id);
    return result.changes > 0;
  });

  // ==================== Session Agent Profile Binding ====================

  ipcMain.handle('db:session:setAgentProfile', (_event, sessionId: string, agentProfileId: string | null) => {
    db!.prepare('UPDATE chat_sessions SET agent_profile_id = ?, updated_at = ? WHERE id = ?')
      .run(agentProfileId, Date.now(), sessionId);
    return db!.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sessionId);
  });

  // ==================== DB Stats Handler ====================

  ipcMain.handle('db:stats', () => {
    const stats = getDatabaseStats();
    if (!stats) {
      return { success: false, error: 'Database not initialized' };
    }
    const warning = checkDatabaseSizeWarning();
    return { success: true, stats, warning };
  });

  dbLogger.info('All database handlers registered', undefined, LogComponent.DB);
}

// ============================================================
// Conductor IPC Handlers
// ============================================================

export function registerConductorHandlers(): void {
  if (!db) return;

  const ensureDb = (): BetterSqlite3 => {
    if (!db) throw new Error('Database not initialized');
    return db;
  };

  ipcMain.handle('conductor:canvas:list', () => {
    const rows = ensureDb().prepare(
      'SELECT * FROM conductor_canvases ORDER BY sort_order, created_at DESC'
    ).all() as any[];
    return rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      layoutConfig: JSON.parse(r.layout_config),
      sortOrder: r.sort_order,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  });

  ipcMain.handle('conductor:canvas:create', (_event, data: { name: string; description?: string }) => {
    const d = ensureDb();
    const id = randomUUID();
    const now = Date.now();
    d.prepare(
      'INSERT INTO conductor_canvases (id, name, description, layout_config, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, data.name, data.description ?? null, '{}', 0, now, now);

    const row = d.prepare('SELECT * FROM conductor_canvases WHERE id = ?').get(id) as any;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      layoutConfig: JSON.parse(row.layout_config),
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });

  ipcMain.handle('conductor:canvas:update', (_event, id: string, data: { name?: string; description?: string | null; layoutConfig?: Record<string, unknown>; sortOrder?: number }) => {
    const d = ensureDb();
    const now = Date.now();
    const fields: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (data.name !== undefined) {
      fields.push('name = ?');
      values.push(data.name);
    }
    if (data.description !== undefined) {
      fields.push('description = ?');
      values.push(data.description);
    }
    if (data.layoutConfig !== undefined) {
      fields.push('layout_config = ?');
      values.push(JSON.stringify(data.layoutConfig));
    }
    if (data.sortOrder !== undefined) {
      fields.push('sort_order = ?');
      values.push(data.sortOrder);
    }

    values.push(id);
    d.prepare(`UPDATE conductor_canvases SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    const row = d.prepare('SELECT * FROM conductor_canvases WHERE id = ?').get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      layoutConfig: JSON.parse(row.layout_config),
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });

  ipcMain.handle('conductor:canvas:delete', (_event, id: string) => {
    const d = ensureDb();
    const result = d.prepare('DELETE FROM conductor_canvases WHERE id = ?').run(id);
    return result.changes > 0;
  });

  ipcMain.handle('conductor:snapshot', (_event, canvasId: string) => {
    const d = ensureDb();
    const canvas = d.prepare('SELECT * FROM conductor_canvases WHERE id = ?').get(canvasId) as any;
    if (!canvas) return null;

    const elementRows = d.prepare('SELECT * FROM conductor_elements WHERE canvas_id = ?').all(canvasId) as any[];

    let elements: Array<{
      id: string;
      canvasId: string;
      elementKind: string;
      position: unknown;
      config: unknown;
      vizSpec: unknown | null;
      sourceCode: string | null;
      state: string;
      dataVersion: number;
      permissions: unknown;
      metadata: unknown;
      createdAt: number;
      updatedAt: number;
    }> = [];

    if (elementRows.length > 0) {
      elements = elementRows.map((e: any) => ({
        id: e.id,
        canvasId: e.canvas_id,
        elementKind: e.element_kind,
        position: JSON.parse(e.position),
        config: JSON.parse(e.config),
        vizSpec: e.viz_spec ? JSON.parse(e.viz_spec) : null,
        sourceCode: e.source_code,
        state: e.state,
        dataVersion: e.data_version,
        permissions: JSON.parse(e.permissions),
        metadata: JSON.parse(e.metadata),
        createdAt: e.created_at,
        updatedAt: e.updated_at,
      }));
    } else {
      const widgetRows = d.prepare('SELECT * FROM conductor_widgets WHERE canvas_id = ?').all(canvasId) as any[];
      elements = widgetRows.map((w: any) => ({
        id: w.id,
        canvasId: w.canvas_id,
        elementKind: `widget/${w.type}`,
        position: { ...JSON.parse(w.position), zIndex: 0, rotation: 0 },
        config: JSON.parse(w.config),
        vizSpec: null,
        sourceCode: w.source_code,
        state: w.state,
        dataVersion: w.data_version,
        permissions: JSON.parse(w.permissions),
        metadata: { label: `${w.kind}:${w.type}`, tags: [], createdBy: 'user' },
        createdAt: w.created_at,
        updatedAt: w.updated_at,
      }));
    }

    const widgetRows = d.prepare('SELECT * FROM conductor_widgets WHERE canvas_id = ?').all(canvasId) as any[];
    const lastAction = d.prepare('SELECT MAX(id) as max_id FROM conductor_actions WHERE canvas_id = ?').get(canvasId) as { max_id: number | null };

    return {
      canvas: {
        id: canvas.id,
        name: canvas.name,
        description: canvas.description,
        layoutConfig: JSON.parse(canvas.layout_config),
        sortOrder: canvas.sort_order,
        createdAt: canvas.created_at,
        updatedAt: canvas.updated_at,
      },
      elements,
      widgets: widgetRows.map((w: any) => ({
        id: w.id,
        canvasId: w.canvas_id,
        kind: w.kind,
        type: w.type,
        position: JSON.parse(w.position),
        config: JSON.parse(w.config),
        data: JSON.parse(w.data),
        dataVersion: w.data_version,
        sourceCode: w.source_code,
        state: w.state,
        permissions: JSON.parse(w.permissions),
        createdAt: w.created_at,
        updatedAt: w.updated_at,
      })),
      actionCursor: lastAction?.max_id ?? 0,
    };
  });

  ipcMain.handle('conductor:action', (_event, request: Record<string, unknown>) => {
    const d = ensureDb();
    const action = request.action as string;
    const actor = (request.actor as string) || 'user';
    const canvasId = request.canvasId as string;
    const now = Date.now();

    if (!['user', 'agent', 'system'].includes(actor)) {
      throw new Error(`Invalid actor: ${actor}`);
    }

    const writeActionLog = (
      actionType: string,
      widgetId: string | null,
      payload: Record<string, unknown> | null,
      resultPatch: Record<string, unknown> | null,
      reversible: number = 1,
      mergedFrom: string | null = null
    ): number => {
      const result = d.prepare(
        `INSERT INTO conductor_actions (canvas_id, widget_id, actor, action_type, payload, result_patch, merged_from, reversible, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        canvasId,
        widgetId,
        actor,
        actionType,
        payload ? JSON.stringify(payload) : null,
        resultPatch ? JSON.stringify(resultPatch) : null,
        mergedFrom,
        reversible,
        now
      );
      return Number(result.lastInsertRowid);
    };

    const broadcastPatch = (patch: Record<string, unknown>) => {
      const channelManager = getChannelManager();
      channelManager?.sendToChannel('conductor', { type: 'conductor:state:patch', _v2: true, ...patch });
    };

    const txn = d.transaction(() => {
      switch (action) {
        case 'canvas.rename': {
          const name = request.name as string;
          d.prepare('UPDATE conductor_canvases SET name = ?, updated_at = ? WHERE id = ?').run(name, now, canvasId);
          const resultPatch = { name };
          const actionId = writeActionLog(action, null, { name }, resultPatch);
          broadcastPatch({ canvasId, actionId, resultPatch });
          return { success: true, actionId, resultPatch };
        }

        case 'widget.create': {
          const widgetId = randomUUID();
          const kind = request.kind as string;
          const type = request.type as string;
          const position = request.position as Record<string, unknown>;
          const config = (request.config as Record<string, unknown>) || {};
          const data = (request.data as Record<string, unknown>) || {};
          const permissions = (request.permissions as Record<string, unknown>) || {
            agentCanRead: true,
            agentCanWrite: true,
            agentCanDelete: false,
          };

          d.prepare(
            `INSERT INTO conductor_widgets (id, canvas_id, kind, type, position, config, data, data_version, source_code, state, permissions, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, 'idle', ?, ?, ?)`
          ).run(widgetId, canvasId, kind, type, JSON.stringify(position), JSON.stringify(config), JSON.stringify(data), JSON.stringify(permissions), now, now);

          const elementKind = `widget/${type}`;
          const canvasPosition = { x: (position as any).x ?? 0, y: (position as any).y ?? 0, w: (position as any).w ?? 4, h: (position as any).h ?? 3, zIndex: 0, rotation: 0 };
          const mergedConfig = { ...data, ...config };
          const metadata = { label: `${kind}:${type}`, tags: [] as string[], createdBy: actor as string };

          d.prepare(
            `INSERT OR IGNORE INTO conductor_elements (id, canvas_id, element_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, NULL, 'idle', 1, ?, ?, ?, ?)`
          ).run(widgetId, canvasId, elementKind, JSON.stringify(canvasPosition), JSON.stringify(mergedConfig), JSON.stringify(permissions), JSON.stringify(metadata), now, now);

          const element = {
            id: widgetId,
            canvasId,
            elementKind,
            position: canvasPosition,
            config: mergedConfig,
            vizSpec: null,
            state: 'idle',
            dataVersion: 1,
            permissions,
            metadata,
            sourceCode: null,
            createdAt: now,
            updatedAt: now,
          };

          const resultPatch = {
            widget: {
              id: widgetId,
              canvasId,
              kind,
              type,
              position,
              config,
              data,
              dataVersion: 1,
              sourceCode: null,
              state: 'idle',
              permissions,
              createdAt: now,
              updatedAt: now,
            },
            element,
          };
          const actionId = writeActionLog(action, widgetId, { kind, type, position, config, data, permissions }, resultPatch);
          broadcastPatch({ canvasId, widgetId, elementId: widgetId, actionId, resultPatch });
          return { success: true, actionId, widgetId, resultPatch };
        }

        case 'widget.move':
        case 'widget.resize': {
          const widgetId = request.widgetId as string;
          const position = request.position as Record<string, unknown>;
          const prev = d.prepare('SELECT position FROM conductor_widgets WHERE id = ? AND canvas_id = ?').get(widgetId, canvasId) as any;
          if (!prev) throw new Error(`Widget ${widgetId} not found`);

          d.prepare('UPDATE conductor_widgets SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(position), now, widgetId);

          const canvasPosition = { x: (position as any).x ?? 0, y: (position as any).y ?? 0, w: (position as any).w ?? 4, h: (position as any).h ?? 3, zIndex: 0, rotation: 0 };
          d.prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(canvasPosition), now, widgetId);

          const resultPatch = { position, prevPosition: JSON.parse(prev.position) };
          const actionId = writeActionLog(action, widgetId, { position }, resultPatch);
          broadcastPatch({ canvasId, widgetId, elementId: widgetId, actionId, resultPatch });
          return { success: true, actionId, widgetId, resultPatch };
        }

        case 'widget.update_config': {
          const widgetId = request.widgetId as string;
          const config = request.config as Record<string, unknown>;
          const prev = d.prepare('SELECT config FROM conductor_widgets WHERE id = ? AND canvas_id = ?').get(widgetId, canvasId) as any;
          if (!prev) throw new Error(`Widget ${widgetId} not found`);

          d.prepare('UPDATE conductor_widgets SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(config), now, widgetId);

          d.prepare('UPDATE conductor_elements SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(config), now, widgetId);

          const resultPatch = { config, prevConfig: JSON.parse(prev.config) };
          const actionId = writeActionLog(action, widgetId, { config }, resultPatch);
          broadcastPatch({ canvasId, widgetId, elementId: widgetId, actionId, resultPatch });
          return { success: true, actionId, widgetId, resultPatch };
        }

        case 'widget.update_data': {
          const widgetId = request.widgetId as string;
          const data = request.data as Record<string, unknown>;
          const clientTs = request.clientTs as number | undefined;
          const widget = d.prepare('SELECT data, data_version FROM conductor_widgets WHERE id = ? AND canvas_id = ?').get(widgetId, canvasId) as any;
          if (!widget) throw new Error(`Widget ${widgetId} not found`);

          const serverData = JSON.parse(widget.data);
          const merged = mergeWidgetData(serverData, data, { actor, clientTs, serverVersion: widget.data_version });
          const newVersion = widget.data_version + 1;

          d.prepare('UPDATE conductor_widgets SET data = ?, data_version = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(merged.data), newVersion, now, widgetId);

          const element = d.prepare('SELECT config FROM conductor_elements WHERE id = ? AND canvas_id = ?').get(widgetId, canvasId) as any;
          if (element) {
            const existingElementConfig = JSON.parse(element.config);
            const mergedElementConfig = { ...existingElementConfig, ...merged.data };
            d.prepare('UPDATE conductor_elements SET config = ?, data_version = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(mergedElementConfig), newVersion, now, widgetId);
          }

          const resultPatch = { data: merged.data, dataVersion: newVersion, prevData: serverData };
          const actionId = writeActionLog(action, widgetId, { data, clientTs }, resultPatch, 1, merged.mergedFrom ?? null);
          broadcastPatch({ canvasId, widgetId, elementId: widgetId, actionId, resultPatch });
          return { success: true, actionId, widgetId, resultPatch, merged: merged.mergedFrom !== null };
        }

        case 'widget.delete': {
          const widgetId = request.widgetId as string;
          const widget = d.prepare('SELECT * FROM conductor_widgets WHERE id = ? AND canvas_id = ?').get(widgetId, canvasId) as any;
          if (!widget) throw new Error(`Widget ${widgetId} not found`);

          d.prepare('DELETE FROM conductor_widgets WHERE id = ?').run(widgetId);
          d.prepare('DELETE FROM conductor_elements WHERE id = ?').run(widgetId);

          const resultPatch = {
            deletedWidget: {
              id: widget.id,
              kind: widget.kind,
              type: widget.type,
              position: JSON.parse(widget.position),
              config: JSON.parse(widget.config),
              data: JSON.parse(widget.data),
              dataVersion: widget.data_version,
              permissions: JSON.parse(widget.permissions),
            },
          };
          const actionId = writeActionLog(action, widgetId, null, resultPatch);
          broadcastPatch({ canvasId, widgetId, elementId: widgetId, actionId, resultPatch });
          return { success: true, actionId, widgetId, resultPatch };
        }

        case 'widget.restore': {
          const widgetId = request.widgetId as string;
          const lastAction = d.prepare(
            "SELECT * FROM conductor_actions WHERE widget_id = ? AND canvas_id = ? AND action_type = 'widget.delete' AND undone_at IS NULL ORDER BY ts DESC LIMIT 1"
          ).get(widgetId, canvasId) as any;
          if (!lastAction) throw new Error(`No delete action found for widget ${widgetId}`);

          const patch = JSON.parse(lastAction.result_patch);
          const delWidget = patch.deletedWidget;
          if (!delWidget) throw new Error('Restore data not found');

          d.prepare(
            `INSERT INTO conductor_widgets (id, canvas_id, kind, type, position, config, data, data_version, source_code, state, permissions, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'idle', ?, ?, ?)`
          ).run(
            delWidget.id, canvasId, delWidget.kind, delWidget.type,
            JSON.stringify(delWidget.position), JSON.stringify(delWidget.config), JSON.stringify(delWidget.data),
            delWidget.dataVersion, JSON.stringify(delWidget.permissions), now, now
          );

          const elementKind = `widget/${delWidget.type}`;
          const canvasPosition = { x: delWidget.position.x ?? 0, y: delWidget.position.y ?? 0, w: delWidget.position.w ?? 4, h: delWidget.position.h ?? 3, zIndex: 0, rotation: 0 };
          const mergedConfig = { ...delWidget.data, ...delWidget.config };
          const metadata = { label: `${delWidget.kind}:${delWidget.type}`, tags: [] as string[], createdBy: 'user' };
          d.prepare(
            `INSERT OR IGNORE INTO conductor_elements (id, canvas_id, element_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, NULL, 'idle', ?, ?, ?, ?, ?)`
          ).run(delWidget.id, canvasId, elementKind, JSON.stringify(canvasPosition), JSON.stringify(mergedConfig), delWidget.dataVersion, JSON.stringify(delWidget.permissions), JSON.stringify(metadata), now, now);

          const resultPatch = { restoredWidget: delWidget };
          const actionId = writeActionLog(action, widgetId, null, resultPatch);
          broadcastPatch({ canvasId, widgetId, elementId: widgetId, actionId, resultPatch });
          return { success: true, actionId, widgetId, resultPatch };
        }

        case 'element.create': {
          const elementId = randomUUID();
          const elementKind = request.elementKind as string;
          const position = request.position as Record<string, unknown>;
          const vizSpec = (request.vizSpec as Record<string, unknown>) || null;
          const config = (request.config as Record<string, unknown>) || {};
          const permissions = (request.permissions as Record<string, unknown>) || {
            agentCanRead: true,
            agentCanWrite: true,
            agentCanDelete: false,
          };
          const metadata = {
            label: elementKind,
            tags: [] as string[],
            createdBy: actor as string,
          };

          d.prepare(
            `INSERT INTO conductor_elements (id, canvas_id, element_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, 'idle', 1, ?, ?, ?, ?)`
          ).run(elementId, canvasId, elementKind, JSON.stringify(position), JSON.stringify(config), vizSpec ? JSON.stringify(vizSpec) : null, JSON.stringify(permissions), JSON.stringify(metadata), now, now);

          const resultPatch = {
            element: { id: elementId, canvasId, elementKind, position, config, vizSpec, state: 'idle', dataVersion: 1, permissions, metadata, createdAt: now, updatedAt: now },
          };
          const actionId = writeActionLog(action, elementId, { elementKind, position, config, vizSpec, permissions }, resultPatch);
          broadcastPatch({ canvasId, elementId, actionId, resultPatch });
          return { success: true, actionId, elementId, resultPatch };
        }

        case 'element.move': {
          const elementId = request.elementId as string;
          const position = request.position as Record<string, unknown>;
          const prev = d.prepare('SELECT position FROM conductor_elements WHERE id = ? AND canvas_id = ?').get(elementId, canvasId) as any;
          if (!prev) throw new Error(`Element ${elementId} not found`);

          d.prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(position), now, elementId);
          const resultPatch = { position, prevPosition: JSON.parse(prev.position) };
          const actionId = writeActionLog(action, elementId, { position }, resultPatch);
          broadcastPatch({ canvasId, elementId, actionId, resultPatch });
          return { success: true, actionId, elementId, resultPatch };
        }

        case 'element.update': {
          const elementId = request.elementId as string;
          const prev = d.prepare('SELECT config, viz_spec, position FROM conductor_elements WHERE id = ? AND canvas_id = ?').get(elementId, canvasId) as any;
          if (!prev) throw new Error(`Element ${elementId} not found`);

          const prevConfig = JSON.parse(prev.config);
          const prevVizSpec = prev.viz_spec ? JSON.parse(prev.viz_spec) : null;
          const prevPosition = JSON.parse(prev.position);

          const vizSpec = request.vizSpec !== undefined ? (request.vizSpec as Record<string, unknown> | null) : undefined;
          const config = request.config as Record<string, unknown> | undefined;
          const position = request.position as Record<string, unknown> | undefined;

          if (config !== undefined) {
            d.prepare('UPDATE conductor_elements SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(config), now, elementId);
          }
          if (vizSpec !== undefined) {
            d.prepare('UPDATE conductor_elements SET viz_spec = ?, updated_at = ? WHERE id = ?').run(vizSpec ? JSON.stringify(vizSpec) : null, now, elementId);
          }
          if (position !== undefined) {
            d.prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(position), now, elementId);
          }

          const resultPatch: Record<string, unknown> = {};
          if (config !== undefined) { resultPatch.config = config; resultPatch.prevConfig = prevConfig; }
          if (vizSpec !== undefined) { resultPatch.vizSpec = vizSpec; resultPatch.prevVizSpec = prevVizSpec; }
          if (position !== undefined) { resultPatch.position = position; resultPatch.prevPosition = prevPosition; }

          const actionId = writeActionLog(action, elementId, { config, vizSpec, position }, resultPatch);
          broadcastPatch({ canvasId, elementId, actionId, resultPatch });
          return { success: true, actionId, elementId, resultPatch };
        }

        case 'element.delete': {
          const elementId = request.elementId as string;
          const element = d.prepare('SELECT * FROM conductor_elements WHERE id = ? AND canvas_id = ?').get(elementId, canvasId) as any;
          if (!element) throw new Error(`Element ${elementId} not found`);

          d.prepare('DELETE FROM conductor_elements WHERE id = ?').run(elementId);
          const resultPatch = {
            deletedElement: {
              id: element.id,
              elementKind: element.element_kind,
              position: JSON.parse(element.position),
              config: JSON.parse(element.config),
              vizSpec: element.viz_spec ? JSON.parse(element.viz_spec) : null,
              state: element.state,
              dataVersion: element.data_version,
              permissions: JSON.parse(element.permissions),
              metadata: JSON.parse(element.metadata),
            },
          };
          const actionId = writeActionLog(action, elementId, null, resultPatch);
          broadcastPatch({ canvasId, elementId, actionId, resultPatch });
          return { success: true, actionId, elementId, resultPatch };
        }

        case 'element.arrange': {
          const layout = request.layout as Array<{ elementId: string; position: Record<string, unknown> }>;
          const resultPatch: Record<string, unknown> = { layout: [] as Array<{ elementId: string; position: Record<string, unknown> }> };

          for (const item of layout) {
            d.prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ? AND canvas_id = ?').run(JSON.stringify(item.position), now, item.elementId, canvasId);
            (resultPatch.layout as Array<Record<string, unknown>>).push({ elementId: item.elementId, position: item.position });
          }

          const actionId = writeActionLog(action, null, { layout }, resultPatch);
          broadcastPatch({ canvasId, actionId, resultPatch });
          return { success: true, actionId, resultPatch };
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }
    });

    try {
      return txn();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      dbLogger.error('Conductor action failed', error instanceof Error ? error : new Error(msg), { action, canvasId }, LogComponent.DB);
      throw error;
    }
  });

  ipcMain.handle('conductor:undo', (_event, canvasId: string) => {
    const d = ensureDb();
    const now = Date.now();

    const lastAction = d.prepare(
      "SELECT * FROM conductor_actions WHERE canvas_id = ? AND reversible = 1 AND undone_at IS NULL ORDER BY ts DESC LIMIT 1"
    ).get(canvasId) as any;
    if (!lastAction) return { success: false, reason: 'No reversible action to undo' };

    const patch = lastAction.result_patch ? JSON.parse(lastAction.result_patch) : null;
    if (!patch) return { success: false, reason: 'No result patch to invert' };

    const inverted = invertPatch(patch, lastAction.action_type);

    const txn = d.transaction(() => {
      d.prepare('UPDATE conductor_actions SET undone_at = ? WHERE id = ?').run(now, lastAction.id);

      switch (lastAction.action_type) {
        case 'canvas.rename': {
          d.prepare('UPDATE conductor_canvases SET name = ?, updated_at = ? WHERE id = ?').run(inverted.name, now, canvasId);
          break;
        }
        case 'widget.create': {
          d.prepare('DELETE FROM conductor_widgets WHERE id = ?').run(lastAction.widget_id);
          d.prepare('DELETE FROM conductor_elements WHERE id = ?').run(lastAction.widget_id);
          break;
        }
        case 'widget.move':
        case 'widget.resize': {
          d.prepare('UPDATE conductor_widgets SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(inverted.position), now, lastAction.widget_id);
          const widgetPos = inverted.position as any;
          const canvasPos = { x: widgetPos.x ?? 0, y: widgetPos.y ?? 0, w: widgetPos.w ?? 4, h: widgetPos.h ?? 3, zIndex: 0, rotation: 0 };
          d.prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(canvasPos), now, lastAction.widget_id);
          break;
        }
        case 'widget.update_config': {
          d.prepare('UPDATE conductor_widgets SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(inverted.config), now, lastAction.widget_id);
          d.prepare('UPDATE conductor_elements SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(inverted.config), now, lastAction.widget_id);
          break;
        }
        case 'widget.update_data': {
          d.prepare('UPDATE conductor_widgets SET data = ?, data_version = data_version - 1, updated_at = ? WHERE id = ?').run(JSON.stringify(inverted.data), now, lastAction.widget_id);
          d.prepare('UPDATE conductor_elements SET config = ?, data_version = data_version - 1, updated_at = ? WHERE id = ?').run(JSON.stringify(inverted.data), now, lastAction.widget_id);
          break;
        }
        case 'widget.delete': {
          const delWidget = patch.deletedWidget;
          if (delWidget) {
            d.prepare(
              `INSERT INTO conductor_widgets (id, canvas_id, kind, type, position, config, data, data_version, source_code, state, permissions, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'idle', ?, ?, ?)`
            ).run(
              delWidget.id, canvasId, delWidget.kind, delWidget.type,
              JSON.stringify(delWidget.position), JSON.stringify(delWidget.config), JSON.stringify(delWidget.data),
              delWidget.dataVersion, JSON.stringify(delWidget.permissions), now, now
            );
            const dwPos = delWidget.position;
            const ecPos = { x: dwPos.x ?? 0, y: dwPos.y ?? 0, w: dwPos.w ?? 4, h: dwPos.h ?? 3, zIndex: 0, rotation: 0 };
            const mgConfig = { ...delWidget.data, ...delWidget.config };
            const ecMeta = { label: `${delWidget.kind}:${delWidget.type}`, tags: [], createdBy: 'user' };
            d.prepare(
              `INSERT OR IGNORE INTO conductor_elements (id, canvas_id, element_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, NULL, NULL, 'idle', ?, ?, ?, ?, ?)`
            ).run(delWidget.id, canvasId, `widget/${delWidget.type}`, JSON.stringify(ecPos), JSON.stringify(mgConfig), delWidget.dataVersion, JSON.stringify(delWidget.permissions), JSON.stringify(ecMeta), now, now);
          }
          break;
        }
        case 'widget.restore': {
          d.prepare('DELETE FROM conductor_widgets WHERE id = ?').run(lastAction.widget_id);
          d.prepare('DELETE FROM conductor_elements WHERE id = ?').run(lastAction.widget_id);
          break;
        }
        case 'element.create': {
          d.prepare('DELETE FROM conductor_elements WHERE id = ?').run(lastAction.widget_id);
          break;
        }
        case 'element.move': {
          d.prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(inverted.position), now, lastAction.widget_id);
          break;
        }
        case 'element.update': {
          if (inverted.config !== undefined) {
            d.prepare('UPDATE conductor_elements SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(inverted.config), now, lastAction.widget_id);
          }
          if (inverted.vizSpec !== undefined) {
            d.prepare('UPDATE conductor_elements SET viz_spec = ?, updated_at = ? WHERE id = ?').run(inverted.vizSpec ? JSON.stringify(inverted.vizSpec) : null, now, lastAction.widget_id);
          }
          if (inverted.position !== undefined) {
            d.prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(inverted.position), now, lastAction.widget_id);
          }
          break;
        }
        case 'element.delete': {
          const delElement = patch.deletedElement;
          if (delElement) {
            d.prepare(
              `INSERT INTO conductor_elements (id, canvas_id, element_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`
            ).run(
              delElement.id, canvasId, delElement.elementKind,
              JSON.stringify(delElement.position), JSON.stringify(delElement.config),
              delElement.vizSpec ? JSON.stringify(delElement.vizSpec) : null,
              delElement.state, delElement.dataVersion,
              JSON.stringify(delElement.permissions), JSON.stringify(delElement.metadata),
              now, now
            );
          }
          break;
        }
        case 'element.arrange': {
          break;
        }
      }

      const channelManager = getChannelManager();
      channelManager?.sendToChannel('conductor', { type: 'conductor:state:patch', _v2: true, canvasId, undoActionId: lastAction.id, inverted });
    });

    txn();
    return { success: true, actionId: lastAction.id, inverted };
  });

  ipcMain.handle('conductor:redo', (_event, canvasId: string) => {
    const d = ensureDb();
    const now = Date.now();

    const undoneAction = d.prepare(
      "SELECT * FROM conductor_actions WHERE canvas_id = ? AND undone_at IS NOT NULL ORDER BY undone_at DESC LIMIT 1"
    ).get(canvasId) as any;
    if (!undoneAction) return { success: false, reason: 'No action to redo' };

    const patch = undoneAction.result_patch ? JSON.parse(undoneAction.result_patch) : null;
    if (!patch) return { success: false, reason: 'No result patch to redo' };

    const txn = d.transaction(() => {
      d.prepare('UPDATE conductor_actions SET undone_at = NULL WHERE id = ?').run(undoneAction.id);

      switch (undoneAction.action_type) {
        case 'canvas.rename': {
          d.prepare('UPDATE conductor_canvases SET name = ?, updated_at = ? WHERE id = ?').run(patch.name, now, canvasId);
          break;
        }
        case 'widget.create': {
          const widget = patch.widget;
          d.prepare(
            `INSERT INTO conductor_widgets (id, canvas_id, kind, type, position, config, data, data_version, source_code, state, permissions, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'idle', ?, ?, ?)`
          ).run(
            widget.id, canvasId, widget.kind, widget.type,
            JSON.stringify(widget.position), JSON.stringify(widget.config), JSON.stringify(widget.data),
            widget.dataVersion, JSON.stringify(widget.permissions), widget.createdAt, now
          );
          const element = patch.element;
          if (element) {
            d.prepare(
              `INSERT OR IGNORE INTO conductor_elements (id, canvas_id, element_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, NULL, NULL, 'idle', ?, ?, ?, ?, ?)`
            ).run(
              element.id, canvasId, element.elementKind,
              JSON.stringify(element.position), JSON.stringify(element.config),
              element.dataVersion ?? 1,
              JSON.stringify(element.permissions), JSON.stringify(element.metadata),
              element.createdAt ?? now, now
            );
          }
          break;
        }
        case 'widget.move':
        case 'widget.resize': {
          d.prepare('UPDATE conductor_widgets SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(patch.position), now, undoneAction.widget_id);
          const wPos = patch.position as any;
          const cPos = { x: wPos.x ?? 0, y: wPos.y ?? 0, w: wPos.w ?? 4, h: wPos.h ?? 3, zIndex: 0, rotation: 0 };
          d.prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(cPos), now, undoneAction.widget_id);
          break;
        }
        case 'widget.update_config': {
          d.prepare('UPDATE conductor_widgets SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(patch.config), now, undoneAction.widget_id);
          d.prepare('UPDATE conductor_elements SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(patch.config), now, undoneAction.widget_id);
          break;
        }
        case 'widget.update_data': {
          d.prepare('UPDATE conductor_widgets SET data = ?, data_version = data_version + 1, updated_at = ? WHERE id = ?').run(JSON.stringify(patch.data), now, undoneAction.widget_id);
          d.prepare('UPDATE conductor_elements SET config = ?, data_version = data_version + 1, updated_at = ? WHERE id = ?').run(JSON.stringify(patch.data), now, undoneAction.widget_id);
          break;
        }
        case 'widget.delete': {
          d.prepare('DELETE FROM conductor_widgets WHERE id = ?').run(undoneAction.widget_id);
          d.prepare('DELETE FROM conductor_elements WHERE id = ?').run(undoneAction.widget_id);
          break;
        }
        case 'widget.restore': {
          const restoredWidget = patch.restoredWidget;
          if (restoredWidget) {
            d.prepare(
              `INSERT INTO conductor_widgets (id, canvas_id, kind, type, position, config, data, data_version, source_code, state, permissions, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'idle', ?, ?, ?)`
            ).run(
              restoredWidget.id, canvasId, restoredWidget.kind, restoredWidget.type,
              JSON.stringify(restoredWidget.position), JSON.stringify(restoredWidget.config), JSON.stringify(restoredWidget.data),
              restoredWidget.dataVersion, JSON.stringify(restoredWidget.permissions), now, now
            );
            const rsPos = restoredWidget.position;
            const rsCPos = { x: rsPos.x ?? 0, y: rsPos.y ?? 0, w: rsPos.w ?? 4, h: rsPos.h ?? 3, zIndex: 0, rotation: 0 };
            const rsConfig = { ...restoredWidget.data, ...restoredWidget.config };
            const rsMeta = { label: `${restoredWidget.kind}:${restoredWidget.type}`, tags: [], createdBy: 'user' };
            d.prepare(
              `INSERT OR IGNORE INTO conductor_elements (id, canvas_id, element_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, NULL, NULL, 'idle', ?, ?, ?, ?, ?)`
            ).run(restoredWidget.id, canvasId, `widget/${restoredWidget.type}`, JSON.stringify(rsCPos), JSON.stringify(rsConfig), restoredWidget.dataVersion, JSON.stringify(restoredWidget.permissions), JSON.stringify(rsMeta), now, now);
          }
          break;
        }
        case 'element.create': {
          const element = patch.element;
          if (element) {
            d.prepare(
              `INSERT INTO conductor_elements (id, canvas_id, element_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`
            ).run(
              element.id, canvasId, element.elementKind,
              JSON.stringify(element.position), JSON.stringify(element.config),
              element.vizSpec ? JSON.stringify(element.vizSpec) : null,
              element.state, element.dataVersion,
              JSON.stringify(element.permissions), JSON.stringify(element.metadata),
              element.createdAt, now
            );
          }
          break;
        }
        case 'element.move': {
          d.prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(patch.position), now, undoneAction.widget_id);
          break;
        }
        case 'element.update': {
          if (patch.config !== undefined) {
            d.prepare('UPDATE conductor_elements SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(patch.config), now, undoneAction.widget_id);
          }
          if (patch.vizSpec !== undefined) {
            d.prepare('UPDATE conductor_elements SET viz_spec = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(patch.vizSpec), now, undoneAction.widget_id);
          }
          if (patch.position !== undefined) {
            d.prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(patch.position), now, undoneAction.widget_id);
          }
          break;
        }
        case 'element.delete': {
          d.prepare('DELETE FROM conductor_elements WHERE id = ?').run(undoneAction.widget_id);
          break;
        }
        case 'element.arrange': {
          break;
        }
      }

      const channelManager = getChannelManager();
      channelManager?.sendToChannel('conductor', { type: 'conductor:state:patch', _v2: true, canvasId, redoActionId: undoneAction.id, patch });
    });

    txn();
    return { success: true, actionId: undoneAction.id, patch };
  });

  dbLogger.info('Conductor handlers registered', undefined, LogComponent.DB);
}

// ============================================================
// Conductor OT Merge Logic
// ============================================================

interface MergeContext {
  actor: string;
  clientTs?: number;
  serverVersion: number;
}

interface MergeResult {
  data: Record<string, unknown>;
  mergedFrom: string | null;
}

function mergeWidgetData(server: Record<string, unknown>, patch: Record<string, unknown>, context: MergeContext): MergeResult {
  if (context.actor === 'user') {
    return { data: deepMerge(server, patch, 'user'), mergedFrom: null };
  }

  if (context.clientTs && Date.now() - context.clientTs > 30000) {
    dbLogger.warn('Conductor merge: clientTs > 30s old, replacing fully', { clientTs: context.clientTs, serverVersion: context.serverVersion }, LogComponent.DB);
    return { data: patch, mergedFrom: 'full_replace_stale' };
  }

  const merged = deepMerge(server, patch, 'server');
  const hasConflict = JSON.stringify(merged) !== JSON.stringify(patch);
  return {
    data: merged,
    mergedFrom: hasConflict ? 'agent_conflict' : null,
  };
}

function deepMerge(server: Record<string, unknown>, patch: Record<string, unknown>, priority: 'user' | 'server'): Record<string, unknown> {
  const result = { ...server };

  for (const key of Object.keys(patch)) {
    const patchVal = patch[key];
    const serverVal = server[key];

    if (patchVal === undefined) continue;

    if (serverVal === undefined) {
      result[key] = patchVal;
      continue;
    }

    if (Array.isArray(patchVal) && Array.isArray(serverVal)) {
      result[key] = mergeArrays(serverVal as Record<string, unknown>[], patchVal as Record<string, unknown>[]);
    } else if (isPlainObject(patchVal) && isPlainObject(serverVal)) {
      result[key] = deepMerge(serverVal as Record<string, unknown>, patchVal as Record<string, unknown>, priority);
    } else if (serverVal !== patchVal) {
      result[key] = priority === 'user' ? patchVal : serverVal;
    }
  }

  return result;
}

function mergeArrays(server: Record<string, unknown>[], patch: Record<string, unknown>[]): Record<string, unknown>[] {
  const idMap = new Map<string, Record<string, unknown>>();
  for (const item of server) {
    const id = item.id as string;
    if (id) idMap.set(id, { ...item });
  }
  for (const item of patch) {
    const id = item.id as string;
    if (id) {
      const existing = idMap.get(id);
      if (existing) {
        idMap.set(id, deepMerge(existing, item, 'server'));
      } else {
        idMap.set(id, { ...item });
      }
    }
  }
  return Array.from(idMap.values());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invertPatch(patch: Record<string, unknown>, actionType: string): Record<string, unknown> {
  switch (actionType) {
    case 'canvas.rename':
      return { name: patch.prevName || 'Untitled' };
    case 'widget.create':
      return {};
    case 'widget.move':
    case 'widget.resize':
      return { position: (patch as any).prevPosition || patch.position };
    case 'widget.update_config':
      return { config: (patch as any).prevConfig || patch.config };
    case 'widget.update_data':
      return { data: (patch as any).prevData || patch.data };
    case 'widget.delete':
      return {};
    case 'widget.restore':
      return {};
    case 'element.create':
      return {};
    case 'element.move':
      return { position: (patch as any).prevPosition || patch.position };
    case 'element.update':
      return {
        config: (patch as any).prevConfig || patch.config,
        vizSpec: (patch as any).prevVizSpec ?? patch.vizSpec,
        position: (patch as any).prevPosition || patch.position,
      };
    case 'element.delete':
      return {};
    case 'element.arrange':
      return {}
  }
}
