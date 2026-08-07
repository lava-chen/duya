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
import type { Message, MessageContent, SessionInfo, FileAttachment, TokenUsage } from '../types.js';
import { getConfigDatabasePath } from '../config/index.js';
import * as ipcDbClient from '../ipc/db-client.js';
import type BetterSqlite3 from 'better-sqlite3';
import { logger } from '../utils/logger.js';
import { isCDNImageUrl } from '../utils/urlSafety.js';
import { resolveAgentPermissionProfile } from './permission-resolver.js';

// =============================================================================
// IPC Mode Detection
// =============================================================================

/**
 * Check if we're running in IPC mode (Agent subprocess).
 * In IPC mode, database operations are forwarded to Main Process.
 */
// Plan 317: The production runtime (forked/spawned child with DUYA_AGENT_MODE=true
// and an IPC channel via stdio fd 4) always resolves USE_IPC_MODE to true, so
// appendMessages/addMessage always take the messageDb IPC branch. The local
// open-db branch below is preserved solely for the CLI and test paths.
const USE_IPC_MODE = process.env.DUYA_AGENT_MODE === 'true' && typeof process.send === 'function';

// Lazy-loaded IPC client (avoid circular dependency)
let ipcClient: typeof import('../ipc/db-client.js') | null = null;

function getIpcClient(): typeof ipcClient {
  if (USE_IPC_MODE && !ipcClient) {
    ipcClient = ipcDbClient;
  }
  return ipcClient;
}

function serializeMessageContent(value: unknown, role?: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value) && (role === 'user' || role === 'tool')) {
    // Both user and tool messages can carry inline ImageContent blocks
    // (user pastes, ReadTool on pure image files). Extract text blocks and
    // drop image blocks entirely — base64 payloads must not bloat the
    // messages.content column. Tool images are re-attached on reload via
    // the message_attachments table (extractAndStoreAttachments handles
    // tool messages too as of this change) or stay accessible through the
    // vision tool / recentImageAttachments.
    const textBlocks = value.filter(
      (block: unknown) => (block as Record<string, unknown>).type === 'text',
    );
    if (textBlocks.length > 0) {
      return textBlocks.map((block: unknown) => (block as Record<string, string>).text || '').join('\n');
    }
    // Messages that contain only non-text blocks (e.g. image blocks with
    // inline base64) must not have their payload serialized into messages.content.
    return '';
  }
  return JSON.stringify(value);
}

function serializeDisplayContent(value: unknown, role?: unknown): string | null {
  if (value === null || value === undefined) return null;
  return serializeMessageContent(value, role);
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

/**
 * Extract signature fields from a message's content blocks.
 * These are persisted in dedicated columns so they survive
 * context compression and session reload without modification.
 */
function extractSignatures(content: string | MessageContent[]): {
  thinkingSignature?: string;
  toolSignature?: string;
  textSignature?: string;
} {
  let thinkingSignature: string | undefined;
  let toolSignature: string | undefined;
  let textSignature: string | undefined;

  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'thinking' && 'thinkingSignature' in block && block.thinkingSignature) {
        thinkingSignature = block.thinkingSignature;
      } else if (block.type === 'tool_use' && 'thoughtSignature' in block && block.thoughtSignature) {
        toolSignature = block.thoughtSignature;
      } else if (block.type === 'text' && 'textSignature' in block && block.textSignature) {
        textSignature = block.textSignature;
      }
    }
  }
  return { thinkingSignature, toolSignature, textSignature };
}

/** Message row in the database */
export interface MessageRow {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  display_content: string | null;
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
  provider_state?: string | null;
  thinking_signature?: string | null;
  tool_signature?: string | null;
  text_signature?: string | null;
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
  /**
   * DB permission profile 显式值. 若不传, 由 resolveAgentPermissionProfile 解析.
   * agent 端无 settings 表, 普通 new 不传则落 'default'.
   * 派生 session 应通过 is_trusted_permission_override + 此字段表达内部 fork 意图.
   */
  permission_profile?: string | null;
  /**
   * trusted internal caller 才传 true. 普通 CLI / 外部调用不传.
   * 控制派生 session 显式 override 是否允许 (与 resolver 配合).
   */
  is_trusted_permission_override?: boolean;
}

/** Message data for creation */
export interface CreateMessageData {
  id: string;
  session_id: string;
  role: string;
  content: unknown;
  display_content?: string | null;
  displayContent?: unknown;
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
  // v2: Research Run model extensions
  title: string | null;
  run_status: string | null;
  plan_version: number;
  active_step_id: string | null;
  progress_summary: string | null;
  completed_at: number | null;
  error_json: string | null;
}

/** Research plan step row */
export interface ResearchPlanStepRow {
  id: string;
  run_id: string;
  order_num: number;
  user_facing_label: string;
  internal_question_ids: string;  // JSON array of question IDs
  status: 'pending' | 'active' | 'completed' | 'skipped' | 'failed';
  started_at: number | null;
  completed_at: number | null;
}

/** Research activity row */
export interface ResearchActivityRow {
  id: string;
  run_id: string;
  sequence: number;
  kind: string;
  title: string;
  detail: string | null;
  visibility: 'user' | 'debug';
  created_at: number;
}

/** Persisted user-facing research event for replay and recovery. */
export interface ResearchEventRow {
  id: string;
  run_id: string;
  sequence: number;
  event_type: string;
  payload_json: string;
  visibility: 'user' | 'debug';
  created_at: number;
}

/** Canonical source row for a research run. */
export interface ResearchSourceRow {
  id: string;
  run_id: string;
  title: string;
  url: string | null;
  canonical_url: string | null;
  source_type: string;
  allowed_by_policy: number;
  reliability_json: string | null;
  dedupe_key: string | null;
  rejected_reason: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

/** Citation edge from a report claim back to a source/finding. */
export interface ResearchCitationRow {
  id: string;
  run_id: string;
  report_id: string | null;
  source_id: string;
  finding_id: string | null;
  claim: string;
  locator_json: string | null;
  quoted_evidence: string | null;
  created_at: number;
}

/** Final report artifact for a research run. */
export interface ResearchReportRow {
  id: string;
  run_id: string;
  title: string | null;
  markdown: string;
  outline_json: string | null;
  source_ids_json: string;
  citation_ids_json: string;
  activity_summary_json: string | null;
  export_metadata_json: string | null;
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

  // Prefer the explicit path passed by the parent process. In monorepo /
  // Electron setups the workspace-local copy (e.g. packages/agent/node_modules)
  // may be unbuilt or compiled for a different Node ABI, so default module
  // resolution can load the wrong native binary and fail at runtime.
  const explicitPath = process.env.DUYA_BETTER_SQLITE3_PATH;
  if (explicitPath) {
    try {
      BetterSqlite3Ctor = require(explicitPath) as new (filename: string) => BetterSqlite3.Database;
      return BetterSqlite3Ctor;
    } catch (err) {
      logger.warn(
        'DUYA_BETTER_SQLITE3_PATH failed, falling back to module resolution',
        { explicitPath, error: err instanceof Error ? err.message : String(err) },
        'DB',
      );
    }
  }

  try {
    BetterSqlite3Ctor = require('better-sqlite3') as new (filename: string) => BetterSqlite3.Database;
    return BetterSqlite3Ctor;
  } catch (err) {
    const fallbackMsg = explicitPath ? ` and DUYA_BETTER_SQLITE3_PATH (${explicitPath}) failed` : '';
    throw new Error(`better-sqlite3 not found: module resolution failed${fallbackMsg}`);
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

  // Enable WAL mode for better concurrent access.
  // Always set WAL (matches main process behavior); fall back gracefully
  // only if the underlying SQLite build rejects the pragma.
  try {
    _db.pragma('journal_mode = WAL');
  } catch (err) {
    // WAL mode is optional, continue without it
    logger.warn('Failed to set WAL mode, continuing without it', { error: err instanceof Error ? err.message : String(err) }, 'DB');
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
 * Both dev and production use APPDATA/DUYA/duya-main.db for consistency
 * with the main process (electron/db/connection.ts).
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
    return path.join(process.env.DUYA_DB_DIR, 'duya-main.db');
  }

  // Use APPDATA/DUYA (or equivalent on other platforms) for both dev and prod
  // This ensures frontend and agent use the same database
  const userDataPath = getUserDataPath();
  return path.join(userDataPath, 'DUYA', 'duya-main.db');
}

/**
 * Get the database file path.
 * Checks for custom path from config file first, then environment variable.
 */
function getDbPath(): string {
  // Check for custom database path from config file (highest priority)
  const configDbPath = getConfigDatabasePath();
  if (configDbPath && configDbPath.trim()) {
    return path.join(configDbPath.trim(), 'duya-main.db');
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
  // Plan 328 decision 9: core session/message tables (chat_sessions, messages,
  // tasks, session_runtime_locks, agent_mailbox, FTS) moved to duya-core.db +
  // rollout. CLI standalone mode abandons session persistence, so these tables
  // are no longer created here. Non-core tables (attachments, model capabilities,
  // research_*) remain.
  db.exec(`
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
      created_at INTEGER NOT NULL
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
          created_at INTEGER NOT NULL
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
          updated_at INTEGER NOT NULL
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_research_sessions_session ON research_sessions(session_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_research_sessions_status ON research_sessions(status)`);
      logger.info('Migration: Created research_sessions table', undefined, 'DB');
    }
  } catch (error) {
    logger.error('Migration failed: creating research_sessions table', error instanceof Error ? error : undefined, undefined, 'DB');
  }

  // Schema migration: Add v2 columns to research_sessions (Research Run model)
  try {
    const tableInfo = db.prepare('PRAGMA table_info(research_sessions)').all() as Array<{ name: string }>;
    const columns = tableInfo.map(c => c.name);
    if (!columns.includes('title')) {
      db.exec(`ALTER TABLE research_sessions ADD COLUMN title TEXT`);
      logger.info('Migration: Added title column to research_sessions', undefined, 'DB');
    }
    if (!columns.includes('run_status')) {
      db.exec(`ALTER TABLE research_sessions ADD COLUMN run_status TEXT`);
      logger.info('Migration: Added run_status column to research_sessions', undefined, 'DB');
    }
    if (!columns.includes('plan_version')) {
      db.exec(`ALTER TABLE research_sessions ADD COLUMN plan_version INTEGER NOT NULL DEFAULT 0`);
      logger.info('Migration: Added plan_version column to research_sessions', undefined, 'DB');
    }
    if (!columns.includes('active_step_id')) {
      db.exec(`ALTER TABLE research_sessions ADD COLUMN active_step_id TEXT`);
      logger.info('Migration: Added active_step_id column to research_sessions', undefined, 'DB');
    }
    if (!columns.includes('progress_summary')) {
      db.exec(`ALTER TABLE research_sessions ADD COLUMN progress_summary TEXT`);
      logger.info('Migration: Added progress_summary column to research_sessions', undefined, 'DB');
    }
    if (!columns.includes('completed_at')) {
      db.exec(`ALTER TABLE research_sessions ADD COLUMN completed_at INTEGER`);
      logger.info('Migration: Added completed_at column to research_sessions', undefined, 'DB');
    }
    if (!columns.includes('error_json')) {
      db.exec(`ALTER TABLE research_sessions ADD COLUMN error_json TEXT`);
      logger.info('Migration: Added error_json column to research_sessions', undefined, 'DB');
    }
  } catch (error) {
    logger.error('Migration failed: adding v2 columns to research_sessions', error instanceof Error ? error : undefined, undefined, 'DB');
  }

  // Schema migration: Create research_plan_steps table
  try {
    const stepsTableInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='research_plan_steps'").get();
    if (!stepsTableInfo) {
      db.exec(`
        CREATE TABLE research_plan_steps (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          order_num INTEGER NOT NULL,
          user_facing_label TEXT NOT NULL,
          internal_question_ids TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'pending',
          started_at INTEGER,
          completed_at INTEGER,
          FOREIGN KEY (run_id) REFERENCES research_sessions(id) ON DELETE CASCADE
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_research_plan_steps_run ON research_plan_steps(run_id)`);
      logger.info('Migration: Created research_plan_steps table', undefined, 'DB');
    }
  } catch (error) {
    logger.error('Migration failed: creating research_plan_steps table', error instanceof Error ? error : undefined, undefined, 'DB');
  }

  // Schema migration: Create research_activities table
  try {
    const activitiesTableInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='research_activities'").get();
    if (!activitiesTableInfo) {
      db.exec(`
        CREATE TABLE research_activities (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          kind TEXT NOT NULL,
          title TEXT NOT NULL,
          detail TEXT,
          visibility TEXT NOT NULL DEFAULT 'user',
          created_at INTEGER NOT NULL,
          FOREIGN KEY (run_id) REFERENCES research_sessions(id) ON DELETE CASCADE
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_research_activities_run ON research_activities(run_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_research_activities_seq ON research_activities(run_id, sequence)`);
      logger.info('Migration: Created research_activities table', undefined, 'DB');
    }
  } catch (error) {
    logger.error('Migration failed: creating research_activities table', error instanceof Error ? error : undefined, undefined, 'DB');
  }

  // Schema migration: Create durable research event/report/source/citation tables (Deep Research P0)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS research_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'user',
        created_at INTEGER NOT NULL,
        FOREIGN KEY (run_id) REFERENCES research_sessions(id) ON DELETE CASCADE,
        UNIQUE(run_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS research_sources (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT,
        canonical_url TEXT,
        source_type TEXT NOT NULL DEFAULT 'web',
        allowed_by_policy INTEGER NOT NULL DEFAULT 1,
        reliability_json TEXT,
        dedupe_key TEXT,
        rejected_reason TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (run_id) REFERENCES research_sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS research_reports (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        title TEXT,
        markdown TEXT NOT NULL,
        outline_json TEXT,
        source_ids_json TEXT NOT NULL DEFAULT '[]',
        citation_ids_json TEXT NOT NULL DEFAULT '[]',
        activity_summary_json TEXT,
        export_metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (run_id) REFERENCES research_sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS research_citations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        report_id TEXT,
        source_id TEXT NOT NULL,
        finding_id TEXT,
        claim TEXT NOT NULL,
        locator_json TEXT,
        quoted_evidence TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (run_id) REFERENCES research_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (report_id) REFERENCES research_reports(id) ON DELETE SET NULL,
        FOREIGN KEY (source_id) REFERENCES research_sources(id) ON DELETE CASCADE
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_research_events_run_seq ON research_events(run_id, sequence)`);
    db.exec(`
      DELETE FROM research_events
      WHERE rowid NOT IN (
        SELECT MIN(rowid)
        FROM research_events
        GROUP BY run_id, sequence
      )
    `);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_research_events_run_seq ON research_events(run_id, sequence)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_research_sources_run ON research_sources(run_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_research_sources_policy ON research_sources(run_id, allowed_by_policy)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_research_reports_run ON research_reports(run_id, updated_at DESC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_research_citations_run ON research_citations(run_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_research_citations_report ON research_citations(report_id)`);
  } catch (error) {
    logger.error('Migration failed: creating research artifact tables', error instanceof Error ? error : undefined, undefined, 'DB');
  }
}

/**
 * Normalize text for FTS5 trigram indexing.
 *
 * Why: trigram tokenizer is case-sensitive and does not split camelCase / digit
 * boundaries. Pre-normalizing once at insert time makes the index case-insensitive
 * and lets `duya agent` reliably match `DuyaAgent` content.
 *
 * We index BOTH the split form and the unsplit (lowercased) form, joined by a
 * single space. This is so a user search like `openai` still hits `OpenAI`
 * content (where the splitter inserts a space and turns it into `open ai`),
 * while a search like `duya agent` still hits `DuyaAgent` content (where the
 * splitter correctly separates the two words).
 *
 *   DuyaAgent          -> "duya agent duyaagent"
 *   OpenAI             -> "open ai openai"
 *   XMLHttpRequest     -> "xml http request xmlhttprequest"
 *   foo123bar          -> "foo 123 bar foo123bar"
 *   message_attachments -> "message_attachments message_attachments" (no split)
 *   中文内容            -> "中文内容 中文内容" (no split, trigram handles substring)
 */
export function normalizeForFts(s: string | null | undefined): string {
  if (s === null || s === undefined) return '';
  const collapse = (x: string) => x.replace(/\s+/g, ' ').trim();
  const original = collapse(String(s).toLowerCase());
  const split = collapse(
    String(s)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/([A-Za-z])([0-9])/g, '$1 $2')
      .replace(/([0-9])([A-Za-z])/g, '$1 $2')
      .toLowerCase(),
  );
  if (original === split) return original;
  return `${split} ${original}`;
}

// Plan 328 decision 7: FTS5 virtual tables (messages_fts / sessions_fts) and
// their sync triggers were removed. Session search now runs on the core DB via
// SessionStore.search + MessageLog.searchText.

// ============================================================
// Session CRUD Operations
// ============================================================

/**
 * Create a new chat session.
 * @param data - Session creation data
 * @returns The created session
 */
// Plan 328 decision 9: CLI standalone mode abandons session persistence.
// The local (non-IPC) branch is removed; writes are no-ops, reads return empty.
export function createSession(data: CreateSessionData): ChatSession {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.sessionDb.create(data) as unknown as ChatSession;
  }

  const now = Date.now();
  return {
    id: data.id,
    title: data.title ?? null,
    model: data.model ?? null,
    system_prompt: data.system_prompt ?? null,
    working_directory: data.working_directory ?? null,
    project_name: data.project_name ?? null,
    status: data.status ?? null,
    mode: data.mode ?? null,
    permission_profile: null,
    provider_id: data.provider_id ?? null,
    context_summary: null,
    context_summary_updated_at: null,
    is_deleted: 0,
    generation: data.generation ?? 0,
    agent_profile_id: data.agent_profile_id ?? null,
    parent_id: data.parent_id ?? null,
    parent_session_id: data.parent_session_id ?? null,
    agent_type: data.agent_type ?? null,
    agent_name: data.agent_name ?? null,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Get a chat session by ID.
 * @param sessionId - The session ID
 * @returns The session or null if not found
 */
// Plan 328 decision 9: CLI standalone mode abandons session persistence.
// The local (non-IPC) branch is removed; writes are no-ops, reads return empty.
export function getSession(sessionId: string): ChatSession | null {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.sessionDb.get(sessionId) as unknown as ChatSession | null;
  }

  return null;
}

/**
 * Update a chat session.
 * @param sessionId - The session ID
 * @param data - The update data
 * @returns The updated session or null if not found
 */
// Plan 328 decision 9: CLI standalone mode abandons session persistence.
// The local (non-IPC) branch is removed; writes are no-ops, reads return empty.
export function updateSession(sessionId: string, data: UpdateSessionData): ChatSession | null {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.sessionDb.update(sessionId, data as unknown as Record<string, unknown>) as unknown as ChatSession | null;
  }

  return null;
}

/**
 * Delete a chat session and all its messages.
 * @param sessionId - The session ID
 * @returns True if deleted, false if not found
 */
// Plan 328 decision 9: CLI standalone mode abandons session persistence.
// The local (non-IPC) branch is removed; writes are no-ops, reads return empty.
export function deleteSession(sessionId: string): boolean {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.sessionDb.delete(sessionId) as unknown as boolean;
  }

  return false;
}

/**
 * List all chat sessions, ordered by updated_at descending.
 * @returns Array of sessions
 */
// Plan 328 decision 9: CLI standalone mode abandons session persistence.
// The local (non-IPC) branch is removed; writes are no-ops, reads return empty.
export function listSessions(): ChatSession[] {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.sessionDb.list() as unknown as ChatSession[];
  }

  return [];
}

/**
 * Async session listing for code that must work in both the Electron agent
 * subprocess (IPC) and standalone/local database modes.
 */
// Plan 328 decision 9: CLI standalone mode abandons session persistence.
// The local (non-IPC) branch is removed; writes are no-ops, reads return empty.
export async function listSessionsAsync(): Promise<ChatSession[]> {
  if (USE_IPC_MODE && getIpcClient()) {
    return await getIpcClient()!.sessionDb.list() as ChatSession[];
  }

  return listSessions();
}

// ============================================================
// Message CRUD Operations
// ============================================================

/**
 * Add a message to a session.
 * @param data - Message creation data
 * @returns The created message
 */
// Plan 328 decision 9: CLI standalone mode abandons session persistence.
// The local (non-IPC) branch is removed; writes are no-ops, reads return empty.
export function addMessage(data: CreateMessageData): MessageRow {
  const ipc = getIpcClient();
  if (USE_IPC_MODE && ipc) {
    return ipc.messageDb.add(data as unknown as Parameters<typeof ipc.messageDb.add>[0]) as unknown as MessageRow;
  }

  const now = Date.now();
  const content = serializeMessageContent(data.content, data.role);
  const displayContent = data.display_content ?? serializeDisplayContent(data.displayContent, data.role);
  const msgType = data.role === 'tool' ? 'tool_result' : (data.msg_type ?? 'text');
  const parentToolCallId = data.role === 'tool'
    ? (data.tool_call_id ?? null)
    : (data.parent_tool_call_id ?? null);

  return {
    id: data.id,
    session_id: data.session_id,
    role: data.role as 'user' | 'assistant' | 'system' | 'tool',
    content,
    display_content: displayContent,
    name: data.name ?? null,
    tool_call_id: data.tool_call_id ?? null,
    token_usage: data.token_usage ?? null,
    msg_type: msgType,
    thinking: data.thinking ?? null,
    tool_name: data.tool_name ?? null,
    tool_input: data.tool_input ?? null,
    parent_tool_call_id: parentToolCallId,
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
// Plan 328 decision 9: CLI standalone mode abandons session persistence.
// The local (non-IPC) branch is removed; writes are no-ops, reads return empty.
export function getMessages(sessionId: string): MessageRow[] {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.messageDb.getBySession(sessionId) as unknown as MessageRow[];
  }

  return [];
}

/**
 * Get messages with attachment rehydration.
 * This is the preferred method for loading session messages that may contain
 * image blocks with CDN URLs. It replaces CDN URLs with locally stored base64 data.
 */
// Plan 328 decision 9: CLI standalone mode abandons session persistence.
// The local (non-IPC) branch is removed; writes are no-ops, reads return empty.
export function getMessagesWithAttachments(sessionId: string): Message[] {
  if (USE_IPC_MODE && getIpcClient()) {
    const rows = getIpcClient()!.messageDb.getBySession(sessionId) as unknown as MessageRow[];
    return rows.map(row => messageRowToMessage(row));
  }

  return [];
}

/**
 * Get the count of messages for a session.
 * @param sessionId - The session ID
 * @returns Message count
 */
// Plan 328 decision 9: CLI standalone mode abandons session persistence.
// The local (non-IPC) branch is removed; writes are no-ops, reads return empty.
export function getMessageCount(sessionId: string): number {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.messageDb.getCount(sessionId) as unknown as number;
  }

  return 0;
}

/**
 * Delete all messages for a session.
 * @param sessionId - The session ID
 * @returns Number of deleted messages
 */
// Plan 328 decision 9: CLI standalone mode abandons session persistence.
// The local (non-IPC) branch is removed; writes are no-ops, reads return empty.
export function clearMessages(sessionId: string): number {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.messageDb.deleteBySession(sessionId) as unknown as number;
  }

  return 0;
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
// Plan 328 decision 9: CLI standalone mode abandons session persistence.
// The local (non-IPC) branch is removed; writes are no-ops, reads return empty.
export function acquireSessionLock(
  sessionId: string,
  lockId: string,
  owner: string,
  ttlSec: number = 300,
): boolean {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.lockDb.acquire(sessionId, lockId, owner, ttlSec) as unknown as boolean;
  }

  return false;
}

/**
 * Renew an existing session lock by extending its expiry.
 * @param sessionId - The session ID
 * @param lockId - Lock identifier
 * @param ttlSec - New time-to-live in seconds (default: 300)
 * @returns True if lock was renewed, false if lock not found or not owned
 */
// Plan 328 decision 9: CLI standalone mode abandons session persistence.
// The local (non-IPC) branch is removed; writes are no-ops, reads return empty.
export function renewSessionLock(
  sessionId: string,
  lockId: string,
  ttlSec: number = 300,
): boolean {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.lockDb.renew(sessionId, lockId, ttlSec) as unknown as boolean;
  }

  return false;
}

/**
 * Release a session lock.
 * @param sessionId - The session ID
 * @param lockId - Lock identifier
 * @returns True if lock was released, false if lock not found
 */
// Plan 328 decision 9: CLI standalone mode abandons session persistence.
// The local (non-IPC) branch is removed; writes are no-ops, reads return empty.
export function releaseSessionLock(sessionId: string, lockId: string): boolean {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.lockDb.release(sessionId, lockId) as unknown as boolean;
  }

  return false;
}

/**
 * Check if a session is currently locked.
 * @param sessionId - The session ID
 * @returns True if locked, false otherwise
 */
// Plan 328 decision 9: CLI standalone mode abandons session persistence.
// The local (non-IPC) branch is removed; writes are no-ops, reads return empty.
export function isSessionLocked(sessionId: string): boolean {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.lockDb.isLocked(sessionId) as unknown as boolean;
  }

  return false;
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

  let tokenUsage: TokenUsage | undefined;
  if (row.token_usage) {
    try {
      tokenUsage = JSON.parse(row.token_usage) as TokenUsage;
    } catch {
      // ignore parse errors
    }
  }

  // Restore signatures from dedicated columns back into content blocks.
  // This preserves opaque provider state across context compression and
  // session reload. Signatures are stored separately from content JSON so
  // that compression/summarization can safely modify content without
  // corrupting the signature chain.
  if (Array.isArray(content)) {
    if (row.thinking_signature) {
      const thinkingBlock = content.find(b => b.type === 'thinking');
      if (thinkingBlock && thinkingBlock.type === 'thinking') {
        thinkingBlock.thinkingSignature = row.thinking_signature;
      }
    }
    if (row.tool_signature) {
      const toolBlock = content.find(b => b.type === 'tool_use');
      if (toolBlock && toolBlock.type === 'tool_use') {
        toolBlock.thoughtSignature = row.tool_signature;
      }
    }
    if (row.text_signature) {
      const textBlock = content.find(b => b.type === 'text');
      if (textBlock && textBlock.type === 'text') {
        textBlock.textSignature = row.text_signature;
      }
    }
  }

  // Restore provider state (api, providerId, model) from dedicated column.
  let providerState: { api?: string; providerId?: string; model?: string } | undefined;
  if (row.provider_state) {
    try {
      providerState = JSON.parse(row.provider_state);
    } catch {
      // ignore malformed JSON
    }
  }

  return {
    id: row.id,
    role: row.role,
    content,
    displayContent: row.display_content ?? undefined,
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
    tokenUsage,
    // ─── NEW: restore multi-model adapter fields ───
    api: providerState?.api as Message['api'],
    providerId: providerState?.providerId,
    model: providerState?.model,
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
// Plan 328 decision 9: CLI standalone mode abandons session persistence.
// The local (non-IPC) branch is removed; writes are no-ops, reads return empty.
export function listSessionsWithMessageCount(): SessionInfo[] {
  if (USE_IPC_MODE && getIpcClient()) {
    const sessions = getIpcClient()!.sessionDb.list() as unknown as ChatSession[];
    return sessions.map(sessionToSessionInfo);
  }

  return [];
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
// Plan 328 decision 9: CLI standalone mode abandons session persistence.
// The local (non-IPC) branch is removed; writes are no-ops, reads return empty.
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

  return { success: false, reason: 'error' };
}

/**
 * Append new messages to a session (INSERT OR IGNORE).
 * No DELETE, no generation check. Only inserts messages that don't exist yet.
 * Used for incremental persistence: each message is written once and never replaced.
 */
// Plan 328 decision 9: CLI standalone mode abandons session persistence.
// The local (non-IPC) branch is removed; writes are no-ops, reads return empty.
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

  return { success: false, count: 0 };
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
    // Both user messages (pasted images) and tool messages (ReadTool on a
    // pure image file) can carry inline ImageContent blocks. Persist them to
    // message_attachments so the tool_result images survive session reload
    // — without this, serializeMessageContent strips the base64 payload
    // from messages.content and the image would be lost on next launch.
    if ((msg.role === 'user' || msg.role === 'tool') && msg.id) {
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
  title?: string;
  run_status?: string;
}): ResearchSessionRow {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.researchSessionDb.create(data) as unknown as ResearchSessionRow;
  }

  const db = getDb();
  const now = Date.now();

  db.prepare(`
    INSERT INTO research_sessions (
      id, session_id, original_query, clarification, context_json,
      status, current_phase, iterations, coverage, created_at, updated_at,
      title, run_status, plan_version, active_step_id, progress_summary, completed_at, error_json
    ) VALUES (?, ?, ?, ?, ?, ?, 'idle', 0, 0, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL)
  `).run(
    data.id,
    data.session_id,
    data.original_query,
    data.clarification ?? null,
    data.context_json,
    data.status ?? 'active',
    now,
    now,
    data.title ?? null,
    data.run_status ?? null
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
    title: data.title ?? null,
    run_status: data.run_status ?? null,
    plan_version: 0,
    active_step_id: null,
    progress_summary: null,
    completed_at: null,
    error_json: null,
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
    // v2 fields
    title?: string;
    run_status?: string;
    plan_version?: number;
    active_step_id?: string | null;
    progress_summary?: string | null;
    completed_at?: number | null;
    error_json?: string | null;
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
  // v2 fields
  if (data.title !== undefined) {
    fields.push('title = ?');
    params.push(data.title);
  }
  if (data.run_status !== undefined) {
    fields.push('run_status = ?');
    params.push(data.run_status);
  }
  if (data.plan_version !== undefined) {
    fields.push('plan_version = ?');
    params.push(data.plan_version);
  }
  if (data.active_step_id !== undefined) {
    fields.push('active_step_id = ?');
    params.push(data.active_step_id);
  }
  if (data.progress_summary !== undefined) {
    fields.push('progress_summary = ?');
    params.push(data.progress_summary);
  }
  if (data.completed_at !== undefined) {
    fields.push('completed_at = ?');
    params.push(data.completed_at);
  }
  if (data.error_json !== undefined) {
    fields.push('error_json = ?');
    params.push(data.error_json);
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

// =============================================================================
// Research Plan Steps CRUD
// =============================================================================

export function createResearchPlanSteps(
  runId: string,
  steps: Array<{
    id: string;
    order_num: number;
    user_facing_label: string;
    internal_question_ids: string[];
  }>,
): ResearchPlanStepRow[] {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.researchPlanStepDb.createSteps(runId, steps) as unknown as ResearchPlanStepRow[];
  }

  const db = getDb();
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO research_plan_steps (id, run_id, order_num, user_facing_label, internal_question_ids, status, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL)
  `);

  const rows: ResearchPlanStepRow[] = [];
  const txn = db.transaction(() => {
    for (const step of steps) {
      stmt.run(
        step.id,
        runId,
        step.order_num,
        step.user_facing_label,
        JSON.stringify(step.internal_question_ids),
      );
      rows.push({
        id: step.id,
        run_id: runId,
        order_num: step.order_num,
        user_facing_label: step.user_facing_label,
        internal_question_ids: JSON.stringify(step.internal_question_ids),
        status: 'pending',
        started_at: null,
        completed_at: null,
      });
    }
  });
  txn();

  void now;
  return rows;
}

export function getResearchPlanSteps(runId: string): ResearchPlanStepRow[] {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.researchPlanStepDb.getByRunId(runId) as unknown as ResearchPlanStepRow[];
  }

  const db = getDb();
  return db.prepare('SELECT * FROM research_plan_steps WHERE run_id = ? ORDER BY order_num ASC').all(runId) as ResearchPlanStepRow[];
}

export function updateResearchPlanStep(
  stepId: string,
  data: {
    status?: 'pending' | 'active' | 'completed' | 'skipped' | 'failed';
    started_at?: number | null;
    completed_at?: number | null;
  },
): ResearchPlanStepRow | null {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.researchPlanStepDb.update(stepId, data) as unknown as ResearchPlanStepRow | null;
  }

  const db = getDb();
  const fields: string[] = [];
  const params: unknown[] = [];

  if (data.status !== undefined) {
    fields.push('status = ?');
    params.push(data.status);
  }
  if (data.started_at !== undefined) {
    fields.push('started_at = ?');
    params.push(data.started_at);
  }
  if (data.completed_at !== undefined) {
    fields.push('completed_at = ?');
    params.push(data.completed_at);
  }

  if (fields.length === 0) return null;

  params.push(stepId);
  db.prepare(`UPDATE research_plan_steps SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return db.prepare('SELECT * FROM research_plan_steps WHERE id = ?').get(stepId) as ResearchPlanStepRow | null;
}

export function deleteResearchPlanSteps(runId: string): number {
  if (USE_IPC_MODE && getIpcClient()) {
    const result = getIpcClient()!.researchPlanStepDb.deleteByRunId(runId) as unknown as { changes?: number } | number;
    return typeof result === 'number' ? result : result.changes ?? 0;
  }

  const db = getDb();
  const result = db.prepare('DELETE FROM research_plan_steps WHERE run_id = ?').run(runId);
  return result.changes;
}

// =============================================================================
// Research Activities CRUD
// =============================================================================

export function createResearchActivity(data: {
  id: string;
  run_id: string;
  sequence: number;
  kind: string;
  title: string;
  detail?: string;
  visibility?: 'user' | 'debug';
}): ResearchActivityRow {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.researchActivityDb.create(data) as unknown as ResearchActivityRow;
  }

  const db = getDb();
  const now = Date.now();

  db.prepare(`
    INSERT INTO research_activities (id, run_id, sequence, kind, title, detail, visibility, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.id,
    data.run_id,
    data.sequence,
    data.kind,
    data.title,
    data.detail ?? null,
    data.visibility ?? 'user',
    now,
  );

  return {
    id: data.id,
    run_id: data.run_id,
    sequence: data.sequence,
    kind: data.kind,
    title: data.title,
    detail: data.detail ?? null,
    visibility: data.visibility ?? 'user',
    created_at: now,
  };
}

export function getResearchActivities(
  runId: string,
  options?: { visibility?: 'user' | 'debug'; limit?: number; afterSequence?: number },
): ResearchActivityRow[] {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.researchActivityDb.getByRunId(runId, options) as unknown as ResearchActivityRow[];
  }

  const db = getDb();
  const visibility = options?.visibility;
  const limit = options?.limit ?? 200;
  const afterSequence = options?.afterSequence;

  if (visibility) {
    if (afterSequence !== undefined) {
      return db.prepare(
        'SELECT * FROM research_activities WHERE run_id = ? AND visibility = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?'
      ).all(runId, visibility, afterSequence, limit) as ResearchActivityRow[];
    }
    return db.prepare(
      'SELECT * FROM research_activities WHERE run_id = ? AND visibility = ? ORDER BY sequence ASC LIMIT ?'
    ).all(runId, visibility, limit) as ResearchActivityRow[];
  }

  if (afterSequence !== undefined) {
    return db.prepare(
      'SELECT * FROM research_activities WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?'
    ).all(runId, afterSequence, limit) as ResearchActivityRow[];
  }

  return db.prepare(
    'SELECT * FROM research_activities WHERE run_id = ? ORDER BY sequence ASC LIMIT ?'
  ).all(runId, limit) as ResearchActivityRow[];
}

export function getResearchActivityMaxSequence(runId: string): number {
  if (USE_IPC_MODE && getIpcClient()) {
    const result = getIpcClient()!.researchActivityDb.getMaxSequence(runId) as unknown as { max_seq?: number };
    return result?.max_seq ?? 0;
  }

  const db = getDb();
  const result = db.prepare(
    'SELECT MAX(sequence) as max_seq FROM research_activities WHERE run_id = ?'
  ).get(runId) as { max_seq: number | null };
  return result?.max_seq ?? 0;
}

export function deleteResearchActivities(runId: string): number {
  if (USE_IPC_MODE && getIpcClient()) {
    const result = getIpcClient()!.researchActivityDb.deleteByRunId(runId) as unknown as { changes?: number } | number;
    return typeof result === 'number' ? result : result.changes ?? 0;
  }

  const db = getDb();
  const result = db.prepare('DELETE FROM research_activities WHERE run_id = ?').run(runId);
  return result.changes;
}

// =============================================================================
// Research Events / Sources / Citations / Reports CRUD
// =============================================================================

export function createResearchEvent(data: {
  id: string;
  run_id: string;
  sequence: number;
  event_type: string;
  payload_json: string;
  visibility?: 'user' | 'debug';
}): ResearchEventRow | Promise<ResearchEventRow> {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.researchEventDb.create(data) as Promise<ResearchEventRow>;
  }

  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO research_events (id, run_id, sequence, event_type, payload_json, visibility, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(data.id, data.run_id, data.sequence, data.event_type, data.payload_json, data.visibility ?? 'user', now);
  return db.prepare('SELECT * FROM research_events WHERE run_id = ? AND sequence = ?').get(data.run_id, data.sequence) as ResearchEventRow;
}

export function getResearchEvents(runId: string, options?: { afterSequence?: number; limit?: number; visibility?: 'user' | 'debug' }): ResearchEventRow[] {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.researchEventDb.getByRunId(runId, options) as unknown as ResearchEventRow[];
  }

  const db = getDb();
  const limit = options?.limit ?? 500;
  const afterSequence = options?.afterSequence ?? -1;
  if (options?.visibility) {
    return db.prepare(
      'SELECT * FROM research_events WHERE run_id = ? AND visibility = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?'
    ).all(runId, options.visibility, afterSequence, limit) as ResearchEventRow[];
  }
  return db.prepare(
    'SELECT * FROM research_events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?'
  ).all(runId, afterSequence, limit) as ResearchEventRow[];
}

export async function getResearchEventMaxSequence(runId: string): Promise<number> {
  if (USE_IPC_MODE && getIpcClient()) {
    const result = await getIpcClient()!.researchEventDb.getMaxSequence(runId) as { max_seq?: number };
    return result?.max_seq ?? 0;
  }

  const db = getDb();
  const result = db.prepare('SELECT MAX(sequence) as max_seq FROM research_events WHERE run_id = ?').get(runId) as { max_seq: number | null };
  return result?.max_seq ?? 0;
}

export function upsertResearchSource(data: {
  id: string;
  run_id: string;
  title: string;
  url?: string | null;
  canonical_url?: string | null;
  source_type?: string;
  allowed_by_policy?: boolean;
  reliability_json?: string | null;
  dedupe_key?: string | null;
  rejected_reason?: string | null;
  metadata_json?: string | null;
}): ResearchSourceRow {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.researchSourceDb.upsert(data) as unknown as ResearchSourceRow;
  }

  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO research_sources (
      id, run_id, title, url, canonical_url, source_type, allowed_by_policy,
      reliability_json, dedupe_key, rejected_reason, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      url = excluded.url,
      canonical_url = excluded.canonical_url,
      source_type = excluded.source_type,
      allowed_by_policy = excluded.allowed_by_policy,
      reliability_json = excluded.reliability_json,
      dedupe_key = excluded.dedupe_key,
      rejected_reason = excluded.rejected_reason,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `).run(
    data.id,
    data.run_id,
    data.title,
    data.url ?? null,
    data.canonical_url ?? data.url ?? null,
    data.source_type ?? 'web',
    data.allowed_by_policy === false ? 0 : 1,
    data.reliability_json ?? null,
    data.dedupe_key ?? null,
    data.rejected_reason ?? null,
    data.metadata_json ?? null,
    now,
    now,
  );
  return db.prepare('SELECT * FROM research_sources WHERE id = ?').get(data.id) as ResearchSourceRow;
}

export function getResearchSources(runId: string): ResearchSourceRow[] {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.researchSourceDb.getByRunId(runId) as unknown as ResearchSourceRow[];
  }

  const db = getDb();
  return db.prepare('SELECT * FROM research_sources WHERE run_id = ? ORDER BY created_at ASC').all(runId) as ResearchSourceRow[];
}

export function createResearchCitation(data: {
  id: string;
  run_id: string;
  report_id?: string | null;
  source_id: string;
  finding_id?: string | null;
  claim: string;
  locator_json?: string | null;
  quoted_evidence?: string | null;
}): ResearchCitationRow {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.researchCitationDb.create(data) as unknown as ResearchCitationRow;
  }

  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT OR REPLACE INTO research_citations (
      id, run_id, report_id, source_id, finding_id, claim, locator_json, quoted_evidence, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.id,
    data.run_id,
    data.report_id ?? null,
    data.source_id,
    data.finding_id ?? null,
    data.claim,
    data.locator_json ?? null,
    data.quoted_evidence ?? null,
    now,
  );
  return db.prepare('SELECT * FROM research_citations WHERE id = ?').get(data.id) as ResearchCitationRow;
}

export function getResearchCitations(runId: string, reportId?: string): ResearchCitationRow[] {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.researchCitationDb.getByRunId(runId, reportId) as unknown as ResearchCitationRow[];
  }

  const db = getDb();
  if (reportId) {
    return db.prepare('SELECT * FROM research_citations WHERE run_id = ? AND report_id = ? ORDER BY created_at ASC').all(runId, reportId) as ResearchCitationRow[];
  }
  return db.prepare('SELECT * FROM research_citations WHERE run_id = ? ORDER BY created_at ASC').all(runId) as ResearchCitationRow[];
}

export function upsertResearchReport(data: {
  id: string;
  run_id: string;
  title?: string | null;
  markdown: string;
  outline_json?: string | null;
  source_ids_json?: string;
  citation_ids_json?: string;
  activity_summary_json?: string | null;
  export_metadata_json?: string | null;
}): ResearchReportRow {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.researchReportDb.upsert(data) as unknown as ResearchReportRow;
  }

  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO research_reports (
      id, run_id, title, markdown, outline_json, source_ids_json, citation_ids_json,
      activity_summary_json, export_metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      markdown = excluded.markdown,
      outline_json = excluded.outline_json,
      source_ids_json = excluded.source_ids_json,
      citation_ids_json = excluded.citation_ids_json,
      activity_summary_json = excluded.activity_summary_json,
      export_metadata_json = excluded.export_metadata_json,
      updated_at = excluded.updated_at
  `).run(
    data.id,
    data.run_id,
    data.title ?? null,
    data.markdown,
    data.outline_json ?? null,
    data.source_ids_json ?? '[]',
    data.citation_ids_json ?? '[]',
    data.activity_summary_json ?? null,
    data.export_metadata_json ?? null,
    now,
    now,
  );
  return db.prepare('SELECT * FROM research_reports WHERE id = ?').get(data.id) as ResearchReportRow;
}

export function getLatestResearchReport(runId: string): ResearchReportRow | null {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.researchReportDb.getLatest(runId) as unknown as ResearchReportRow | null;
  }

  const db = getDb();
  return db.prepare('SELECT * FROM research_reports WHERE run_id = ? ORDER BY updated_at DESC LIMIT 1').get(runId) as ResearchReportRow | null;
}

// =============================================================================
// Research Run Query Helpers
// =============================================================================

/**
 * Get active research run for a chat session.
 */
export function getActiveResearchRun(sessionId: string): ResearchSessionRow | null {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM research_sessions
     WHERE session_id = ? AND run_status IN ('planning', 'awaiting_approval', 'running', 'paused', 'synthesizing')
     ORDER BY created_at DESC LIMIT 1`
  ).get(sessionId) as ResearchSessionRow | null;
}

/**
 * List active research runs across all sessions.
 */
export function listActiveResearchRuns(): ResearchSessionRow[] {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM research_sessions
     WHERE run_status IN ('planning', 'awaiting_approval', 'running', 'paused', 'synthesizing')
     ORDER BY updated_at DESC`
  ).all() as ResearchSessionRow[];
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

// =============================================================================
// Mailbox Types & CRUD (Plan 202 — AgentMailbox PR1)
// =============================================================================

export type MailboxKind = 'queued' | 'followup' | 'background_notification';
export type MailboxStatus = 'pending' | 'observed' | 'applied' | 'cancelled';
export type MailboxApplyMode = 'promote_to_user_message' | 'runtime_instruction' | 'tool_guard'
  | 'permission_context' | 'interrupt_signal' | 'deferred_to_next_turn';

export interface MailboxRow {
  id: string;
  session_id: string;
  submitted_during_run_id: string;
  content: string;
  kind: MailboxKind;
  status: MailboxStatus;
  priority: number;
  constraints_json: string | null;
  attachments_json: string | null;
  source: string;
  client_msg_id: string | null;
  created_at: number;
  claim_token: string | null;
  claim_expires_at: number | null;
  observed_at: number | null;
  observed_at_checkpoint: string | null;
  observed_by_run_id: string | null;
  claim_attempts: number;
  last_claim_error: string | null;
  edit_locked_at: number | null;
  apply_mode: MailboxApplyMode | null;
  applied_at: number | null;
  applied_at_checkpoint: string | null;
  applied_summary: string | null;
  resulting_user_msg_id: string | null;
  failure_reason: string | null;
  edit_history_json: string | null;
  cancelled_at: number | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
}

export interface CreateMailboxData {
  id: string;
  sessionId: string;
  submittedDuringRunId: string;
  content: string;
  kind: MailboxKind;
  attachments?: unknown[];
  clientMsgId?: string;
  source?: string;
  constraintsJson?: string;
}

export interface EditMailboxPatch {
  content?: string;
  kind?: MailboxKind;
}

// =============================================================================
// Mailbox CRUD Operations
// =============================================================================

/** Priority mapping for each kind */
const KIND_PRIORITY: Record<MailboxKind, number> = {
  queued: 100,
  followup: 100,
  background_notification: 100,
};

// Plan 328 decision 9: CLI standalone mode abandons session persistence.
// The local (non-IPC) branch is removed; writes are no-ops, reads return empty.
export function mailboxSend(data: CreateMailboxData): MailboxRow {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.mailboxDb.send(data) as unknown as MailboxRow;
  }

  return {
    id: data.id,
    session_id: data.sessionId,
    submitted_during_run_id: data.submittedDuringRunId || '',
    content: data.content,
    kind: data.kind,
    status: 'pending',
    priority: KIND_PRIORITY[data.kind] ?? 100,
    constraints_json: data.constraintsJson ?? null,
    attachments_json: data.attachments ? JSON.stringify(data.attachments) : null,
    source: data.source ?? 'ui',
    client_msg_id: data.clientMsgId ?? null,
    created_at: Date.now(),
    claim_token: null,
    claim_expires_at: null,
    observed_at: null,
    observed_at_checkpoint: null,
    observed_by_run_id: null,
    claim_attempts: 0,
    last_claim_error: null,
    edit_locked_at: null,
    apply_mode: null,
    applied_at: null,
    applied_at_checkpoint: null,
    applied_summary: null,
    resulting_user_msg_id: null,
    failure_reason: null,
    edit_history_json: null,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
  };
}

// Plan 328 decision 9: CLI standalone mode abandons session persistence.
// The local (non-IPC) branch is removed; writes are no-ops, reads return empty.
export function mailboxEdit(id: string, patch: EditMailboxPatch): MailboxRow | null {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.mailboxDb.edit(id, patch) as unknown as MailboxRow | null;
  }

  return null;
}

// Plan 328 decision 9: CLI standalone mode abandons session persistence.
// The local (non-IPC) branch is removed; writes are no-ops, reads return empty.
export function mailboxCancel(id: string, reason?: string): MailboxRow | null {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.mailboxDb.cancel(id, reason) as unknown as MailboxRow | null;
  }

  return null;
}

// Plan 328 decision 9: CLI standalone mode abandons session persistence.
// The local (non-IPC) branch is removed; writes are no-ops, reads return empty.
export function mailboxList(sessionId: string, opts?: { status?: MailboxStatus[]; limit?: number }): MailboxRow[] {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.mailboxDb.list(sessionId, opts) as unknown as MailboxRow[];
  }

  return [];
}

// Plan 328 decision 9: CLI standalone mode abandons session persistence.
// The local (non-IPC) branch is removed; writes are no-ops, reads return empty.
export function mailboxListForSession(sessionId: string): MailboxRow[] {
  if (USE_IPC_MODE && getIpcClient()) {
    return getIpcClient()!.mailboxDb.listForSession(sessionId) as unknown as MailboxRow[];
  }

  return [];
}
