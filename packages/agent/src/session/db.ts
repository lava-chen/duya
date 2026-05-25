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
import type { Message, MessageContent, SessionInfo, FileAttachment } from '../types.js';
import { getConfigDatabasePath } from '../config/index.js';
import * as ipcDbClient from '../ipc/db-client.js';
import type BetterSqlite3 from 'better-sqlite3';
import { logger } from '../utils/logger.js';

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
  attachments: string | null;
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
  attachments?: unknown[];
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

/** Attachment row in the database */
export interface AttachmentRow {
  id: string;
  message_id: string;
  session_id: string;
  attachment_type: string;
  mime_type: string;
  data: string;
  original_url: string | null;
  created_at: number;
}

/** Extracted image attachment from message content for storage */
export interface ExtractedAttachment {
  messageId: string;
  index: number;
  mimeType: string;
  base64Data: string;
  originalUrl?: string;
}

/** Result of replaceMessages operation */
export interface ReplaceMessagesResult {
  success: boolean;
  reason?: 'session_not_found' | 'stale_generation' | 'error' | 'flushed';
  messageCount?: number;
}

/** Research session row in the database */
export interface ResearchSessionRow {
  id: string;
  session_id: string;
  original_query: string;
  clarification: string | null;  // JSON: { [questionId]: answer }
  context_json: string;         // JSON: serialized ResearchContext
  status: 'active' | 'completed' | 'aborted';
  current_phase: string;
  iterations: number;
  coverage: number;
  created_at: number;
  updated_at: number;
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

  logger.info('Initializing database', { dbPath, env: process.env.DUYA_DB_DIR, nodeEnv: process.env.NODE_ENV }, 'DB');

  // Ensure directory exists
  if (!fs.existsSync(dbDir)) {
    logger.info('Creating database directory', { dbDir }, 'DB');
    fs.mkdirSync(dbDir, { recursive: true });
  }

  try {
    const BetterSqlite3 = getBetterSqlite3Ctor();
    _db = new BetterSqlite3(dbPath);
    logger.info('Database opened successfully', { dbPath }, 'DB');
  } catch (err) {
    logger.error('Failed to open database', err instanceof Error ? err : new Error(String(err)), { dbPath }, 'DB');
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
      logger.warn('Failed to set WAL mode, continuing without it', { error: err instanceof Error ? err.message : String(err) }, 'DB');
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

    -- Message attachments table for storing base64 image data
    -- Prevents MiniMax CDN URL substitution from affecting agent behavior
    CREATE TABLE IF NOT EXISTS message_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      attachment_type TEXT NOT NULL DEFAULT 'image',
      mime_type TEXT NOT NULL,
      data TEXT NOT NULL,
      original_url TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON message_attachments(message_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_session_id ON message_attachments(session_id);

    -- Model capabilities cache for multimodal detection
    -- Stores API-probed or regex-detected multimodal support per model
    CREATE TABLE IF NOT EXISTS model_capabilities (
      id TEXT PRIMARY KEY,
      is_multimodal INTEGER NOT NULL,
      detected_at INTEGER NOT NULL,
      detection_method TEXT NOT NULL DEFAULT 'unknown'
    );
  `);

  // Initialize FTS5 for session search
  initializeFts5(db);

  // Schema migration: Add permission_profile column if it doesn't exist
  try {
    const tableInfo = db.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>;
    const columns = tableInfo.map(c => c.name);
    if (!columns.includes('permission_profile')) {
      db.exec(`ALTER TABLE chat_sessions ADD COLUMN permission_profile TEXT NOT NULL DEFAULT 'default'`);
      logger.info('Migration: Added permission_profile column to chat_sessions', undefined, 'DB');
    }
  } catch (error) {
    logger.error('Migration failed: adding permission_profile column', error instanceof Error ? error : undefined, undefined, 'DB');
  }

  // Schema migration: Add generation column if it doesn't exist
  try {
    const tableInfo = db.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>;
    const columns = tableInfo.map(c => c.name);
    if (!columns.includes('generation')) {
      db.exec(`ALTER TABLE chat_sessions ADD COLUMN generation INTEGER NOT NULL DEFAULT 0`);
      logger.info('Migration: Added generation column to chat_sessions', undefined, 'DB');
    }
  } catch (error) {
    logger.error('Migration failed: adding generation column', error instanceof Error ? error : undefined, undefined, 'DB');
  }

  // Schema migration: Add parent_session_id column if it doesn't exist
  try {
    const tableInfo = db.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>;
    const columns = tableInfo.map(c => c.name);
    if (!columns.includes('parent_session_id')) {
      db.exec(`ALTER TABLE chat_sessions ADD COLUMN parent_session_id TEXT REFERENCES chat_sessions(id)`);
      logger.info('Migration: Added parent_session_id column to chat_sessions', undefined, 'DB');
    }
  } catch (error) {
    logger.error('Migration failed: adding parent_session_id column', error instanceof Error ? error : undefined, undefined, 'DB');
  }

  // Schema migration: Add owner, metadata columns to tasks table
  try {
    const tableInfo = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
    const columns = tableInfo.map(c => c.name);
    if (!columns.includes('owner')) {
      db.exec(`ALTER TABLE tasks ADD COLUMN owner TEXT`);
      logger.info('Migration: Added owner column to tasks', undefined, 'DB');
    }
    if (!columns.includes('metadata')) {
      db.exec(`ALTER TABLE tasks ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'`);
      logger.info('Migration: Added metadata column to tasks', undefined, 'DB');
    }
  } catch (error) {
    logger.error('Migration failed: adding owner/metadata to tasks', error instanceof Error ? error : undefined, undefined, 'DB');
  }

  // Schema migration: Add agent_profile_id column if it doesn't exist
  try {
    const tableInfo = db.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>;
    const columns = tableInfo.map(c => c.name);
    if (!columns.includes('agent_profile_id')) {
      db.exec(`ALTER TABLE chat_sessions ADD COLUMN agent_profile_id TEXT DEFAULT NULL`);
      logger.info('Migration: Added agent_profile_id column to chat_sessions', undefined, 'DB');
    }
    if (!columns.includes('parent_id')) {
      db.exec(`ALTER TABLE chat_sessions ADD COLUMN parent_id TEXT REFERENCES chat_sessions(id)`);
      logger.info('Migration: Added parent_id column to chat_sessions', undefined, 'DB');
    }
    if (!columns.includes('agent_type')) {
      db.exec(`ALTER TABLE chat_sessions ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'main'`);
      logger.info('Migration: Added agent_type column to chat_sessions', undefined, 'DB');
    }
    if (!columns.includes('agent_name')) {
      db.exec(`ALTER TABLE chat_sessions ADD COLUMN agent_name TEXT NOT NULL DEFAULT ''`);
      logger.info('Migration: Added agent_name column to chat_sessions', undefined, 'DB');
    }
  } catch (error) {
    logger.error('Migration failed: adding agent profile columns to chat_sessions', error instanceof Error ? error : undefined, undefined, 'DB');
  }

  // Schema migration: Add name, tool_call_id columns to messages table
  try {
    const tableInfo = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    const columns = tableInfo.map(c => c.name);
    if (!columns.includes('name')) {
      db.exec(`ALTER TABLE messages ADD COLUMN name TEXT`);
      logger.info('Migration: Added name column to messages', undefined, 'DB');
    }
    if (!columns.includes('tool_call_id')) {
      db.exec(`ALTER TABLE messages ADD COLUMN tool_call_id TEXT`);
      logger.info('Migration: Added tool_call_id column to messages', undefined, 'DB');
    }
  } catch (error) {
    logger.error('Migration failed: adding columns to messages', error instanceof Error ? error : undefined, undefined, 'DB');
  }

  // Schema migration: Create message_attachments table if not exists (for base64 image storage)
  try {
    const attachmentsTableInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message_attachments'").get();
    if (!attachmentsTableInfo) {
      db.exec(`
        CREATE TABLE message_attachments (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          attachment_type TEXT NOT NULL DEFAULT 'image',
          mime_type TEXT NOT NULL,
          data TEXT NOT NULL,
          original_url TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
          FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_attachments_message_id ON message_attachments(message_id);
        CREATE INDEX idx_attachments_session_id ON message_attachments(session_id);
      `);
      logger.info('Migration: Created message_attachments table', undefined, 'DB');
    }
  } catch (error) {
    logger.error('Migration failed: creating message_attachments table', error instanceof Error ? error : undefined, undefined, 'DB');
  }

  // Schema migration: Create model_capabilities table for multimodal detection cache
  try {
    const mcTableInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='model_capabilities'").get();
    if (!mcTableInfo) {
      db.exec(`
        CREATE TABLE model_capabilities (
          id TEXT PRIMARY KEY,
          is_multimodal INTEGER NOT NULL,
          detected_at INTEGER NOT NULL,
          detection_method TEXT NOT NULL DEFAULT 'unknown'
        )
      `);
      logger.info('Migration: Created model_capabilities table', undefined, 'DB');
    }
  } catch (error) {
    logger.error('Migration failed: creating model_capabilities table', error instanceof Error ? error : undefined, undefined, 'DB');
  }

  // Schema migration: Create research_sessions table for Research Mode (Plan 60)
  try {
    const researchTableInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='research_sessions'").get();
    if (!researchTableInfo) {
      db.exec(`
        CREATE TABLE research_sessions (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          original_query TEXT NOT NULL,
          clarification TEXT,
          context_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          current_phase TEXT NOT NULL DEFAULT 'idle',
          iterations INTEGER NOT NULL DEFAULT 0,
          coverage REAL NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_research_sessions_session ON research_sessions(session_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_research_sessions_status ON research_sessions(status)`);
      logger.info('Migration: Created research_sessions table', undefined, 'DB');
    }
  } catch (error) {
    logger.error('Migration failed: creating research_sessions table', error instanceof Error ? error : undefined, undefined, 'DB');
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
      logger.info('FTS5 not available, session search will use LIKE fallback', undefined, 'DB');
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
      logger.info('FTS5 populated with text + tool_result messages', undefined, 'DB');
    }

    logger.info('FTS5 initialized successfully', undefined, 'DB');
  } catch (error) {
    logger.error('Failed to initialize FTS5', error instanceof Error ? error : undefined, undefined, 'DB');
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

  // Return constructed session directly instead of re-querying
  return {
    id: data.id,
    title: data.title ?? 'New Chat',
    model: data.model ?? '',
    system_prompt: data.system_prompt ?? '',
    working_directory: data.working_directory ?? '',
    project_name: data.project_name ?? '',
    status: data.status ?? 'active',
    mode: data.mode ?? 'code',
    permission_profile: null,
    provider_id: data.provider_id ?? 'env',
    context_summary: null,
    context_summary_updated_at: null,
    is_deleted: 0,
    generation: data.generation ?? 0,
    agent_profile_id: data.agent_profile_id ?? null,
    parent_id: data.parent_id ?? null,
    parent_session_id: data.parent_session_id ?? null,
    agent_type: data.agent_type ?? 'main',
    agent_name: data.agent_name ?? '',
    created_at: now,
    updated_at: now,
  };
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
    INSERT INTO messages (id, session_id, role, content, name, tool_call_id, token_usage, msg_type, thinking, tool_name, tool_input, parent_tool_call_id, viz_spec, status, seq_index, duration_ms, sub_agent_id, attachments, created_at)
    VALUES (@id, @session_id, @role, @content, @name, @tool_call_id, @token_usage, @msg_type, @thinking, @tool_name, @tool_input, @parent_tool_call_id, @viz_spec, @status, @seq_index, @duration_ms, @sub_agent_id, @attachments, @created_at)
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
    attachments: data.attachments
      ? (typeof data.attachments === 'string' ? data.attachments : JSON.stringify(data.attachments))
      : null,
    created_at: now,
  });

  // Update session's updated_at timestamp
  db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, data.session_id);

  // Return constructed MessageRow directly instead of re-querying
  return {
    id: data.id,
    session_id: data.session_id,
    role: data.role as 'user' | 'assistant' | 'system' | 'tool',
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
    attachments: data.attachments
      ? (typeof data.attachments === 'string' ? data.attachments : JSON.stringify(data.attachments))
      : null,
    created_at: now,
  };
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
 * Get messages with attachment rehydration.
 * This is the preferred method for loading session messages that may contain
 * image blocks with CDN URLs. It replaces CDN URLs with locally stored base64 data.
 */
export function getMessagesWithAttachments(sessionId: string): Message[] {
  if (USE_IPC_MODE && getIpcClient()) {
    const rows = getIpcClient()!.messageDb.getBySession(sessionId) as unknown as MessageRow[];
    return rows.map(row => messageRowToMessage(row));
  }

  const db = getDb();
  const rows = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as MessageRow[];

  // Bulk-load all attachments for the session for efficient rehydration
  const attachmentMap = getAttachmentsForSession(sessionId);
  return rows.map(row => messageRowToMessage(row, attachmentMap));
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
// Attachment CRUD Operations
// ============================================================

/**
 * Extract image base64 data from a MessageContent array.
 * Returns an array of ExtractedAttachment for storage.
 */
export function extractAttachmentsFromContent(
  messageId: string,
  content: string | MessageContent[],
): ExtractedAttachment[] {
  const attachments: ExtractedAttachment[] = [];
  if (typeof content !== 'string' && Array.isArray(content)) {
    let index = 0;
    for (const block of content) {
      if (block.type === 'image') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const imgBlock = block as any;
        if (imgBlock.source?.type === 'base64' && imgBlock.source?.data) {
          attachments.push({
            messageId,
            index,
            mimeType: imgBlock.source.media_type || 'image/png',
            base64Data: imgBlock.source.data,
          });
        }
      }
      index++;
    }
  }
  return attachments;
}

/**
 * Store a batch of extracted attachments for a message.
 * Replaces any existing attachments for the same message.
 */
export function storeAttachments(attachments: ExtractedAttachment[], sessionId: string): void {
  if (attachments.length === 0) return;

  if (USE_IPC_MODE && getIpcClient()) {
    // Forward to IPC client
    const db = getDb();
    const txn = db.transaction(() => {
      // Batch delete using prepared statement
      const messageIds = [...new Set(attachments.map(a => a.messageId))];
      if (messageIds.length > 0) {
        const placeholders = messageIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM message_attachments WHERE message_id IN (${placeholders})`).run(...messageIds);
      }
      // Insert new attachments using prepared statement
      const stmt = db.prepare(`
        INSERT INTO message_attachments (id, message_id, session_id, attachment_type, mime_type, data, original_url, created_at)
        VALUES (@id, @message_id, @session_id, @attachment_type, @mime_type, @data, @original_url, @created_at)
      `);
      for (const att of attachments) {
        stmt.run({
          id: `${att.messageId}-${att.index}`,
          message_id: att.messageId,
          session_id: sessionId,
          attachment_type: 'image',
          mime_type: att.mimeType,
          data: att.base64Data,
          original_url: att.originalUrl || null,
          created_at: Date.now(),
        });
      }
    });
    txn();
    return;
  }

  const db = getDb();
  const txn = db.transaction(() => {
    // Delete existing attachments for these messages using batch DELETE
    const messageIds = [...new Set(attachments.map(a => a.messageId))];
    if (messageIds.length > 0) {
      const placeholders = messageIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM message_attachments WHERE message_id IN (${placeholders})`).run(...messageIds);
    }
    // Insert new attachments using prepared statement
    const stmt = db.prepare(`
      INSERT INTO message_attachments (id, message_id, session_id, attachment_type, mime_type, data, original_url, created_at)
      VALUES (@id, @message_id, @session_id, @attachment_type, @mime_type, @data, @original_url, @created_at)
    `);
    for (const att of attachments) {
      stmt.run({
        id: `${att.messageId}-${att.index}`,
        message_id: att.messageId,
        session_id: sessionId,
        attachment_type: 'image',
        mime_type: att.mimeType,
        data: att.base64Data,
        original_url: att.originalUrl || null,
        created_at: Date.now(),
      });
    }
  });
  txn();
}

/**
 * Get all attachments for a specific message.
 */
export function getAttachmentsForMessage(messageId: string): AttachmentRow[] {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM message_attachments WHERE message_id = ? ORDER BY created_at ASC');
  return stmt.all(messageId) as AttachmentRow[];
}

/**
 * Get all attachments for a session (for bulk rehydration).
 */
export function getAttachmentsForSession(sessionId: string): Map<string, AttachmentRow[]> {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM message_attachments WHERE session_id = ? ORDER BY created_at ASC');
  const rows = stmt.all(sessionId) as AttachmentRow[];
  const map = new Map<string, AttachmentRow[]>();
  for (const row of rows) {
    const existing = map.get(row.message_id) || [];
    existing.push(row);
    map.set(row.message_id, existing);
  }
  return map;
}

/**
 * Delete attachments for a session.
 */
export function deleteAttachmentsForSession(sessionId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM message_attachments WHERE session_id = ?').run(sessionId);
}

// ============================================================
// Parsed Document Attachment Operations
// ============================================================

/** Parsed document data stored in message_attachments table */
export interface ParsedDocumentAttachment {
  id: string;
  message_id: string;
  session_id: string;
  filename: string;
  filePath: string;
  charCount: number;
  extractMethod: string | null;
  text: string;
  imageChunks: string | null; // JSON array of { base64, mediaType }
  created_at: number;
}

/**
 * Store parsed document content as an attachment in the message_attachments table.
 * This allows the agent to read document content from DB on restart.
 */
export function storeParsedDocumentAttachment(
  messageId: string,
  sessionId: string,
  data: {
    filename: string;
    filePath: string;
    charCount: number;
    text: string;
    extractMethod?: string;
    imageChunks?: Array<{ base64: string; mediaType: string }>;
  }
): void {
  // Guard against null/undefined messageId
  if (!messageId) {
    logger.warn('storeParsedDocumentAttachment: messageId is empty, skipping', { data: data.filename }, 'DB');
    return;
  }

  if (USE_IPC_MODE && getIpcClient()) {
    getIpcClient()!.attachmentDb.storeParsedDocument(messageId, sessionId, data);
    return;
  }

  const db = getDb();
  const id = `${messageId}-parsed-doc`;
  const imageChunks = data.imageChunks ? JSON.stringify(data.imageChunks) : null;

  db.prepare(`
    INSERT OR REPLACE INTO message_attachments (id, message_id, session_id, attachment_type, mime_type, data, original_url, created_at)
    VALUES (@id, @message_id, @session_id, @attachment_type, @mime_type, @data, @original_url, @created_at)
  `).run({
    id,
    message_id: messageId,
    session_id: sessionId,
    attachment_type: 'parsed_document',
    mime_type: 'application/pdf', // placeholder, not used for parsed docs
    data: JSON.stringify({
      filename: data.filename,
      filePath: data.filePath,
      charCount: data.charCount,
      text: data.text,
      extractMethod: data.extractMethod || null,
      imageChunks: data.imageChunks || [],
    }),
    original_url: data.filePath,
    created_at: Date.now(),
  });
}

/**
 * Get all parsed document attachments for a session.
 * Returns documents as structured ParsedDocumentAttachment objects.
 */
export function getParsedDocumentAttachmentsForSession(sessionId: string): ParsedDocumentAttachment[] {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.attachmentDb.getParsedDocumentsForSession(sessionId) as unknown as ParsedDocumentAttachment[];
  }

  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM message_attachments
    WHERE session_id = ? AND attachment_type = 'parsed_document'
    ORDER BY created_at ASC
  `);
  const rows = stmt.all(sessionId) as Array<{
    id: string;
    message_id: string;
    session_id: string;
    data: string;
    original_url: string | null;
    created_at: number;
  }>;

  return rows.map((row) => {
    const parsed = JSON.parse(row.data);
    return {
      id: row.id,
      message_id: row.message_id,
      session_id: row.session_id,
      filename: parsed.filename || '',
      filePath: parsed.filePath || row.original_url || '',
      charCount: parsed.charCount || 0,
      extractMethod: parsed.extractMethod || null,
      text: parsed.text || '',
      imageChunks: parsed.imageChunks ? JSON.stringify(parsed.imageChunks) : null,
      created_at: row.created_at,
    };
  });
}

/**
 * Get parsed document attachments for a specific message.
 */
export function getParsedDocumentAttachmentsForMessage(messageId: string): ParsedDocumentAttachment[] {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.attachmentDb.getParsedDocumentsForMessage(messageId) as unknown as ParsedDocumentAttachment[];
  }

  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM message_attachments
    WHERE message_id = ? AND attachment_type = 'parsed_document'
    ORDER BY created_at ASC
  `);
  const rows = stmt.all(messageId) as Array<{
    id: string;
    message_id: string;
    session_id: string;
    data: string;
    original_url: string | null;
    created_at: number;
  }>;

  return rows.map((row) => {
    const parsed = JSON.parse(row.data);
    return {
      id: row.id,
      message_id: row.message_id,
      session_id: row.session_id,
      filename: parsed.filename || '',
      filePath: parsed.filePath || row.original_url || '',
      charCount: parsed.charCount || 0,
      extractMethod: parsed.extractMethod || null,
      text: parsed.text || '',
      imageChunks: parsed.imageChunks ? JSON.stringify(parsed.imageChunks) : null,
      created_at: row.created_at,
    };
  });
}

/**
 * Rehydrate a MessageContent array by replacing MiniMax CDN URLs
 * with locally stored base64 data.
 * Detects CDN domains: oss-cn-*.aliyuncs.com, xxx.minimax.io image URLs, etc.
 */
export function rehydrateContentWithAttachments(
  content: string | MessageContent[],
  attachmentMap: Map<string, AttachmentRow[]>,
): string | MessageContent[] {
  if (typeof content === 'string' || !Array.isArray(content)) {
    return content;
  }

  // Import shared CDN URL detection utility
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { isCDNImageUrl } = require('../utils/urlSafety.js');

  const results: MessageContent[] = [];
  let needsRehydration = false;

  for (const block of content) {
    if (block.type === 'image') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const imgBlock = block as any;
      let url = imgBlock.source?.url || imgBlock.source?.data;

      // Check if this is a CDN URL that needs rehydration
      if (imgBlock.source?.type === 'url' && url && isCDNImageUrl(url)) {
        needsRehydration = true;
        // Try to find matching attachment by original_url
        let rehydrated = false;
        for (const attachments of attachmentMap.values()) {
          for (const att of attachments) {
            if (att.original_url && (att.original_url === url || url.includes(att.original_url))) {
              results.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: att.mime_type,
                  data: att.data,
                },
              });
              rehydrated = true;
              break;
            }
          }
          if (rehydrated) break;
        }
        // If no attachment found for CDN URL, skip this image block to prevent browser access
        if (!rehydrated) {
          logger.warn(`No attachment found for CDN URL, skipping image block`, { url }, 'DB');
          continue;
        }
      } else {
        results.push(block);
      }
    } else {
      results.push(block);
    }
  }

  return needsRehydration ? results : content;
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
export function messageRowToMessage(row: MessageRow, attachmentMap?: Map<string, AttachmentRow[]>): Message {
  let content: string | MessageContent[];
  let toolCallId = row.tool_call_id || undefined;

  if (row.msg_type === 'thinking' && row.thinking) {
    content = [{ type: 'thinking', thinking: row.thinking }];
  } else if (row.msg_type === 'tool_use' && row.tool_name) {
    let input: Record<string, unknown> = {};
    let toolId = row.id;
    try {
      const parsed = JSON.parse(row.content);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const block = parsed[0];
        if (block.id) toolId = block.id;
        if (block.input) input = block.input;
      }
    } catch (err) {
      try {
        input = row.tool_input ? JSON.parse(row.tool_input) : {};
      } catch (parseErr) {
        // Failed to parse tool input, use empty object as fallback
        input = {};
      }
    }
    content = [{ type: 'tool_use', id: toolId, name: row.tool_name, input }];
    // Set tool_call_id to the tool_use id so tool_result can reference it
    toolCallId = toolId;
  } else {
    try {
      const parsed = JSON.parse(row.content);
      if (Array.isArray(parsed)) {
        content = parsed as MessageContent[];
      } else {
        content = row.content;
      }
    } catch {
      content = row.content;
    }
  }

  // Rehydrate image content with locally stored base64 attachments
  // This prevents MiniMax CDN URLs from leaking to the agent
  if (attachmentMap && Array.isArray(content)) {
    content = rehydrateContentWithAttachments(content, attachmentMap) as MessageContent[];
  }

  let parsedAttachments: FileAttachment[] | undefined;
  if (row.attachments) {
    try {
      parsedAttachments = JSON.parse(row.attachments) as FileAttachment[];
    } catch {
      // ignore parse errors
    }
  }

  return {
    id: row.id,
    role: row.role,
    content,
    name: row.name || undefined,
    tool_call_id: toolCallId,
    timestamp: row.created_at,
    msg_type: row.msg_type || undefined,
    thinking: row.thinking || undefined,
    tool_name: row.tool_name || undefined,
    tool_input: row.tool_input || undefined,
    parent_tool_call_id: row.parent_tool_call_id || undefined,
    viz_spec: row.viz_spec || undefined,
    status: row.status || undefined,
    seq_index: row.seq_index ?? undefined,
    duration_ms: row.duration_ms ?? undefined,
    sub_agent_id: row.sub_agent_id || undefined,
    attachments: parsedAttachments,
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
    messageCount: 0, // Placeholder, use listSessionsWithMessageCount for accurate counts
  };
}

/**
 * List all sessions with their message counts in a single query.
 * Avoids N+1 queries when displaying session list with message counts.
 * @returns Array of SessionInfo with messageCount populated
 */
export function listSessionsWithMessageCount(): SessionInfo[] {
  if (USE_IPC_MODE && getIpcClient()) {
    const sessions = getIpcClient()!.sessionDb.list() as unknown as ChatSession[];
    return sessions.map(sessionToSessionInfo);
  }

  const db = getDb();
  const now = Date.now();

  const rows = db.prepare(`
    SELECT
      s.id,
      s.created_at,
      s.updated_at,
      (SELECT COUNT(*) FROM messages WHERE session_id = s.id) as message_count
    FROM chat_sessions s
    ORDER BY s.updated_at DESC
  `).all() as Array<{ id: string; created_at: number; updated_at: number; message_count: number }>;

  void now; // Suppress unused warning

  return rows.map(row => ({
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
  }));
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
      logger.error('IPC replaceMessages failed', err instanceof Error ? err : new Error(String(err)), { sessionId }, 'DB');
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
      logger.info('Skipping stale replaceMessages', { gen: generation, current: session.generation, sessionId }, 'DB');
      return { success: false, reason: 'stale_generation' };
    }

    const txn = db.transaction(() => {
      const newGeneration = Math.max(generation, session.generation + 1);
      db.prepare('UPDATE chat_sessions SET generation = ?, updated_at = ? WHERE id = ?')
        .run(newGeneration, now, sessionId);

      db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);

      const stmt = db.prepare(`
        INSERT INTO messages (id, session_id, role, content, name, tool_call_id, token_usage, msg_type, thinking, tool_name, tool_input, parent_tool_call_id, viz_spec, status, seq_index, duration_ms, sub_agent_id, attachments, created_at)
        VALUES (@id, @session_id, @role, @content, @name, @tool_call_id, @token_usage, @msg_type, @thinking, @tool_name, @tool_input, @parent_tool_call_id, @viz_spec, @status, @seq_index, @duration_ms, @sub_agent_id, @attachments, @created_at)
      `);

      for (const msg of messages) {
        let msgType = msg.msg_type || 'text';
        let thinking: string | null = msg.thinking || null;
        let toolName: string | null = msg.tool_name || null;
        let toolInput: string | null = msg.tool_input || null;
        let parentToolCallId: string | null = msg.parent_tool_call_id || null;
        let vizSpec: string | null = msg.viz_spec || null;
        const effectiveContent = msg.content;
        let contentStr: string;
        if (typeof effectiveContent === 'string') {
          contentStr = effectiveContent;
        } else {
          contentStr = JSON.stringify(effectiveContent);
        }

        // For user messages with image content blocks,
        // extract only the text blocks for DB storage. Image data lives in
        // message_attachments table and should not be stored in content.
        // Assistant messages (thinking, tool_use) keep their full structure.
        if (msg.role === 'user' && Array.isArray(effectiveContent)) {
          const textBlocks = effectiveContent.filter(
            (b: unknown) => (b as Record<string, unknown>).type === 'text'
          );
          if (textBlocks.length > 0) {
            contentStr = textBlocks
              .map((b: unknown) => (b as Record<string, string>).text || '')
              .join('\n');
          }
        }

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
          attachments: msg.attachments
            ? (typeof msg.attachments === 'string' ? msg.attachments : JSON.stringify(msg.attachments))
            : null,
          created_at: msg.timestamp || now,
        });
      }
    });

    txn();

    // Extract and store image attachments after messages are saved.
    // This ensures base64 image data is preserved independently of the message content.
    // When messages are later loaded via getMessagesWithAttachments, CDN URLs
    // will be replaced with stored base64 data.
    try {
      extractAndStoreAttachments(sessionId, messages);
    } catch (err) {
      logger.error('Failed to store attachments', err instanceof Error ? err : new Error(String(err)), { sessionId }, 'DB');
    }

    return { success: true, messageCount: messages.length };
  } catch (error) {
    logger.error('replaceMessages failed', error instanceof Error ? error : new Error(String(error)), { sessionId }, 'DB');
    return { success: false, reason: 'error' };
  }
}

/**
 * Append new messages to a session (INSERT OR IGNORE).
 * No DELETE, no generation check. Only inserts messages that don't exist yet.
 * Used for incremental persistence: each message is written once and never replaced.
 */
export async function appendMessages(
  sessionId: string,
  messages: readonly Message[],
): Promise<{ success: boolean; count: number }> {
  if (USE_IPC_MODE && getIpcClient()) {
    try {
      const result = await getIpcClient()!.messageDb.append(sessionId, messages as unknown[]);
      return result as { success: boolean; count: number };
    } catch (error) {
      logger.error(
        'appendMessages failed (IPC)',
        error instanceof Error ? error : new Error(String(error)),
        { sessionId },
        'DB',
      );
      return { success: false, count: 0 };
    }
  }

  try {
    const now = Date.now();
    const db = getDb();

    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO messages (
        id, session_id, role, content, name, tool_call_id,
        token_usage, msg_type, thinking, tool_name, tool_input,
        parent_tool_call_id, viz_spec, status, seq_index, duration_ms, sub_agent_id,
        attachments, created_at
      ) VALUES (
        @id, @session_id, @role, @content, @name, @tool_call_id,
        @token_usage, @msg_type, @thinking, @tool_name, @tool_input,
        @parent_tool_call_id, @viz_spec, @status, @seq_index, @duration_ms, @sub_agent_id,
        @attachments, @created_at
      )
    `);

    let count = 0;
    const txn = db.transaction(() => {
      for (const msg of messages) {
        if (!msg.role) {
          continue;
        }

        const effectiveContent = msg.content;
        let contentStr: string;
        if (typeof effectiveContent === 'string') {
          contentStr = effectiveContent;
        } else {
          contentStr = JSON.stringify(effectiveContent);
        }

        // For user messages with image content blocks, extract only text.
        if (msg.role === 'user' && Array.isArray(effectiveContent)) {
          const textBlocks = effectiveContent.filter(
            (b: unknown) => (b as Record<string, unknown>).type === 'text'
          );
          if (textBlocks.length > 0) {
            contentStr = textBlocks
              .map((b: unknown) => (b as Record<string, string>).text || '')
              .join('\n');
          }
        }

        let msgType = msg.msg_type || null;
        let thinking: string | null = null;
        let toolName: string | null = null;
        let toolInput: string | null = null;

        // Auto-detect msg_type for tool messages
        if (!msgType && msg.role === 'tool') {
          msgType = 'tool_result';
          // For tool results, tool_call_id is the parent tool_use id
          // Copy it to parent_tool_call_id for frontend association
          if (msg.tool_call_id && !((msg as unknown) as Record<string, unknown>).parent_tool_call_id) {
            ((msg as unknown) as Record<string, unknown>).parent_tool_call_id = msg.tool_call_id;
          }
        }

        if (!msg.msg_type && Array.isArray(msg.content)) {
          const blocks = msg.content as Array<{ type: string; thinking?: string; name?: string; input?: unknown; tool_use_id?: string }>;
          const types = blocks.map(b => b.type);

          const toolUseBlock = blocks.find(b => b.type === 'tool_use' && b.name === 'show_widget');
          if (toolUseBlock) {
            const widgetCode = (toolUseBlock.input as Record<string, unknown>)?.widget_code;
            if (typeof widgetCode === 'string' && widgetCode.trim()) {
              msgType = 'viz';
              contentStr = widgetCode;
            }
          } else if (types.includes('thinking') && types.length === 1) {
            msgType = 'thinking';
            thinking = blocks[0].thinking || null;
            contentStr = thinking || '';
          } else if (types.includes('tool_use') && types.length === 1) {
            msgType = 'tool_use';
            toolName = (blocks[0].name as string) || null;
            toolInput = blocks[0].input ? JSON.stringify(blocks[0].input) : null;
          } else {
            msgType = 'text';
            // For mixed messages (e.g., thinking + text + tool_use), extract thinking if present
            const thinkingBlock = blocks.find(b => b.type === 'thinking');
            if (thinkingBlock) {
              thinking = thinkingBlock.thinking || null;
            }
          }
        }

        try {
          insertStmt.run({
            id: msg.id,
            session_id: sessionId,
            role: msg.role,
            content: contentStr,
            name: msg.name || null,
            tool_call_id: msg.tool_call_id || null,
            token_usage: (msg as unknown as Record<string, unknown>).token_usage
              ? JSON.stringify((msg as unknown as Record<string, unknown>).token_usage)
              : null,
            msg_type: msgType,
            thinking,
            tool_name: toolName,
            tool_input: toolInput,
            parent_tool_call_id: (msg as unknown as Record<string, unknown>).parent_tool_call_id as string || null,
            viz_spec: (msg as unknown as Record<string, unknown>).viz_spec as string || null,
            status: (msg as unknown as Record<string, unknown>).status as string || 'done',
            seq_index: (msg as unknown as Record<string, unknown>).seq_index as number || null,
            duration_ms: (msg as unknown as Record<string, unknown>).duration_ms as number || null,
            sub_agent_id: (msg as unknown as Record<string, unknown>).sub_agent_id as string || null,
            attachments: msg.attachments && msg.attachments.length > 0
              ? JSON.stringify(msg.attachments)
              : null,
            created_at: msg.timestamp || now,
          });
          count++;
        } catch (insertErr) {
          logger.error('Insert message failed in appendMessages', insertErr instanceof Error ? insertErr : new Error(String(insertErr)), { msgId: msg.id, role: msg.role, sessionId }, 'DB');
        }
      }
    });

    txn();

    // Extract and store image attachments
    try {
      extractAndStoreAttachments(sessionId, messages);
    } catch (err) {
      logger.error('Failed to extract attachments in appendMessages', undefined, { sessionId }, 'DB');
    }

    return { success: true, count };
  } catch (error) {
    logger.error(
      'appendMessages failed',
      error instanceof Error ? error : new Error(String(error)),
      { sessionId },
      'DB',
    );
    return { success: false, count: 0 };
  }
}

/**
 * Extract and store image attachments from messages after replaceMessages completes.
 * Must be called AFTER replaceMessages (messages must exist in DB first).
 * This preserves base64 image data so MiniMax CDN URLs can be rehydrated later.
 */
export function extractAndStoreAttachments(
  sessionId: string,
  messages: readonly Message[],
): void {
  if (messages.length === 0) return;

  const allAttachments: ExtractedAttachment[] = [];
  for (const msg of messages) {
    if (msg.role === 'user' && msg.id) {
      const attachments = extractAttachmentsFromContent(msg.id, msg.content);
      allAttachments.push(...attachments);
    }
  }

  if (allAttachments.length > 0) {
    storeAttachments(allAttachments, sessionId);
  }
}

// ============================================================
// Research Session CRUD Operations (Plan 60)
// ============================================================

/**
 * Create a new research session.
 */
export function createResearchSession(data: {
  id: string;
  session_id: string;
  original_query: string;
  clarification?: string;
  context_json: string;
  status?: 'active' | 'completed' | 'aborted';
}): ResearchSessionRow {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.researchSessionDb.create(data) as unknown as ResearchSessionRow;
  }

  const db = getDb();
  const now = Date.now();

  db.prepare(`
    INSERT INTO research_sessions (
      id, session_id, original_query, clarification, context_json,
      status, current_phase, iterations, coverage, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'idle', 0, 0, ?, ?)
  `).run(
    data.id,
    data.session_id,
    data.original_query,
    data.clarification ?? null,
    data.context_json,
    data.status ?? 'active',
    now,
    now
  );

  return {
    id: data.id,
    session_id: data.session_id,
    original_query: data.original_query,
    clarification: data.clarification ?? null,
    context_json: data.context_json,
    status: data.status ?? 'active',
    current_phase: 'idle',
    iterations: 0,
    coverage: 0,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Get a research session by ID.
 */
export function getResearchSession(id: string): ResearchSessionRow | null {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.researchSessionDb.get(id) as unknown as ResearchSessionRow | null;
  }

  const db = getDb();
  return db.prepare('SELECT * FROM research_sessions WHERE id = ?').get(id) as ResearchSessionRow | null;
}

/**
 * Get research session by session_id (chat session).
 */
export function getResearchSessionBySessionId(sessionId: string): ResearchSessionRow | null {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.researchSessionDb.getBySessionId(sessionId) as unknown as ResearchSessionRow | null;
  }

  const db = getDb();
  return db.prepare('SELECT * FROM research_sessions WHERE session_id = ? ORDER BY created_at DESC LIMIT 1').get(sessionId) as ResearchSessionRow | null;
}

/**
 * Update a research session.
 */
export function updateResearchSession(
  id: string,
  data: {
    clarification?: string;
    context_json?: string;
    status?: 'active' | 'completed' | 'aborted';
    current_phase?: string;
    iterations?: number;
    coverage?: number;
  }
): ResearchSessionRow | null {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.researchSessionDb.update(id, data) as unknown as ResearchSessionRow | null;
  }

  const db = getDb();
  const now = Date.now();

  const fields: string[] = ['updated_at = ?'];
  const params: unknown[] = [now];

  if (data.clarification !== undefined) {
    fields.push('clarification = ?');
    params.push(data.clarification);
  }
  if (data.context_json !== undefined) {
    fields.push('context_json = ?');
    params.push(data.context_json);
  }
  if (data.status !== undefined) {
    fields.push('status = ?');
    params.push(data.status);
  }
  if (data.current_phase !== undefined) {
    fields.push('current_phase = ?');
    params.push(data.current_phase);
  }
  if (data.iterations !== undefined) {
    fields.push('iterations = ?');
    params.push(data.iterations);
  }
  if (data.coverage !== undefined) {
    fields.push('coverage = ?');
    params.push(data.coverage);
  }

  params.push(id);

  db.prepare(`UPDATE research_sessions SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return getResearchSession(id);
}

/**
 * Delete a research session.
 */
export function deleteResearchSession(id: string): boolean {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.researchSessionDb.delete(id) as unknown as boolean;
  }

  const db = getDb();
  const result = db.prepare('DELETE FROM research_sessions WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * List all research sessions.
 */
export function listResearchSessions(limit = 100): ResearchSessionRow[] {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.researchSessionDb.list(limit) as unknown as ResearchSessionRow[];
  }

  const db = getDb();
  return db.prepare('SELECT * FROM research_sessions ORDER BY updated_at DESC LIMIT ?').all(limit) as ResearchSessionRow[];
}

/**
 * List research sessions by status.
 */
export function listResearchSessionsByStatus(status: 'active' | 'completed' | 'aborted'): ResearchSessionRow[] {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.researchSessionDb.listByStatus(status) as unknown as ResearchSessionRow[];
  }

  const db = getDb();
  return db.prepare('SELECT * FROM research_sessions WHERE status = ? ORDER BY updated_at DESC').all(status) as ResearchSessionRow[];
}

// ── Model Capabilities Cache ──────────────────────────────────────────

export interface ModelCapabilityRow {
  id: string;
  is_multimodal: number;
  detected_at: number;
  detection_method: string;
}

export function getModelCapability(modelName: string): ModelCapabilityRow | null {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.modelCapabilityDb.get(modelName) as unknown as ModelCapabilityRow | null;
  }

  const db = getDb();
  const normalized = modelName.trim().toLowerCase();
  return db.prepare('SELECT * FROM model_capabilities WHERE id = ?').get(normalized) as ModelCapabilityRow | null;
}

export function setModelCapability(
  modelName: string,
  isMultimodal: boolean,
  method: string,
): void {
  if (USE_IPC_MODE && getIpcClient()) {
    getIpcClient()!.modelCapabilityDb.set(modelName, isMultimodal, method);
    return;
  }

  const db = getDb();
  const normalized = modelName.trim().toLowerCase();
  db.prepare(`
    INSERT OR REPLACE INTO model_capabilities (id, is_multimodal, detected_at, detection_method)
    VALUES (?, ?, ?, ?)
  `).run(normalized, isMultimodal ? 1 : 0, Date.now(), method);
}

export function deleteModelCapability(modelName: string): boolean {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.modelCapabilityDb.delete(modelName) as unknown as boolean;
  }

  const db = getDb();
  const normalized = modelName.trim().toLowerCase();
  const result = db.prepare('DELETE FROM model_capabilities WHERE id = ?').run(normalized);
  return result.changes > 0;
}
