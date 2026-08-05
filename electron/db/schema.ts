import { getLogger, LogComponent } from '../logging/logger';

// Use type-only import to avoid bundling better-sqlite3 in the schema module
type BetterSqlite3Db = import('better-sqlite3').Database;

/**
 * Initialize the database schema, creating all tables, indexes, default data,
 * FTS5 search, and running migrations.
 */
export function initializeSchema(db: BetterSqlite3Db): void {
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
      parent_id TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
      agent_type TEXT NOT NULL DEFAULT 'main',
      agent_name TEXT NOT NULL DEFAULT '',
      conductor_mode_enabled INTEGER NOT NULL DEFAULT 0,
      conductor_canvas_id TEXT DEFAULT NULL
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
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS message_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      attachment_type TEXT NOT NULL,
      mime_type TEXT,
      data TEXT NOT NULL,
      original_url TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
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

  // Plan 62 §3.2 — channel_directory: per-platform channel inventory
  // pushed by adapters after they connect. Used by the CLI control
  // plane (`duya channel list / info / platforms / status`). Keep
  // the schema aligned with the SELECT/INSERT in
  // `electron/gateway/channel-directory.ts`.
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_directory (
      id TEXT NOT NULL,
      platform TEXT NOT NULL,
      name TEXT NOT NULL,
      guild TEXT,
      type TEXT NOT NULL,
      extra TEXT NOT NULL DEFAULT '{}',
      discovered_at INTEGER NOT NULL,
      PRIMARY KEY (platform, id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_channel_directory_platform ON channel_directory(platform)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Chat',
      provider_type TEXT NOT NULL DEFAULT 'gateway',
      model TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_threads_updated_at ON threads(updated_at DESC)`);

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
      schedule_end_at TEXT,
      workflow_id TEXT,
      working_directory TEXT NOT NULL DEFAULT '',
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
      native_kind TEXT,
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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON message_attachments(message_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_attachments_session_id ON message_attachments(session_id)`);
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

  // Migration: add native_kind column for existing databases
  try { db.exec(`ALTER TABLE conductor_elements ADD COLUMN native_kind TEXT`); } catch { /* already exists */ }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_elements_native_kind ON conductor_elements(canvas_id, native_kind)`);

  // Additional indexes for query optimization
  // messages table indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_session_role ON messages(session_id, role)`);

  // conductor_actions table indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_actions_type ON conductor_actions(action_type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_actions_type_canvas ON conductor_actions(canvas_id, action_type)`);

  // conductor_widgets table indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_widgets_type ON conductor_widgets(type)`);

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS model_capabilities (
      id                TEXT PRIMARY KEY,
      is_multimodal     INTEGER NOT NULL,
      detected_at       INTEGER NOT NULL,
      detection_method  TEXT NOT NULL DEFAULT 'unknown'
    )
  `);

  // Plan 312: App Connection metadata. Tokens NEVER live here — they
  // go in the safeStorage-encrypted vault at
  // {userData}/app-connections/tokens.vault. This table only stores
  // connection state (provider, account, scopes, status, expiry).
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_connections (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      account_label TEXT NOT NULL DEFAULT '',
      account_id TEXT NOT NULL DEFAULT '',
      scopes TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'disconnected',
      expires_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_app_connections_provider ON app_connections(provider)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_app_connections_status ON app_connections(status)`);

  // Plugin setup values — text/secret/path/url setup fields declared in a
  // plugin manifest's `setup` block. One row per (plugin_id, key). Tokens
  // for `app-connection` setup fields do NOT live here — those go through
  // the OAuth path and the safeStorage-encrypted vault. See
  // `electron/plugins/PluginSetupStore.ts` for the access layer.
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_setup_values (
      plugin_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (plugin_id, key)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_plugin_setup_values_plugin ON plugin_setup_values(plugin_id)`);

  initializeFts5(db);

  const insertSetting = db.prepare(`
    INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)
  `);
  insertSetting.run('theme', 'dark', Date.now());
  insertSetting.run('collapsedProjects', '[]', Date.now());
  insertSetting.run('remote_bridge_enabled', 'false', Date.now());
  insertSetting.run('bridge_auto_start', 'true', Date.now());
  insertSetting.run('summaryLLMEnabled', 'false', Date.now());
  insertSetting.run('summaryLLMConfig', 'null', Date.now());
  // Permission mode defaults: 'auto' (YOLO) is the new-install default for
  // desktop chat, cron automation, and IM gateway. INSERT OR IGNORE means
  // existing installs are not touched. Users can still switch each surface
  // to 'default' (ask) or 'bypass' (full access) via Settings → Security.
  insertSetting.run('permissionMode', 'auto', Date.now());
  insertSetting.run('cronPermissionMode', 'auto', Date.now());
  insertSetting.run('gatewayPermissionMode', 'auto', Date.now());

  const insertCanvas = db.prepare(`
    INSERT OR IGNORE INTO conductor_canvases (id, name, description, layout_config, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  insertCanvas.run('default', '工作台', null, '{}', 0, now, now);

  runMigrations(db);
}

/**
 * Normalize content for FTS5 indexing.
 *
 * Splits camelCase / digit boundaries and appends the original lowercase
 * form so both the split and unsplit variants are searchable. trigram
 * tokenizer handles CJK + substring; this UDF expands identifier hits.
 *
 * MUST stay in sync with packages/agent/src/session/db.ts:normalizeForFts.
 * Both processes share the same SQLite DB file and trigger definitions,
 * so any divergence causes "no such function" or stale-index bugs.
 */
function normalizeForFts(s: string | null | undefined): string {
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

/**
 * Register the SQL UDF used by FTS5 triggers to normalize content at insert
 * time. MUST be called on every DB connection that owns the FTS5 triggers,
 * before any trigger that references fts_normalize() is created or fired.
 *
 * Both the main process (electron/db/schema.ts) and the agent worker
 * (packages/agent/src/session/db.ts) open the same SQLite DB file. SQLite
 * UDFs are per-connection, so each process must register independently.
 * If the main process skips this, any INSERT/UPDATE on `messages` fires
 * the agent-installed trigger and fails with "no such function: fts_normalize".
 */
function registerFtsUdfs(db: BetterSqlite3Db): void {
  db.function('fts_normalize', { deterministic: true }, (s: unknown) => {
    return normalizeForFts(typeof s === 'string' ? s : null);
  });
}

/**
 * Initialize FTS5 virtual tables for session search.
 *
 * Schema:
 *   - messages_fts: per-message content, trigram tokenizer, used for body hits.
 *   - sessions_fts: per-session metadata (title / model / project_name /
 *                   agent_name), used for metadata hits.
 *
 * MUST stay in sync with packages/agent/src/session/db.ts:initializeFts5.
 * Both processes write to the same DB file; divergent trigger definitions
 * silently overwrite each other and break search.
 *
 * Migration: existing installs may have messages_fts built with
 * `porter unicode61`, which does not handle CJK or substring matching.
 * We detect the old schema via sqlite_master and drop+rebuild it.
 */
export function initializeFts5(db: BetterSqlite3Db): void {
  const logger = getLogger();
  try {
    const fts5Available = db.prepare(
      "SELECT 1 FROM pragma_compile_options WHERE compile_options = 'ENABLE_FTS5'"
    ).get();
    if (!fts5Available) {
      logger.info('FTS5 not available, session search will use LIKE fallback', undefined, LogComponent.DB);
      return;
    }

    // Register UDFs before any trigger that references them.
    registerFtsUdfs(db);

    // Detect old (porter unicode61) messages_fts and drop it so we can rebuild with trigram.
    const oldSchema = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'messages_fts'")
      .get() as { sql: string | null } | undefined;
    if (oldSchema?.sql && /porter unicode61/i.test(oldSchema.sql)) {
      logger.warn(
        'Rebuilding messages_fts: porter unicode61 -> trigram (one-time migration)',
        undefined,
        LogComponent.DB,
      );
      db.exec(`
        DROP TRIGGER IF EXISTS messages_ai;
        DROP TRIGGER IF EXISTS messages_ad;
        DROP TRIGGER IF EXISTS messages_au;
        DROP TABLE IF EXISTS messages_fts;
      `);
    }

    // Per-message content index. trigram tokenizer handles CJK + substring via fts_normalize().
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        session_id UNINDEXED,
        content,
        tokenize='trigram'
      );
    `);

    // Force DROP + CREATE on every boot so the trigger definition stays in
    // sync with the UDF. Historical migrations (id 8, 10) rebuilt these
    // triggers without fts_normalize(); without this forced rebuild, a stale
    // trigger from an old migration would fire fts_normalize() on the main
    // connection and fail with "no such function" because CREATE TRIGGER IF
    // NOT EXISTS does not update an existing trigger's body.
    db.exec(`
      DROP TRIGGER IF EXISTS messages_ai;
      DROP TRIGGER IF EXISTS messages_ad;
      DROP TRIGGER IF EXISTS messages_au;
    `);

    db.exec(`
      CREATE TRIGGER messages_ai AFTER INSERT ON messages WHEN new.msg_type IN ('text', 'tool_result') BEGIN
        INSERT INTO messages_fts(rowid, session_id, content)
        VALUES (new.rowid, new.session_id, fts_normalize(new.content));
      END;

      CREATE TRIGGER messages_ad AFTER DELETE ON messages WHEN old.msg_type IN ('text', 'tool_result') BEGIN
        DELETE FROM messages_fts WHERE rowid = old.rowid;
      END;

      CREATE TRIGGER messages_au AFTER UPDATE ON messages WHEN old.msg_type IN ('text', 'tool_result') OR new.msg_type IN ('text', 'tool_result') BEGIN
        DELETE FROM messages_fts WHERE rowid = old.rowid;
        INSERT INTO messages_fts(rowid, session_id, content)
        VALUES (new.rowid, new.session_id, fts_normalize(new.content));
      END;
    `);

    // Build the index if empty (covers fresh installs and post-migration rebuild).
    const ftsCount = db.prepare('SELECT COUNT(*) as cnt FROM messages_fts').get() as { cnt: number };
    if (ftsCount.cnt === 0) {
      db.exec(`
        INSERT INTO messages_fts(rowid, session_id, content)
        SELECT rowid, session_id, fts_normalize(content)
        FROM messages WHERE msg_type IN ('text', 'tool_result');
      `);
      logger.info('FTS5 messages_fts populated (trigram)', undefined, LogComponent.DB);
    }

    // Per-session metadata index. title heavily weighted in the search query.
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
        session_id UNINDEXED,
        title,
        model,
        project_name,
        agent_name,
        tokenize='trigram'
      );
    `);

    // Force rebuild sessions_fts triggers for the same reason as messages_fts.
    db.exec(`
      DROP TRIGGER IF EXISTS chat_sessions_ai_fts;
      DROP TRIGGER IF EXISTS chat_sessions_ad_fts;
      DROP TRIGGER IF EXISTS chat_sessions_au_fts;
    `);

    // Keep sessions_fts in sync with chat_sessions. Soft delete is handled at
    // query time (s.is_deleted = 0) so the same trigger covers all update paths.
    db.exec(`
      CREATE TRIGGER chat_sessions_ai_fts AFTER INSERT ON chat_sessions BEGIN
        INSERT INTO sessions_fts(rowid, session_id, title, model, project_name, agent_name)
        VALUES (
          new.rowid,
          new.id,
          fts_normalize(coalesce(new.title, '')),
          fts_normalize(coalesce(new.model, '')),
          fts_normalize(coalesce(new.project_name, '')),
          fts_normalize(coalesce(new.agent_name, ''))
        );
      END;

      CREATE TRIGGER chat_sessions_ad_fts AFTER DELETE ON chat_sessions BEGIN
        DELETE FROM sessions_fts WHERE session_id = old.id;
      END;

      CREATE TRIGGER chat_sessions_au_fts AFTER UPDATE ON chat_sessions BEGIN
        DELETE FROM sessions_fts WHERE session_id = old.id;
        INSERT INTO sessions_fts(rowid, session_id, title, model, project_name, agent_name)
        VALUES (
          new.rowid,
          new.id,
          fts_normalize(coalesce(new.title, '')),
          fts_normalize(coalesce(new.model, '')),
          fts_normalize(coalesce(new.project_name, '')),
          fts_normalize(coalesce(new.agent_name, ''))
        );
      END;
    `);

    const sessionsFtsCount = db
      .prepare('SELECT COUNT(*) as cnt FROM sessions_fts')
      .get() as { cnt: number };
    if (sessionsFtsCount.cnt === 0) {
      db.exec(`
        INSERT INTO sessions_fts(rowid, session_id, title, model, project_name, agent_name)
        SELECT rowid,
               id,
               fts_normalize(coalesce(title, '')),
               fts_normalize(coalesce(model, '')),
               fts_normalize(coalesce(project_name, '')),
               fts_normalize(coalesce(agent_name, ''))
        FROM chat_sessions;
      `);
      logger.info('FTS5 sessions_fts populated (trigram)', undefined, LogComponent.DB);
    }

    logger.info('FTS5 initialized successfully (trigram + sessions_fts)', undefined, LogComponent.DB);
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
  migrate: (db: BetterSqlite3Db) => void;
}

function ensureCriticalSchema(db: BetterSqlite3Db): void {
  // Runs on every startup, independent of the migration system. The tables
  // and column self-repairs here are required for the app to boot at all
  // (createSession INSERTs, canvas IPC, etc.), so they cannot rely on
  // _schema_migrations being in sync — a DB restored from backup or a
  // partially-applied migration set must still recover. The CREATE TABLE IF
  // NOT EXISTS and PRAGMA-based column checks make this idempotent and cheap.
  // New structural changes belong in a numbered migration; this function is
  // only for boot-critical safety nets that must always pass.
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      attachment_type TEXT NOT NULL,
      mime_type TEXT,
      data TEXT NOT NULL,
      original_url TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON message_attachments(message_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_attachments_session_id ON message_attachments(session_id)`);

  // Phase 3: per-model capability records (renderer-edited +
  // runtime-discovered). Source-of-truth for the user-edited
  // `contextWindow` etc. kept here so the capability survives
  // renderer reloads and the agent runtime can read it via
  // shared DB later.
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_model_capabilities (
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT,
      context_window INTEGER,
      max_output_tokens INTEGER,
      supports_tool_use INTEGER,
      supports_vision INTEGER,
      supports_reasoning INTEGER,
      supports_prompt_cache INTEGER,
      pricing_input_per_million REAL,
      pricing_output_per_million REAL,
      pricing_cache_read_per_million REAL,
      pricing_cache_write_per_million REAL,
      pricing_currency TEXT,
      source TEXT NOT NULL CHECK(source IN ('preset', 'models-api', 'user', 'probe')),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider_id, model_id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pmc_provider_id ON provider_model_capabilities(provider_id)`);

  // Self-repair: ensure chat_sessions has conductor columns.
  // Migration #37 adds these, but if _schema_migrations is out of sync
  // (e.g. id=37 marked applied by a prior different migration, or DB
  // restored from backup without rolling back migration records), the
  // migration would be skipped and createSession INSERTs would fail with
  // "no such column". This check runs on every startup, independent of
  // the migration system, so the app can always boot.
  ensureChatSessionColumns(db, [
    { name: 'conductor_mode_enabled', ddl: 'ALTER TABLE chat_sessions ADD COLUMN conductor_mode_enabled INTEGER NOT NULL DEFAULT 0' },
    { name: 'conductor_canvas_id', ddl: 'ALTER TABLE chat_sessions ADD COLUMN conductor_canvas_id TEXT DEFAULT NULL' },
  ]);

  // Self-repair: ensure conductor_canvases has project_path.
  // Migration #38 adds it, but if the packaged binary is older than #38,
  // or the DB was restored from backup without rolling back migration
  // records, the migration is skipped and canvas IPC calls fail with
  // "no such column: project_path". This check runs on every startup,
  // independent of the migration system, so the app can always boot.
  ensureConductorCanvasColumns(db);
}

/** Add missing columns to chat_sessions. Idempotent — skips columns that already exist. */
function ensureChatSessionColumns(
  db: BetterSqlite3Db,
  columns: Array<{ name: string; ddl: string }>,
): void {
  const tableInfo = db.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>;
  const existing = new Set(tableInfo.map((col) => col.name));
  for (const col of columns) {
    if (!existing.has(col.name)) {
      db.exec(col.ddl);
    }
  }
}

/**
 * Self-repair for `conductor_canvases.project_path`.
 *
 * Mirrors `ensureChatSessionColumns`: this column is added by migration #38,
 * but the packaged Beta build for users who upgraded from a pre-#38 binary
 * (or restored a DB whose `_schema_migrations` row was lost) will report
 * `SqliteError: no such column: project_path` on every canvas IPC call.
 *
 * We re-create the unique partial index here too — `CREATE UNIQUE INDEX IF
 * NOT EXISTS` is idempotent, so this is safe to run on every startup.
 */
function ensureConductorCanvasColumns(db: BetterSqlite3Db): void {
  const tableInfo = db.prepare('PRAGMA table_info(conductor_canvases)').all() as Array<{ name: string }>;
  const existing = new Set(tableInfo.map((col) => col.name));
  if (!existing.has('project_path')) {
    db.exec(`ALTER TABLE conductor_canvases ADD COLUMN project_path TEXT`);
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_conductor_canvases_project_path ON conductor_canvases(project_path) WHERE project_path IS NOT NULL`,
  );
}

function ensureMigrationsTable(db: BetterSqlite3Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') * 1000 AS INTEGER))
    )
  `);
}

function isMigrationApplied(db: BetterSqlite3Db, migrationId: number): boolean {
  const result = db.prepare('SELECT id FROM _schema_migrations WHERE id = ?').get(migrationId);
  return !!result;
}

function markMigrationApplied(db: BetterSqlite3Db, migration: Migration): void {
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

        // fts_normalize UDF is registered by initializeFts5() which runs before
        // migrations in initializeSchema(). Triggers MUST use fts_normalize() to
        // stay in sync with the agent worker's trigger definitions.
        db.exec(`
          CREATE TRIGGER messages_ai AFTER INSERT ON messages
          WHEN new.msg_type IN ('text', 'tool_result') BEGIN
            INSERT INTO messages_fts(rowid, session_id, content)
            VALUES (new.rowid, new.session_id, fts_normalize(new.content));
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
            VALUES (new.rowid, new.session_id, fts_normalize(new.content));
          END
        `);

        const ftsCount = db.prepare('SELECT COUNT(*) as cnt FROM messages_fts').get() as { cnt: number };
        if (ftsCount.cnt === 0) {
          db.exec(`
            INSERT INTO messages_fts(rowid, session_id, content)
            SELECT rowid, session_id, fts_normalize(content) FROM messages WHERE msg_type IN ('text', 'tool_result')
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
        // Soft-delete: mark legacy metadata/junk messages as 'purged' rather
        // than hard-DELETE, preserving the append-only contract. Read paths
        // filter status NOT IN ('superseded', 'purged').
        for (const pattern of metadataPatterns) {
          db.prepare(
            "UPDATE messages SET status = 'purged' WHERE content LIKE ? AND status != 'purged'"
          ).run(pattern);
        }
        db.prepare(
          "UPDATE messages SET status = 'purged' WHERE content LIKE '[thinking] %' AND status != 'purged'"
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

        // fts_normalize UDF is registered by initializeFts5() which runs before
        // migrations. Triggers MUST use fts_normalize() to stay in sync with
        // the agent worker's trigger definitions.
        db.exec(`
          CREATE TRIGGER messages_ai AFTER INSERT ON messages
          WHEN new.msg_type IN ('text', 'tool_result') BEGIN
            INSERT INTO messages_fts(rowid, session_id, content)
            VALUES (new.rowid, new.session_id, fts_normalize(new.content));
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
            VALUES (new.rowid, new.session_id, fts_normalize(new.content));
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
          native_kind  TEXT,
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
      db.exec(`CREATE INDEX IF NOT EXISTS idx_elements_native_kind ON conductor_elements(canvas_id, native_kind)`);

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
  {
    id: 23,
    name: 'add_attachments_to_messages',
    migrate: (db) => {
      const tableInfo = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
      const columns = tableInfo.map(col => col.name);
      if (!columns.includes('attachments')) {
        db.exec(`ALTER TABLE messages ADD COLUMN attachments TEXT`);
      }
    },
  },
  {
    id: 24,
    name: 'add_native_kind_to_conductor_elements',
    migrate: (db) => {
      const tableInfo = db.prepare('PRAGMA table_info(conductor_elements)').all() as Array<{ name: string }>;
      const columns = tableInfo.map(col => col.name);
      if (!columns.includes('native_kind')) {
        db.exec(`ALTER TABLE conductor_elements ADD COLUMN native_kind TEXT`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_elements_native_kind ON conductor_elements(canvas_id, native_kind)`);
      }
    },
  },
  {
    id: 25,
    name: 'add_draft_message_to_chat_sessions',
    migrate: (db) => {
      const tableInfo = db.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>;
      const columns = tableInfo.map(col => col.name);
      if (!columns.includes('draft_message')) {
        db.exec(`ALTER TABLE chat_sessions ADD COLUMN draft_message TEXT NOT NULL DEFAULT ''`);
      }
    },
  },
  {
    id: 26,
    name: 'ensure_message_attachments_table',
    migrate: (db) => {
      ensureCriticalSchema(db);
    },
  },
  {
    id: 27,
    name: 'create_literature_plugin_tables',
    migrate: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS literature_sources (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          title TEXT NOT NULL,
          authors_json TEXT NOT NULL DEFAULT '[]',
          year INTEGER,
          venue TEXT,
          doi TEXT,
          arxiv_id TEXT,
          url TEXT,
          file_path TEXT,
          citation_key TEXT,
          bibtex TEXT,
          project_ids_json TEXT NOT NULL DEFAULT '[]',
          tags_json TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS literature_evidence_spans (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL,
          page INTEGER,
          section TEXT,
          text TEXT NOT NULL,
          quote TEXT,
          bbox_json TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (source_id) REFERENCES literature_sources(id) ON DELETE CASCADE
        )
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS literature_paper_cards (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL UNIQUE,
          card_json TEXT NOT NULL,
          evidence_span_ids_json TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (source_id) REFERENCES literature_sources(id) ON DELETE CASCADE
        )
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS literature_annotations (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL,
          evidence_span_id TEXT,
          content TEXT NOT NULL,
          tags_json TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (source_id) REFERENCES literature_sources(id) ON DELETE CASCADE
        )
      `);

      db.exec(`CREATE INDEX IF NOT EXISTS idx_literature_sources_kind ON literature_sources(kind)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_literature_sources_title ON literature_sources(title)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_literature_spans_source ON literature_evidence_spans(source_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_literature_cards_source ON literature_paper_cards(source_id)`);
    },
  },
  {
    id: 28,
    name: 'create_research_memory_tables',
    migrate: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS research_projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS research_project_states (
          project_id TEXT PRIMARY KEY,
          state_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE CASCADE
        )
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS research_memory_objects (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          type TEXT NOT NULL,
          content TEXT NOT NULL,
          summary TEXT,
          source_refs_json TEXT NOT NULL DEFAULT '[]',
          relation_refs_json TEXT NOT NULL DEFAULT '[]',
          valid_from INTEGER,
          valid_to INTEGER,
          status TEXT NOT NULL DEFAULT 'active',
          confidence REAL NOT NULL DEFAULT 0.5,
          importance REAL NOT NULL DEFAULT 0.5,
          tags_json TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE CASCADE
        )
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS research_hypotheses (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          statement TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'proposed',
          supporting_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
          contradicting_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
          related_source_ids_json TEXT NOT NULL DEFAULT '[]',
          superseded_by TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE CASCADE
        )
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS research_memory_candidates (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          proposed_type TEXT NOT NULL,
          content TEXT NOT NULL,
          rationale TEXT NOT NULL,
          source_refs_json TEXT NOT NULL DEFAULT '[]',
          confidence REAL NOT NULL DEFAULT 0.5,
          status TEXT NOT NULL DEFAULT 'pending',
          created_by_session_id TEXT,
          created_at INTEGER NOT NULL,
          reviewed_at INTEGER,
          FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE CASCADE
        )
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS research_memory_relations (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          from_memory_id TEXT NOT NULL,
          to_memory_id TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE CASCADE
        )
      `);

      db.exec(`CREATE INDEX IF NOT EXISTS idx_research_objects_project ON research_memory_objects(project_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_research_objects_type ON research_memory_objects(type)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_research_hypotheses_project ON research_hypotheses(project_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_research_candidates_project ON research_memory_candidates(project_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_research_candidates_status ON research_memory_candidates(status)`);
    },
  },
  {
    id: 29,
    name: 'add_embedding_json_to_research_memory_objects',
    migrate(db: BetterSqlite3Db): void {
      // Add embedding_json column for semantic vector search
      // Uses dynamic column check to avoid errors on re-run
      const tableInfo = db.prepare('PRAGMA table_info(research_memory_objects)').all() as Array<{ name: string }>;
      const hasEmbeddingColumn = tableInfo.some((col) => col.name === 'embedding_json');
      if (!hasEmbeddingColumn) {
        db.exec(`ALTER TABLE research_memory_objects ADD COLUMN embedding_json TEXT`);
      }
    },
  },
  {
    id: 30,
    name: 'add_indexes_for_research_relations',
    migrate(db: BetterSqlite3Db): void {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_research_relations_from ON research_memory_relations(from_memory_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_research_relations_to ON research_memory_relations(to_memory_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_research_relations_project ON research_memory_relations(project_id)`);
    },
  },
  {
    id: 31,
    name: 'create_import_tables',
    migrate(db: BetterSqlite3Db): void {
      db.exec(`
        CREATE TABLE IF NOT EXISTS import_batches (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          source_project_path TEXT,
          target_project_path TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          total_items INTEGER NOT NULL DEFAULT 0,
          applied_items INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          rolled_back_at INTEGER
        )
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS import_items (
          id TEXT PRIMARY KEY,
          batch_id TEXT NOT NULL REFERENCES import_batches(id),
          source_type TEXT NOT NULL,
          source_path TEXT NOT NULL,
          source_hash TEXT,
          target_type TEXT NOT NULL,
          target_path TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT,
          risk_level TEXT NOT NULL DEFAULT 'safe',
          requires_auth INTEGER NOT NULL DEFAULT 0,
          is_enabled INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'imported',
          created_at INTEGER NOT NULL
        )
      `);

      db.exec(`CREATE INDEX IF NOT EXISTS idx_import_items_batch ON import_items(batch_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_import_batches_project ON import_batches(target_project_path)`);
    },
  },
  {
    id: 32,
    name: 'create_deep_research_artifact_tables',
    migrate(db: BetterSqlite3Db): void {
      db.exec(`
        CREATE TABLE IF NOT EXISTS research_sessions (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          original_query TEXT NOT NULL,
          clarification TEXT,
          context_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'active',
          current_phase TEXT NOT NULL DEFAULT 'idle',
          iterations INTEGER NOT NULL DEFAULT 0,
          coverage REAL NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          title TEXT,
          run_status TEXT,
          plan_version INTEGER NOT NULL DEFAULT 0,
          active_step_id TEXT,
          progress_summary TEXT,
          completed_at INTEGER,
          error_json TEXT,
          FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
        )
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS research_plan_steps (
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

      db.exec(`
        CREATE TABLE IF NOT EXISTS research_activities (
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
        )
      `);

      db.exec(`
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
        )
      `);

      db.exec(`
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
        )
      `);

      db.exec(`
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
        )
      `);

      const sessionColumns = db.prepare('PRAGMA table_info(research_sessions)').all() as Array<{ name: string }>;
      const columnNames = sessionColumns.map((col) => col.name);
      const columnsToAdd: Array<{ name: string; ddl: string }> = [
        { name: 'title', ddl: 'ALTER TABLE research_sessions ADD COLUMN title TEXT' },
        { name: 'run_status', ddl: 'ALTER TABLE research_sessions ADD COLUMN run_status TEXT' },
        { name: 'plan_version', ddl: 'ALTER TABLE research_sessions ADD COLUMN plan_version INTEGER NOT NULL DEFAULT 0' },
        { name: 'active_step_id', ddl: 'ALTER TABLE research_sessions ADD COLUMN active_step_id TEXT' },
        { name: 'progress_summary', ddl: 'ALTER TABLE research_sessions ADD COLUMN progress_summary TEXT' },
        { name: 'completed_at', ddl: 'ALTER TABLE research_sessions ADD COLUMN completed_at INTEGER' },
        { name: 'error_json', ddl: 'ALTER TABLE research_sessions ADD COLUMN error_json TEXT' },
      ];
      for (const col of columnsToAdd) {
        if (!columnNames.includes(col.name)) {
          db.exec(col.ddl);
        }
      }

      db.exec(`CREATE INDEX IF NOT EXISTS idx_research_sessions_session ON research_sessions(session_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_research_sessions_status ON research_sessions(status)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_research_plan_steps_run ON research_plan_steps(run_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_research_activities_run ON research_activities(run_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_research_activities_seq ON research_activities(run_id, sequence)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_research_events_run_seq ON research_events(run_id, sequence)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_research_sources_run ON research_sources(run_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_research_sources_policy ON research_sources(run_id, allowed_by_policy)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_research_reports_run ON research_reports(run_id, updated_at DESC)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_research_citations_run ON research_citations(run_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_research_citations_report ON research_citations(report_id)`);
    },
  },
  {
    id: 33,
    name: 'enforce_research_event_sequence_uniqueness',
    migrate(db: BetterSqlite3Db): void {
      db.exec(`
        DELETE FROM research_events
        WHERE rowid NOT IN (
          SELECT MIN(rowid)
          FROM research_events
          GROUP BY run_id, sequence
        )
      `);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_research_events_run_seq ON research_events(run_id, sequence)`);
    },
  },
  {
    id: 34,
    name: 'prune_disabled_conductor_element_kinds',
    migrate(db: BetterSqlite3Db): void {
      // Canvas element kinds removed in the conductor experience overhaul.
      // Keep only: native/sticky, native/connector, native/mindmap,
      // widget/task-list, widget/note-pad, widget/pomodoro, widget/news-board.
      const allowedKinds = [
        'native/sticky',
        'native/connector',
        'native/mindmap',
        'widget/task-list',
        'widget/note-pad',
        'widget/pomodoro',
        'widget/news-board',
      ];
      const allowedNativeKinds = ['sticky', 'connector', 'mindmap'];

      const placeholders = allowedKinds.map(() => '?').join(',');
      const nativePlaceholders = allowedNativeKinds.map(() => '?').join(',');

      // Drop elements whose kind is not in the allowlist. Also drop their
      // mirrored widget rows and any actions that referenced them.
      const elementIds = db
        .prepare(
          `SELECT id FROM conductor_elements
           WHERE element_kind NOT IN (${placeholders})
              OR (native_kind IS NOT NULL
                  AND native_kind != ''
                  AND native_kind NOT IN (${nativePlaceholders}))`
        )
        .all(...allowedKinds, ...allowedNativeKinds) as Array<{ id: string }>;

      if (elementIds.length === 0) {
        return;
      }

      const ids = elementIds.map((row) => row.id);
      const idPlaceholders = ids.map(() => '?').join(',');
      const txn = db.transaction(() => {
        db.prepare(
          `DELETE FROM conductor_widgets WHERE id IN (${idPlaceholders})`
        ).run(...ids);
        db.prepare(
          `DELETE FROM conductor_actions
           WHERE widget_id IN (${idPlaceholders})`
        ).run(...ids);
        db.prepare(
          `DELETE FROM conductor_elements
           WHERE id IN (${idPlaceholders})`
        ).run(...ids);
      });
      txn();
    },
  },
  {
    id: 35,
    name: 'add_display_content_to_messages',
    migrate(db: BetterSqlite3Db): void {
      const tableInfo = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
      const columns = tableInfo.map(col => col.name);
      if (!columns.includes('display_content')) {
        db.exec(`ALTER TABLE messages ADD COLUMN display_content TEXT`);
      }
      db.exec(`UPDATE messages SET display_content = NULL WHERE display_content = ''`);
    },
  },
  {
    id: 36,
    name: 'prune_conductor_mindmap_elements',
    migrate(db: BetterSqlite3Db): void {
      // Mind map elements are removed in the conductor toolbar simplification.
      // Drop any native/mindmap elements along with their mirrored widget rows
      // and action-log entries so stale data does not linger on the canvas.
      const mindmapIds = db
        .prepare(
          `SELECT id FROM conductor_elements
           WHERE element_kind = 'native/mindmap' OR native_kind = 'mindmap'`
        )
        .all() as Array<{ id: string }>;

      if (mindmapIds.length === 0) {
        return;
      }

      const ids = mindmapIds.map((row) => row.id);
      const idPlaceholders = ids.map(() => '?').join(',');
      const txn = db.transaction(() => {
        db.prepare(
          `DELETE FROM conductor_widgets WHERE id IN (${idPlaceholders})`
        ).run(...ids);
        db.prepare(
          `DELETE FROM conductor_actions
           WHERE widget_id IN (${idPlaceholders})`
        ).run(...ids);
        db.prepare(
          `DELETE FROM conductor_elements
           WHERE id IN (${idPlaceholders})`
        ).run(...ids);
      });
      txn();
    },
  },
  {
    id: 37,
    name: 'add_conductor_session_binding_columns',
    migrate(db: BetterSqlite3Db): void {
      const tableInfo = db.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>;
      const columns = tableInfo.map((col) => col.name);
      if (!columns.includes('conductor_mode_enabled')) {
        db.exec(`ALTER TABLE chat_sessions ADD COLUMN conductor_mode_enabled INTEGER NOT NULL DEFAULT 0`);
      }
      if (!columns.includes('conductor_canvas_id')) {
        db.exec(`ALTER TABLE chat_sessions ADD COLUMN conductor_canvas_id TEXT DEFAULT NULL`);
      }
    },
  },
  {
    id: 38,
    name: 'add_conductor_canvas_project_path',
    migrate(db: BetterSqlite3Db): void {
      const tableInfo = db.prepare('PRAGMA table_info(conductor_canvases)').all() as Array<{ name: string }>;
      const columns = tableInfo.map((col) => col.name);
      if (!columns.includes('project_path')) {
        db.exec(`ALTER TABLE conductor_canvases ADD COLUMN project_path TEXT`);
      }
      // Unique index so a project maps to at most one canvas.
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conductor_canvases_project_path ON conductor_canvases(project_path) WHERE project_path IS NOT NULL`);
    },
  },
  {
    id: 39,
    name: 'add_automation_cron_working_directory',
    migrate(db: BetterSqlite3Db): void {
      const tableInfo = db.prepare('PRAGMA table_info(automation_crons)').all() as Array<{ name: string }>;
      if (!tableInfo.some((column) => column.name === 'working_directory')) {
        db.exec(`ALTER TABLE automation_crons ADD COLUMN working_directory TEXT NOT NULL DEFAULT ''`);
      }
    },
  },
  {
    id: 41,
    name: 'add_automation_cron_schedule_end_at',
    migrate(db: BetterSqlite3Db): void {
      const tableInfo = db.prepare('PRAGMA table_info(automation_crons)').all() as Array<{ name: string }>;
      if (!tableInfo.some((column) => column.name === 'schedule_end_at')) {
        db.exec(`ALTER TABLE automation_crons ADD COLUMN schedule_end_at TEXT`);
      }
    },
  },
  {
    id: 42,
    name: 'add_chat_sessions_parent_delete_set_null',
    migrate(db: BetterSqlite3Db): void {
      // SQLite does not allow adding ON DELETE behavior to an existing column.
      // Use a trigger to set child session parent_id to NULL when the parent
      // session is deleted, preventing FOREIGN KEY constraint failures.
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_chat_sessions_parent_set_null
        AFTER DELETE ON chat_sessions
        FOR EACH ROW
        WHEN OLD.id IS NOT NULL
        BEGIN
          UPDATE chat_sessions SET parent_id = NULL WHERE parent_id = OLD.id;
        END;
      `);
    },
  },
  {
    id: 43,
    name: 'add_chat_turn_reviews',
    migrate(db: BetterSqlite3Db): void {
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_turn_reviews (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          working_directory TEXT NOT NULL,
          files_json TEXT NOT NULL,
          patch TEXT NOT NULL,
          additions INTEGER NOT NULL DEFAULT 0,
          removals INTEGER NOT NULL DEFAULT 0,
          truncated INTEGER NOT NULL DEFAULT 0,
          binary INTEGER NOT NULL DEFAULT 0,
          captured_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
          UNIQUE(session_id, turn_id)
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_turn_reviews_latest ON chat_turn_reviews(session_id, captured_at DESC)`);
    },
  },
  {
    id: 44,
    name: 'add_provider_state-and-signature-columns',
    migrate(db: BetterSqlite3Db): void {
      // Add provider_state and per-content signature columns to messages.
      // provider_state stores the provider-native state JSON (api, providerId,
      // model, responseId). *_signature columns store the signature fields
      // from provider content blocks (thinkingSignature / thoughtSignature /
      // textSignature) so they round-trip through the DB without being
      // lossily merged into content.
      const tableInfo = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
      const columns = tableInfo.map((col) => col.name);
      const newColumns: Array<{ name: string; ddl: string }> = [
        { name: 'provider_state', ddl: 'ALTER TABLE messages ADD COLUMN provider_state TEXT' },
        { name: 'thinking_signature', ddl: 'ALTER TABLE messages ADD COLUMN thinking_signature TEXT' },
        { name: 'tool_signature', ddl: 'ALTER TABLE messages ADD COLUMN tool_signature TEXT' },
        { name: 'text_signature', ddl: 'ALTER TABLE messages ADD COLUMN text_signature TEXT' },
      ];
      for (const col of newColumns) {
        if (!columns.includes(col.name)) {
          db.exec(col.ddl);
        }
      }
    },
  },
  {
    id: 45,
    name: 'mailbox-kind-background_notification',
    migrate(db: BetterSqlite3Db): void {
      // Relax the agent_mailbox.kind CHECK to accept the new
      // 'background_notification' kind (sub-agent / background command
      // completion notifications now flow through the mailbox like followups).
      // SQLite cannot ALTER a CHECK constraint, so rebuild the table when the
      // current definition lacks the new kind. Idempotent: a table whose SQL
      // already contains 'background_notification' is left untouched.
      const sql = (
        db.prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_mailbox'",
        ).get() as { sql?: string } | undefined
      )?.sql;
      if (!sql || sql.includes('background_notification')) return;

      const tableInfo = db.prepare('PRAGMA table_info(agent_mailbox)').all() as Array<{ name: string; pk: number }>;
      // Copy only the columns that exist in the rebuilt table. Older dev DBs
      // may carry a stale column (e.g. `display_order`, long since removed from
      // the schema) that the canonical definition below no longer has; copying
      // the intersection drops it safely instead of failing the INSERT.
      const rebuildColumns = [
        'id','session_id','submitted_during_run_id','content','kind','status',
        'priority','constraints_json','attachments_json','source','client_msg_id',
        'created_at','claim_token','claim_expires_at','observed_at',
        'observed_at_checkpoint','observed_by_run_id','claim_attempts',
        'last_claim_error','edit_locked_at','apply_mode','applied_at',
        'applied_at_checkpoint','applied_summary','resulting_user_msg_id',
        'failure_reason','edit_history_json','cancelled_at','cancelled_by',
        'cancel_reason',
      ];
      const copyColumns = tableInfo
        .map((col) => col.name)
        .filter((name) => rebuildColumns.includes(name));
      const quoted = copyColumns.map((n) => `"${n}"`).join(', ');

      // runMigrations already wraps each migration in a transaction, so the
      // rebuild below runs atomically without an explicit BEGIN/COMMIT here.
      db.exec(`
        ALTER TABLE agent_mailbox RENAME TO agent_mailbox_old;

        CREATE TABLE agent_mailbox (
          id                     TEXT PRIMARY KEY,
          session_id             TEXT NOT NULL,
          submitted_during_run_id TEXT NOT NULL,
          content                TEXT NOT NULL,
          kind                   TEXT NOT NULL,
          status                 TEXT NOT NULL,
          priority               INTEGER NOT NULL DEFAULT 100,
          constraints_json       TEXT,
          attachments_json       TEXT,
          source                 TEXT NOT NULL DEFAULT 'ui',
          client_msg_id          TEXT,
          created_at             INTEGER NOT NULL,
          claim_token            TEXT,
          claim_expires_at       INTEGER,
          observed_at            INTEGER,
          observed_at_checkpoint TEXT,
          observed_by_run_id     TEXT,
          claim_attempts         INTEGER NOT NULL DEFAULT 0,
          last_claim_error       TEXT,
          edit_locked_at         INTEGER,
          apply_mode             TEXT,
          applied_at             INTEGER,
          applied_at_checkpoint  TEXT,
          applied_summary        TEXT,
          resulting_user_msg_id  TEXT,
          failure_reason         TEXT,
          edit_history_json      TEXT,
          cancelled_at           INTEGER,
          cancelled_by           TEXT,
          cancel_reason          TEXT,
          CHECK (kind IN ('followup','correction','constraint','stop','abort_and_replace','background_notification')),
          CHECK (status IN ('pending','observed','applied','cancelled')),
          CHECK (apply_mode IS NULL OR apply_mode IN
            ('promote_to_user_message','runtime_instruction','tool_guard',
             'permission_context','interrupt_signal','deferred_to_next_turn'))
        );

        INSERT INTO agent_mailbox (${quoted})
          SELECT ${quoted} FROM agent_mailbox_old;

        DROP TABLE agent_mailbox_old;

        CREATE INDEX IF NOT EXISTS idx_mailbox_claim_ready
          ON agent_mailbox(session_id, status, priority, created_at)
          WHERE status = 'pending'
             OR (status = 'observed' AND claim_expires_at IS NOT NULL);

        CREATE INDEX IF NOT EXISTS idx_mailbox_session_recent
          ON agent_mailbox(session_id, created_at DESC);

        CREATE UNIQUE INDEX IF NOT EXISTS uq_mailbox_client_msg
          ON agent_mailbox(session_id, client_msg_id)
          WHERE client_msg_id IS NOT NULL;
      `);
    },
  },
];

/**
 * Run all pending database migrations in order.
 * Creates the _schema_migrations table if it does not exist.
 */
export function runMigrations(db: BetterSqlite3Db): void {
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

/**
 * Run an explicit startup schema self-check and repair for critical tables.
 */
export function selfCheckAndRepairSchema(db: BetterSqlite3Db): void {
  const logger = getLogger();
  try {
    ensureCriticalSchema(db);
    logger.info('Schema self-check completed', { repaired: ['message_attachments', 'chat_sessions_conductor_columns'] }, LogComponent.DBMigration);
  } catch (error) {
    logger.error(
      'Schema self-check failed',
      error instanceof Error ? error : new Error(String(error)),
      undefined,
      LogComponent.DBMigration
    );
    throw error;
  }
}
