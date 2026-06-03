/**
 * packages/agent/tests/cli-control-plane/seed-db.mjs
 *
 * One-shot helper: creates a fresh test database with the minimum
 * schema needed by the session control plane query functions, and
 * inserts the rows described in the JSON payload file pointed to by
 * CLI_SEED_PAYLOAD_FILE.
 *
 * Schema mirrors electron/db/schema.ts lines 12-34 (chat_sessions)
 * and lines 78-99 (messages), plus the required indexes. This is a
 * subset of the production schema sufficient for the read-only
 * `listSessionSummaries` / `getSessionSummary` queries.
 *
 * NEVER run this against a real user-data directory.
 */

const { app } = require('electron');
const Database = require('better-sqlite3');
const { join } = require('node:path');
const { mkdirSync, existsSync, readFileSync, writeFileSync } = require('node:fs');

const payloadFile = process.env.CLI_SEED_PAYLOAD_FILE;
if (!payloadFile) {
  writeFileSync('E:/Projects/duya/_dbg-out.txt', 'CLI_SEED_PAYLOAD_FILE required');
  app.exit(1);
}

let raw;
try {
  raw = readFileSync(payloadFile, 'utf-8');
} catch (err) {
  writeFileSync(
    'E:/Projects/duya/_dbg-out.txt',
    'read payload failed: ' + String(err),
  );
  app.exit(1);
}

let payload;
try {
  payload = JSON.parse(raw);
} catch (err) {
  writeFileSync('E:/Projects/duya/_dbg-out.txt', 'bad json: ' + String(err));
  app.exit(1);
}

const { userData, sessions } = payload;
if (!userData || !Array.isArray(sessions)) {
  writeFileSync(
    'E:/Projects/duya/_dbg-out.txt',
    'bad payload shape: ' + JSON.stringify(payload).slice(0, 200),
  );
  app.exit(1);
}

// Set the userData path the same way the harness / real GUI do.
app.setName('DUYA');
app.setPath('userData', userData);

app.whenReady().then(() => {
  try {
    const dbDir = join(userData, 'databases');
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, 'duya-main.db');

    if (!existsSync(dbPath)) {
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
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
        CREATE INDEX IF NOT EXISTS idx_sessions_parent_id ON chat_sessions(parent_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON chat_sessions(updated_at DESC);
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          msg_type TEXT NOT NULL DEFAULT 'text',
          status TEXT NOT NULL DEFAULT 'done',
          created_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
      `);
      db.close();
    }

    const db = new Database(dbPath);
    const now = Date.now();

    const insertSession = db.prepare(`
      INSERT OR REPLACE INTO chat_sessions (
        id, title, created_at, updated_at, model, system_prompt,
        working_directory, project_name, status, mode, permission_profile,
        provider_id, context_summary, context_summary_updated_at,
        is_deleted, generation, parent_id, agent_type, agent_name
      ) VALUES (
        @id, @title, @now, @now, @model, '',
        '', '', 'active', @mode, 'default',
        'env', '', 0,
        @is_deleted, 0, @parent_id, @agent_type, ''
      )
    `);
    const insertMessage = db.prepare(`
      INSERT OR REPLACE INTO messages (id, session_id, role, content, msg_type, status, created_at)
      VALUES (?, ?, ?, ?, 'text', 'done', ?)
    `);

    const insertAll = db.transaction(() => {
      for (const s of sessions) {
        const id = s.gateway ? `gw-${s.id}` : s.id;
        insertSession.run({
          id,
          title: s.title ?? 'Test Session',
          now,
          mode: s.mode ?? 'code',
          is_deleted: s.is_deleted ?? 0,
          parent_id: s.parent_id ?? null,
          agent_type: s.agent_type ?? 'main',
          model: s.model ?? 'claude-test',
        });
        const count = s.messageCount ?? 0;
        for (let i = 0; i < count; i++) {
          insertMessage.run(`msg-${id}-${i}`, id, 'user', `test ${i}`, now);
        }
      }
    });
    insertAll();
    db.close();
    app.exit(0);
  } catch (err) {
    writeFileSync(
      'E:/Projects/duya/_dbg-out.txt',
      'seed error: ' + (err instanceof Error ? err.stack : String(err)),
    );
    app.exit(1);
  }
});
