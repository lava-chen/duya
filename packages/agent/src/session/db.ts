/**
 * db.ts - SQLite database layer for session and message persistence
 * Uses better-sqlite3 for synchronous SQLite access
 *
 * Supports dual-mode operation:
 * - IPC mode (DUYA_AGENT_MODE=true): forwards requests to Main Process via IPC
 * - Direct mode (default): directly accesses SQLite database
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { Message, SessionInfo } from '../types.js';
import { getConfigDatabasePath } from '../config.js';
import * as ipcDbClient from '../ipc/db-client.js';
import type BetterSqlite3 from 'better-sqlite3';

// =============================================================================
// IPC Mode Detection
// =============================================================================

/**
 * Check if we're running in IPC mode (Agent subprocess).
 * In IPC mode, database operations are forwarded to Main Process.
 */
const USE_IPC_MODE = process.env.DUYA_AGENT_MODE === 'true' && typeof process.send === 'function';

// Lazy-loaded IPC client (avoid circular dependency)
let ipcClient: typeof import('../ipc/db-client.js') | null = null;

function getIpcClient(): typeof ipcClient {
  if (USE_IPC_MODE && !ipcClient) {
    ipcClient = ipcDbClient;
  }
  return ipcClient;
}

// ============================================================
// Types
// ============================================================

/** Chat session row in the database */
export interface ChatSession {
  id: string;
  title: string | null;
  model: string | null;
  system_prompt: string | null;
  working_directory: string | null;
  project_name: string | null;
  status: string | null;
  mode: string | null;
  permission_profile: string | null;
  provider_id: string | null;
  context_summary: string | null;
  context_summary_updated_at: number | null;
  is_deleted: number | null;
  generation: number;
  agent_profile_id: string | null;
  parent_id: string | null;
  parent_session_id: string | null;
  agent_type: string | null;
  agent_name: string | null;
  created_at: number;
  updated_at: number;
}

/** Message row in the database */
export interface MessageRow {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  name: string | null;
  tool_call_id: string | null;
  token_usage: string | null;
  msg_type: string;
  thinking: string | null;
  tool_name: string | null;
  tool_input: string | null;
  parent_tool_call_id: string | null;
  viz_spec: string | null;
  status: string;
  seq_index: number | null;
  duration_ms: number | null;
  sub_agent_id: string | null;
  created_at: number;
}

/** Session lock row in the database */
export interface SessionLockRow {
  session_id: string;
  lock_id: string;
  owner: string;
  expires_at: number;
}

/** Session data for creation */
export interface CreateSessionData {
  id: string;
  title?: string;
  model?: string;
  system_prompt?: string;
  working_directory?: string;
  project_name?: string;
  status?: string;
  mode?: string;
  provider_id?: string;
  generation?: number;
  parent_id?: string | null;
  parent_session_id?: string | null;
  agent_profile_id?: string | null;
  agent_type?: string;
  agent_name?: string;
}

/** Message data for creation */
export interface CreateMessageData {
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
}

/** Session update data */
export interface UpdateSessionData {
  title?: string;
  model?: string;
  system_prompt?: string;
  working_directory?: string;
  project_name?: string;
  status?: string;
  mode?: string;
  permission_profile?: string;
  provider_id?: string;
  context_summary?: string;
  parent_id?: string | null;
  parent_session_id?: string | null;
  agent_profile_id?: string | null;
  agent_type?: string;
  agent_name?: string;
}

/** Result of replaceMessages operation */
export interface ReplaceMessagesResult {
  success: boolean;
  reason?: 'session_not_found' | 'stale_generation' | 'error';
  messageCount?: number;
}

// ============================================================
// Database Initialization
// ============================================================

let _db: BetterSqlite3.Database | null = null;
let BetterSqlite3Ctor: (new (filename: string) => BetterSqlite3.Database) | null = null;

function getBetterSqlite3Ctor(): new (filename: string) => BetterSqlite3.Database {
  if (BetterSqlite3Ctor) return BetterSqlite3Ctor;
  const require = createRequire(import.meta.url);
  try {
    BetterSqlite3Ctor = require('better-sqlite3') as new (filename: string) => BetterSqlite3.Database;
    return BetterSqlite3Ctor;
  } catch {
    const explicitPath = process.env.DUYA_BETTER_SQLITE3_PATH;
    if (explicitPath) {
      BetterSqlite3Ctor = require(explicitPath) as new (filename: string) => BetterSqlite3.Database;
      return BetterSqlite3Ctor;
    }
    throw new Error('better-sqlite3 not found: both module resolution and DUYA_BETTER_SQLITE3_PATH failed');
  }
}

/**
 * Get the database instance, creating it if necessary.
 * Uses same path logic as frontend (src/lib/db.ts) to ensure consistency.
 */
export function getDb(): BetterSqlite3.Database {
  if (_db) {
    return _db;
  }

  const dbPath = getDbPath();
  const dbDir = path.dirname(dbPath);

  console.log('[Agent DB] Initializing database at:', dbPath);
  console.log('[Agent DB] DUYA_DB_DIR env:', process.env.DUYA_DB_DIR);
  console.log('[Agent DB] NODE_ENV:', process.env.NODE_ENV);

  // Ensure directory exists
  if (!fs.existsSync(dbDir)) {
    console.log('[Agent DB] Creating directory:', dbDir);
    fs.mkdirSync(dbDir, { recursive: true });
  }

  try {
    const BetterSqlite3 = getBetterSqlite3Ctor();
    _db = new BetterSqlite3(dbPath);
    console.log('[Agent DB] Database opened successfully');
  } catch (err) {
    console.error('[Agent DB] Failed to open database:', err);
    console.error('[Agent DB] Error details:', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    throw err;
  }

  // Enable WAL mode for better concurrent access
  // Try to set WAL mode, but don't fail if it doesn't work
  // (e.g., on Windows with certain file system configurations)
  // On Windows, WAL mode can cause issues with file locking
  if (process.platform !== 'win32') {
    try {
      _db.pragma('journal_mode = WAL');
    } catch (err) {
      // WAL mode is optional, continue without it
      console.warn('[Agent DB] Failed to set WAL mode:', err instanceof Error ? err.message : String(err));
    }
  }
  _db.pragma('busy_timeout = 5000');
  _db.pragma('foreign_keys = ON');

  // Initialize schema
  initializeSchema(_db);

  return _db;
}

/**
 * Get the user data directory for the current platform.
 */
function getUserDataPath(): string {
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Roaming');
  } else if (process.platform === 'darwin') {
    return path.join(process.env.HOME || os.homedir(), 'Library', 'Application Support');
  } else {
    return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  }
}

/**
 * Get the default database file path.
 * Both dev and production use APPDATA/DUYA/duya.db for consistency.
 */
function getDefaultDbPath(): string {
  // Check if running as packaged Electron app
  const isPackaged = typeof process !== 'undefined' && (process as NodeJS.Process & { pkg?: unknown }).pkg !== undefined
    ? true
    : process.env.NODE_ENV === 'production';

  // Check if running in CLI mode (CLI always uses production database)
  const isCLI = process.env.DUYA_CLI === 'true' || 
    process.argv[0]?.includes('duya') || 
    process.argv[1]?.includes('duya');

  // If electron passed the database directory via env, use it
  if (isPackaged && process.env.DUYA_DB_DIR) {
    return path.join(process.env.DUYA_DB_DIR, 'duya.db');
  }

  // Use APPDATA/DUYA (or equivalent on other platforms) for both dev and prod
  // This ensures frontend and agent use the same database
  const userDataPath = getUserDataPath();
  return path.join(userDataPath, 'DUYA', 'duya.db');
}

/**
 * Get the database file path.
 * Checks for custom path from config file first, then environment variable.
 */
function getDbPath(): string {
  // Check for custom database path from config file (highest priority)
  const configDbPath = getConfigDatabasePath();
  if (configDbPath && configDbPath.trim()) {
    return path.join(configDbPath.trim(), 'duya.db');
  }

  // Check for custom database path from environment variable
  if (process.env.DUYA_CUSTOM_DB_PATH) {
    return process.env.DUYA_CUSTOM_DB_PATH;
  }

  // Use default path
  return getDefaultDbPath();
}

/**
 * Initialize database schema, creating tables if they don't exist.
 */
function initializeSchema(db: BetterSqlite3.Database): void {
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
    );

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
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id)
    );

    CREATE TABLE IF NOT EXISTS session_runtime_locks (
      session_id TEXT PRIMARY KEY,
      lock_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed')),
      active_form TEXT,
      owner TEXT,
      blocks TEXT NOT NULL DEFAULT '[]',
      blocked_by TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') * 1000 AS INTEGER)),
      updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') * 1000 AS INTEGER)),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner);
  `);

  // Initialize FTS5 for session search
  initializeFts5(db);

  // Schema migration: Add permission_profile column if it doesn't exist
  try {
    const tableInfo = db.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>;
    const columns = tableInfo.map(c => c.name);
    if (!columns.includes('permission_profile')) {
      db.exec(`ALTER TABLE chat_sessions ADD COLUMN permission_profile TEXT NOT NULL DEFAULT 'default'`);
      console.log('[Agent DB] Migration: Added permission_profile column to chat_sessions');
    }
  } catch (error) {
    console.error('[Agent DB] Error adding permission_profile column:', error);
  }

  // Schema migration: Add generation column if it doesn't exist
  try {
    const tableInfo = db.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>;
    const columns = tableInfo.map(c => c.name);
    if (!columns.includes('generation')) {
      db.exec(`ALTER TABLE chat_sessions ADD COLUMN generation INTEGER NOT NULL DEFAULT 0`);
      console.log('[Agent DB] Migration: Added generation column to chat_sessions');
    }
  } catch (error) {
    console.error('[Agent DB] Error adding generation column:', error);
  }

  // Schema migration: Add parent_session_id column if it doesn't exist
  try {
    const tableInfo = db.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>;
    const columns = tableInfo.map(c => c.name);
    if (!columns.includes('parent_session_id')) {
      db.exec(`ALTER TABLE chat_sessions ADD COLUMN parent_session_id TEXT REFERENCES chat_sessions(id)`);
      console.log('[Agent DB] Migration: Added parent_session_id column to chat_sessions');
    }
  } catch (error) {
    console.error('[Agent DB] Error adding parent_session_id column:', error);
  }

  // Schema migration: Add owner, metadata columns to tasks table
  try {
    const tableInfo = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
    const columns = tableInfo.map(c => c.name);
    if (!columns.includes('owner')) {
      db.exec(`ALTER TABLE tasks ADD COLUMN owner TEXT`);
      console.log('[Agent DB] Migration: Added owner column to tasks');
    }
    if (!columns.includes('metadata')) {
      db.exec(`ALTER TABLE tasks ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'`);
      console.log('[Agent DB] Migration: Added metadata column to tasks');
    }
  } catch (error) {
    console.error('[Agent DB] Error adding owner/metadata to tasks:', error);
  }

  // Schema migration: Add agent_profile_id column if it doesn't exist
  try {
    const tableInfo = db.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>;
    const columns = tableInfo.map(c => c.name);
    if (!columns.includes('agent_profile_id')) {
      db.exec(`ALTER TABLE chat_sessions ADD COLUMN agent_profile_id TEXT DEFAULT NULL`);
      console.log('[Agent DB] Migration: Added agent_profile_id column to chat_sessions');
    }
    if (!columns.includes('parent_id')) {
      db.exec(`ALTER TABLE chat_sessions ADD COLUMN parent_id TEXT REFERENCES chat_sessions(id)`);
      console.log('[Agent DB] Migration: Added parent_id column to chat_sessions');
    }
    if (!columns.includes('agent_type')) {
      db.exec(`ALTER TABLE chat_sessions ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'main'`);
      console.log('[Agent DB] Migration: Added agent_type column to chat_sessions');
    }
    if (!columns.includes('agent_name')) {
      db.exec(`ALTER TABLE chat_sessions ADD COLUMN agent_name TEXT NOT NULL DEFAULT ''`);
      console.log('[Agent DB] Migration: Added agent_name column to chat_sessions');
    }
  } catch (error) {
    console.error('[Agent DB] Error adding agent profile columns to chat_sessions:', error);
  }

  // Schema migration: Add name, tool_call_id columns to messages table
  try {
    const tableInfo = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    const columns = tableInfo.map(c => c.name);
    if (!columns.includes('name')) {
      db.exec(`ALTER TABLE messages ADD COLUMN name TEXT`);
      console.log('[Agent DB] Migration: Added name column to messages');
    }
    if (!columns.includes('tool_call_id')) {
      db.exec(`ALTER TABLE messages ADD COLUMN tool_call_id TEXT`);
      console.log('[Agent DB] Migration: Added tool_call_id column to messages');
    }
  } catch (error) {
    console.error('[Agent DB] Error adding columns to messages:', error);
  }
}

/**
 * Initialize FTS5 virtual table for full-text search on messages.
 */
function initializeFts5(db: BetterSqlite3.Database): void {
  try {
    // Check if FTS5 is available
    const fts5Available = db.prepare("SELECT 1 FROM pragma_compile_options WHERE compile_options = 'ENABLE_FTS5'").get();
    if (!fts5Available) {
      console.log('[Agent DB] FTS5 not available, session search will use LIKE fallback');
      return;
    }

    // Create FTS5 virtual table if not exists
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        session_id,
        content,
        tokenize='porter unicode61'
      );
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages WHEN new.msg_type IN ('text', 'tool_result') BEGIN
        INSERT INTO messages_fts(rowid, session_id, content)
        VALUES (new.rowid, new.session_id, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages WHEN old.msg_type IN ('text', 'tool_result') BEGIN
        DELETE FROM messages_fts WHERE rowid = old.rowid;
      END;

      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages WHEN old.msg_type IN ('text', 'tool_result') OR new.msg_type IN ('text', 'tool_result') BEGIN
        DELETE FROM messages_fts WHERE rowid = old.rowid;
        INSERT INTO messages_fts(rowid, session_id, content)
        VALUES (new.rowid, new.session_id, new.content);
      END;
    `);

    const ftsCount = db.prepare('SELECT COUNT(*) as cnt FROM messages_fts').get() as { cnt: number };
    if (ftsCount.cnt === 0) {
      db.exec(`
        INSERT INTO messages_fts(rowid, session_id, content)
        SELECT rowid, session_id, content FROM messages WHERE msg_type IN ('text', 'tool_result');
      `);
      console.log('[Agent DB] FTS5 populated with text + tool_result messages');
    }

    console.log('[Agent DB] FTS5 initialized successfully');
  } catch (error) {
    console.error('[Agent DB] Failed to initialize FTS5:', error);
  }
}

// ============================================================
// Session CRUD Operations
// ============================================================

/**
 * Create a new chat session.
 * @param data - Session creation data
 * @returns The created session
 */
export function createSession(data: CreateSessionData): ChatSession {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.sessionDb.create(data) as unknown as ChatSession;
  }

  const db = getDb();
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO chat_sessions (
      id, title, model, system_prompt, working_directory,
      project_name, status, mode, provider_id, generation,
      agent_profile_id, parent_id, parent_session_id, agent_type, agent_name,
      created_at, updated_at, is_deleted
    ) VALUES (
      @id, @title, @model, @system_prompt, @working_directory,
      @project_name, @status, @mode, @provider_id, @generation,
      @agent_profile_id, @parent_id, @parent_session_id, @agent_type, @agent_name,
      @created_at, @updated_at, 0
    )
  `);

  stmt.run({
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
    agent_profile_id: data.agent_profile_id ?? null,
    parent_id: data.parent_id ?? null,
    parent_session_id: data.parent_session_id ?? null,
    agent_type: data.agent_type ?? 'main',
    agent_name: data.agent_name ?? '',
    created_at: now,
    updated_at: now,
  });

  return getSession(data.id)!;
}

/**
 * Get a chat session by ID.
 * @param sessionId - The session ID
 * @returns The session or null if not found
 */
export function getSession(sessionId: string): ChatSession | null {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.sessionDb.get(sessionId) as unknown as ChatSession | null;
  }

  const db = getDb();
  const stmt = db.prepare('SELECT * FROM chat_sessions WHERE id = ?');
  return stmt.get(sessionId) as ChatSession | null;
}

/**
 * Update a chat session.
 * @param sessionId - The session ID
 * @param data - The update data
 * @returns The updated session or null if not found
 */
export function updateSession(sessionId: string, data: UpdateSessionData): ChatSession | null {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.sessionDb.update(sessionId, data as unknown as Record<string, unknown>) as unknown as ChatSession | null;
  }

  const db = getDb();
  const now = Date.now();

  // Build dynamic update query
  const fields: string[] = ['updated_at = @updated_at'];
  const params: Record<string, unknown> = { sessionId, updated_at: now };

  if (data.title !== undefined) {
    fields.push('title = @title');
    params.title = data.title;
  }
  if (data.model !== undefined) {
    fields.push('model = @model');
    params.model = data.model;
  }
  if (data.system_prompt !== undefined) {
    fields.push('system_prompt = @system_prompt');
    params.system_prompt = data.system_prompt;
  }
  if (data.working_directory !== undefined) {
    fields.push('working_directory = @working_directory');
    params.working_directory = data.working_directory;
  }
  if (data.project_name !== undefined) {
    fields.push('project_name = @project_name');
    params.project_name = data.project_name;
  }
  if (data.status !== undefined) {
    fields.push('status = @status');
    params.status = data.status;
  }
  if (data.mode !== undefined) {
    fields.push('mode = @mode');
    params.mode = data.mode;
  }
  if (data.permission_profile !== undefined) {
    fields.push('permission_profile = @permission_profile');
    params.permission_profile = data.permission_profile;
  }
  if (data.provider_id !== undefined) {
    fields.push('provider_id = @provider_id');
    params.provider_id = data.provider_id;
  }
  if (data.context_summary !== undefined) {
    fields.push('context_summary = @context_summary');
    params.context_summary = data.context_summary;
  }
  if (data.parent_session_id !== undefined) {
    fields.push('parent_session_id = @parent_session_id');
    params.parent_session_id = data.parent_session_id;
  }
  if (data.parent_id !== undefined) {
    fields.push('parent_id = @parent_id');
    params.parent_id = data.parent_id;
  }
  if (data.agent_profile_id !== undefined) {
    fields.push('agent_profile_id = @agent_profile_id');
    params.agent_profile_id = data.agent_profile_id;
  }
  if (data.agent_type !== undefined) {
    fields.push('agent_type = @agent_type');
    params.agent_type = data.agent_type;
  }
  if (data.agent_name !== undefined) {
    fields.push('agent_name = @agent_name');
    params.agent_name = data.agent_name;
  }

  const stmt = db.prepare(`
    UPDATE chat_sessions
    SET ${fields.join(', ')}
    WHERE id = @sessionId
  `);

  stmt.run(params);

  return getSession(sessionId);
}

/**
 * Delete a chat session and all its messages.
 * @param sessionId - The session ID
 * @returns True if deleted, false if not found
 */
export function deleteSession(sessionId: string): boolean {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.sessionDb.delete(sessionId) as unknown as boolean;
  }

  const db = getDb();

  const txn = db.transaction(() => {
    // Delete messages first (foreign key constraint)
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    // Delete session
    const result = db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(sessionId);
    return result.changes > 0;
  });

  return txn();
}

/**
 * List all chat sessions, ordered by updated_at descending.
 * @returns Array of sessions
 */
export function listSessions(): ChatSession[] {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.sessionDb.list() as unknown as ChatSession[];
  }

  const db = getDb();
  const stmt = db.prepare('SELECT * FROM chat_sessions ORDER BY updated_at DESC');
  return stmt.all() as ChatSession[];
}

// ============================================================
// Message CRUD Operations
// ============================================================

/**
 * Add a message to a session.
 * @param data - Message creation data
 * @returns The created message
 */
export function addMessage(data: CreateMessageData): MessageRow {
  const ipc = getIpcClient();
  if (USE_IPC_MODE && ipc) {
    return ipc.messageDb.add(data as unknown as Parameters<typeof ipc.messageDb.add>[0]) as unknown as MessageRow;
  }

  const db = getDb();
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO messages (id, session_id, role, content, name, tool_call_id, token_usage, msg_type, thinking, tool_name, tool_input, parent_tool_call_id, viz_spec, status, seq_index, duration_ms, sub_agent_id, created_at)
    VALUES (@id, @session_id, @role, @content, @name, @tool_call_id, @token_usage, @msg_type, @thinking, @tool_name, @tool_input, @parent_tool_call_id, @viz_spec, @status, @seq_index, @duration_ms, @sub_agent_id, @created_at)
  `);

  stmt.run({
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

  // Update session's updated_at timestamp
  db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, data.session_id);

  const result = db.prepare('SELECT * FROM messages WHERE id = ?').get(data.id) as MessageRow;
  return result;
}

/**
 * Get all messages for a session, ordered by created_at ascending.
 * @param sessionId - The session ID
 * @returns Array of messages
 */
export function getMessages(sessionId: string): MessageRow[] {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.messageDb.getBySession(sessionId) as unknown as MessageRow[];
  }

  const db = getDb();
  const stmt = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC');
  return stmt.all(sessionId) as MessageRow[];
}

/**
 * Get the count of messages for a session.
 * @param sessionId - The session ID
 * @returns Message count
 */
export function getMessageCount(sessionId: string): number {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.messageDb.getCount(sessionId) as unknown as number;
  }

  const db = getDb();
  const stmt = db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?');
  const result = stmt.get(sessionId) as { count: number };
  return result.count;
}

/**
 * Delete all messages for a session.
 * @param sessionId - The session ID
 * @returns Number of deleted messages
 */
export function clearMessages(sessionId: string): number {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.messageDb.deleteBySession(sessionId) as unknown as number;
  }

  const db = getDb();
  const now = Date.now();

  const txn = db.transaction(() => {
    const result = db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    // Update session's updated_at
    db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
    return result.changes;
  });

  return txn();
}

// ============================================================
// Lock Management
// ============================================================

/**
 * Attempt to acquire a session lock.
 * @param sessionId - The session ID
 * @param lockId - Unique lock identifier (e.g., request ID)
 * @param owner - Owner identifier (e.g., instance ID)
 * @param ttlSec - Time-to-live in seconds (default: 300)
 * @returns True if lock acquired, false if session is already locked
 */
export function acquireSessionLock(
  sessionId: string,
  lockId: string,
  owner: string,
  ttlSec: number = 300,
): boolean {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.lockDb.acquire(sessionId, lockId, owner, ttlSec) as unknown as boolean;
  }

  const db = getDb();
  const now = Date.now();
  const expiresAt = now + ttlSec * 1000;

  const txn = db.transaction(() => {
    // Delete expired locks first
    db.prepare('DELETE FROM session_runtime_locks WHERE expires_at < ?').run(now);

    // Try to insert — PK conflict means session is already locked
    try {
      db.prepare(
        'INSERT INTO session_runtime_locks (session_id, lock_id, owner, expires_at) VALUES (?, ?, ?, ?)'
      ).run(sessionId, lockId, owner, expiresAt);
      return true;
    } catch {
      // Lock already exists for this session
      return false;
    }
  });

  return txn();
}

/**
 * Renew an existing session lock by extending its expiry.
 * @param sessionId - The session ID
 * @param lockId - Lock identifier
 * @param ttlSec - New time-to-live in seconds (default: 300)
 * @returns True if lock was renewed, false if lock not found or not owned
 */
export function renewSessionLock(
  sessionId: string,
  lockId: string,
  ttlSec: number = 300,
): boolean {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.lockDb.renew(sessionId, lockId, ttlSec) as unknown as boolean;
  }

  const db = getDb();
  const now = Date.now();
  const expiresAt = now + ttlSec * 1000;

  const result = db.prepare(
    'UPDATE session_runtime_locks SET expires_at = ? WHERE session_id = ? AND lock_id = ?'
  ).run(expiresAt, sessionId, lockId);

  return result.changes > 0;
}

/**
 * Release a session lock.
 * @param sessionId - The session ID
 * @param lockId - Lock identifier
 * @returns True if lock was released, false if lock not found
 */
export function releaseSessionLock(sessionId: string, lockId: string): boolean {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.lockDb.release(sessionId, lockId) as unknown as boolean;
  }

  const db = getDb();
  const result = db.prepare(
    'DELETE FROM session_runtime_locks WHERE session_id = ? AND lock_id = ?'
  ).run(sessionId, lockId);
  return result.changes > 0;
}

/**
 * Check if a session is currently locked.
 * @param sessionId - The session ID
 * @returns True if locked, false otherwise
 */
export function isSessionLocked(sessionId: string): boolean {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.lockDb.isLocked(sessionId) as unknown as boolean;
  }

  const db = getDb();
  const now = Date.now();

  // Clean up expired locks first
  db.prepare('DELETE FROM session_runtime_locks WHERE expires_at < ?').run(now);

  const stmt = db.prepare('SELECT 1 FROM session_runtime_locks WHERE session_id = ?');
  return stmt.get(sessionId) !== undefined;
}

// ============================================================
// Utility Functions
// ============================================================

/**
 * Convert a MessageRow to a Message object.
 * @param row - The database row
 * @returns The message object
 */
export function messageRowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    role: row.role as Message['role'],
    content: row.content,
    timestamp: row.created_at,
  };
}

/**
 * Convert a ChatSession to SessionInfo.
 * @param session - The chat session
 * @returns The session info
 */
export function sessionToSessionInfo(session: ChatSession): SessionInfo {
  return {
    id: session.id,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    messageCount: getMessageCount(session.id),
  };
}

/**
 * Replace all messages for a session with new messages.
 * Used after streaming completes to persist the agent's complete message history.
 * Includes generation tracking to prevent stale writes from overwriting newer data.
 *
 * @param sessionId - The session ID
 * @param messages - The new messages to persist (can be readonly)
 * @param generation - The generation number for this write attempt
 * @returns ReplaceMessagesResult indicating success or failure reason
 */
export async function replaceMessages(
  sessionId: string,
  messages: readonly Message[],
  generation: number
): Promise<ReplaceMessagesResult> {
  if (USE_IPC_MODE && getIpcClient()) {
    try {
      const result = await getIpcClient()!.messageDb.replace(sessionId, [...messages] as unknown[], generation);
      return result as ReplaceMessagesResult;
    } catch (err) {
      console.error('[DB] IPC replaceMessages failed:', err);
      throw err;
    }
  }

  const db = getDb();
  const now = Date.now();

  try {
    // Check if this is a stale write (generation mismatch)
    const session = db.prepare('SELECT generation FROM chat_sessions WHERE id = ?').get(sessionId) as { generation: number } | undefined;
    if (!session) {
      return { success: false, reason: 'session_not_found' };
    }

    // Skip if generation doesn't match (stale write from old request)
    if (generation < session.generation) {
      console.log(`[Agent DB] Skipping stale replaceMessages: gen=${generation}, current=${session.generation}`);
      return { success: false, reason: 'stale_generation' };
    }

    const txn = db.transaction(() => {
      const newGeneration = Math.max(generation, session.generation + 1);
      db.prepare('UPDATE chat_sessions SET generation = ?, updated_at = ? WHERE id = ?')
        .run(newGeneration, now, sessionId);

      db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);

      const stmt = db.prepare(`
        INSERT INTO messages (id, session_id, role, content, name, tool_call_id, token_usage, msg_type, thinking, tool_name, tool_input, parent_tool_call_id, viz_spec, status, seq_index, duration_ms, sub_agent_id, created_at)
        VALUES (@id, @session_id, @role, @content, @name, @tool_call_id, @token_usage, @msg_type, @thinking, @tool_name, @tool_input, @parent_tool_call_id, @viz_spec, @status, @seq_index, @duration_ms, @sub_agent_id, @created_at)
      `);

      for (const msg of messages) {
        let msgType = msg.msg_type || 'text';
        let thinking: string | null = msg.thinking || null;
        let toolName: string | null = msg.tool_name || null;
        let toolInput: string | null = msg.tool_input || null;
        let parentToolCallId: string | null = msg.parent_tool_call_id || null;
        let vizSpec: string | null = msg.viz_spec || null;
        let contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

        if (!msg.msg_type && Array.isArray(msg.content)) {
          const blocks = msg.content as Array<{ type: string; thinking?: string; name?: string; input?: unknown; tool_use_id?: string }>;
          const types = blocks.map(b => b.type);
          const toolUseBlock = blocks.find(b => b.type === 'tool_use' && b.name === 'show_widget');
          if (toolUseBlock) {
            const widgetCode = (toolUseBlock.input as Record<string, unknown>)?.widget_code;
            if (typeof widgetCode === 'string' && widgetCode.trim()) {
              msgType = 'viz';
              vizSpec = widgetCode;
              contentStr = widgetCode;
            }
          } else if (types.includes('thinking') && types.length === 1) {
            msgType = 'thinking';
            thinking = blocks[0].thinking || null;
            contentStr = thinking || '';
          } else if (types.includes('tool_use') && types.length === 1) {
            msgType = 'tool_use';
            toolName = blocks[0].name || null;
            toolInput = blocks[0].input ? JSON.stringify(blocks[0].input) : null;
          } else if (msg.role === 'tool') {
            msgType = 'tool_result';
            parentToolCallId = msg.tool_call_id || null;
          } else {
            const thinkingBlock = blocks.find(b => b.type === 'thinking');
            if (thinkingBlock) thinking = thinkingBlock.thinking || null;
          }
        } else if (!msg.msg_type && typeof msg.content === 'string') {
          if (msg.role === 'tool') {
            msgType = 'tool_result';
            parentToolCallId = msg.tool_call_id || null;
          }
        }

        // Infer status for tool messages if not explicitly set
        let messageStatus = msg.status;
        if (!messageStatus && msg.role === 'tool' && typeof contentStr === 'string' && contentStr.includes('<tool_error>')) {
          messageStatus = 'error';
        }

        stmt.run({
          id: msg.id || crypto.randomUUID(),
          session_id: sessionId,
          role: msg.role,
          content: contentStr,
          name: msg.name || null,
          tool_call_id: msg.tool_call_id || null,
          token_usage: (msg as unknown as Record<string, unknown>).token_usage as string || null,
          msg_type: msgType,
          thinking,
          tool_name: toolName,
          tool_input: toolInput,
          parent_tool_call_id: parentToolCallId,
          viz_spec: vizSpec,
          status: messageStatus || 'done',
          seq_index: msg.seq_index ?? null,
          duration_ms: msg.duration_ms ?? null,
          sub_agent_id: msg.sub_agent_id || null,
          created_at: msg.timestamp || now,
        });
      }
    });

    txn();
    return { success: true, messageCount: messages.length };
  } catch (error) {
    console.error('[Agent DB] replaceMessages failed:', error);
    return { success: false, reason: 'error' };
  }
}
