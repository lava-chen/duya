import Database from 'better-sqlite3';

/**
 * Create an in-memory SQLite database for testing
 * This avoids file system operations and state pollution
 */
export function createInMemoryDb(): Database.Database {
  const db = new Database(':memory:');

  // Initialize schema
  db.exec(`
    CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      model TEXT,
      system_prompt TEXT,
      working_directory TEXT,
      sdk_session_id TEXT,
      permission_profile TEXT DEFAULT 'full_access',
      mode TEXT DEFAULT 'agent',
      runtime_status TEXT DEFAULT 'idle',
      runtime_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      token_usage INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id)
    );

    CREATE INDEX idx_messages_session_id ON messages(session_id);
    CREATE INDEX idx_messages_created_at ON messages(created_at);
  `);

  return db;
}
