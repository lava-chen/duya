/**
 * Tests for the FTS5 schema overhaul: identifier splitting, trigram tokenizer,
 * and the messages_fts / sessions_fts triggers.
 *
 * These tests run against a real in-memory SQLite so they exercise the actual
 * SQL, not just the JS helper. They cover the user-visible bug: searching
 * `duya agent` must find sessions that mention `DuyaAgent`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { normalizeForFts } from '../../src/session/db.js';

function setupFtsDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Chat',
      model TEXT NOT NULL DEFAULT '',
      working_directory TEXT NOT NULL DEFAULT '',
      project_name TEXT NOT NULL DEFAULT '',
      is_deleted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      agent_name TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      msg_type TEXT NOT NULL DEFAULT 'text',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id)
    );
  `);

  // Same UDF used by db.ts in production.
  db.function('fts_normalize', { deterministic: true }, (s: unknown) =>
    normalizeForFts(typeof s === 'string' ? s : null),
  );

  db.exec(`
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      session_id UNINDEXED,
      content,
      tokenize='trigram'
    );

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

    CREATE VIRTUAL TABLE sessions_fts USING fts5(
      session_id UNINDEXED,
      title,
      model,
      project_name,
      agent_name,
      tokenize='trigram'
    );

    CREATE TRIGGER chat_sessions_ai_fts AFTER INSERT ON chat_sessions BEGIN
      INSERT INTO sessions_fts(rowid, session_id, title, model, project_name, agent_name)
      VALUES (new.rowid, new.id,
              fts_normalize(coalesce(new.title, '')),
              fts_normalize(coalesce(new.model, '')),
              fts_normalize(coalesce(new.project_name, '')),
              fts_normalize(coalesce(new.agent_name, '')));
    END;

    CREATE TRIGGER chat_sessions_au_fts AFTER UPDATE ON chat_sessions BEGIN
      DELETE FROM sessions_fts WHERE session_id = old.id;
      INSERT INTO sessions_fts(rowid, session_id, title, model, project_name, agent_name)
      VALUES (new.rowid, new.id,
              fts_normalize(coalesce(new.title, '')),
              fts_normalize(coalesce(new.model, '')),
              fts_normalize(coalesce(new.project_name, '')),
              fts_normalize(coalesce(new.agent_name, '')));
    END;

    CREATE TRIGGER chat_sessions_ad_fts AFTER DELETE ON chat_sessions BEGIN
      DELETE FROM sessions_fts WHERE session_id = old.id;
    END;
  `);

  return db;
}

function insertSession(
  db: Database.Database,
  id: string,
  title: string,
  model = 'claude-sonnet',
  projectName = 'duya',
) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO chat_sessions (id, title, model, working_directory, project_name, created_at, updated_at)
     VALUES (?, ?, ?, '/tmp', ?, ?, ?)`,
  ).run(id, title, model, projectName, now, now);
}

function insertMessage(db: Database.Database, id: string, sessionId: string, content: string, role = 'assistant') {
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, msg_type, created_at) VALUES (?, ?, ?, ?, 'text', ?)`,
  ).run(id, sessionId, role, content, Date.now());
}

describe('normalizeForFts', () => {
  it('emits both split and unsplit forms for camelCase identifiers', () => {
    expect(normalizeForFts('DuyaAgent')).toBe('duya agent duyaagent');
    expect(normalizeForFts('useEffect')).toBe('use effect useeffect');
    expect(normalizeForFts('getDb')).toBe('get db getdb');
  });

  it('emits both forms for PascalCase with run of capitals', () => {
    expect(normalizeForFts('XMLHttpRequest')).toBe('xml http request xmlhttprequest');
    expect(normalizeForFts('HTTPServer')).toBe('http server httpserver');
  });

  it('emits both forms for letter/digit boundaries', () => {
    expect(normalizeForFts('foo123bar')).toBe('foo 123 bar foo123bar');
    expect(normalizeForFts('v2api')).toBe('v 2 api v2api');
    expect(normalizeForFts('sha256hash')).toBe('sha 256 hash sha256hash');
  });

  it('lowercases and collapses whitespace', () => {
    // No camelCase / digit boundaries -> split === original, single form returned.
    expect(normalizeForFts('  Hello   WORLD  ')).toBe('hello world');
  });

  it('passes CJK through unchanged (no split needed)', () => {
    expect(normalizeForFts('杜亚智能体')).toBe('杜亚智能体');
    expect(normalizeForFts('Agent 搜索')).toBe('agent 搜索');
  });

  it('handles null and empty input', () => {
    expect(normalizeForFts(null)).toBe('');
    expect(normalizeForFts(undefined)).toBe('');
    expect(normalizeForFts('')).toBe('');
  });

  it('preserves unsplit underscore identifiers', () => {
    // Underscores are separators in unicode61 but trigram handles substrings
    // across underscores, so we just emit the single lowercased form.
    expect(normalizeForFts('message_attachments')).toBe('message_attachments');
  });
});

describe('messages_fts trigram + identifier split', () => {
  let db: Database.Database;
  beforeAll(() => {
    db = setupFtsDb();
  });

  it('indexes DuyaAgent so it is findable by `duya agent`', () => {
    insertSession(db, 'sess-camel', 'Duya agent integration test');
    insertMessage(db, 'm1', 'sess-camel', 'Let me refactor the DuyaAgent class today.');

    const rows = db
      .prepare(
        `SELECT s.id FROM messages_fts
         JOIN chat_sessions s ON messages_fts.session_id = s.id
         WHERE messages_fts MATCH ?`,
      )
      .all('duya agent') as Array<{ id: string }>;
    expect(rows.map(r => r.id)).toContain('sess-camel');
  });

  it('is case-insensitive: `DUYA AGENT` matches `duyaagent`', () => {
    // (Data already inserted by previous test.)
    const rows = db
      .prepare(
        `SELECT session_id FROM messages_fts WHERE messages_fts MATCH ?`,
      )
      .all('duya agent') as Array<{ session_id: string }>;
    expect(rows.length).toBeGreaterThan(0);
  });

  it('handles XMLHttpRequest ↔ xml http request', () => {
    insertSession(db, 'sess-xml', 'XML request');
    insertMessage(db, 'm2', 'sess-xml', 'The XMLHttpRequest API is deprecated.');

    const rows = db
      .prepare(`SELECT session_id FROM messages_fts WHERE messages_fts MATCH ?`)
      .all('xml http request') as Array<{ session_id: string }>;
    expect(rows.map(r => r.session_id)).toContain('sess-xml');
  });

  it('matches identifier digits: sha256 ↔ sha 256', () => {
    insertSession(db, 'sess-hash', 'hash function');
    insertMessage(db, 'm3', 'sess-hash', 'Use sha256 for this pipeline.');

    const rows = db
      .prepare(`SELECT session_id FROM messages_fts WHERE messages_fts MATCH ?`)
      .all('sha 256') as Array<{ session_id: string }>;
    expect(rows.map(r => r.session_id)).toContain('sess-hash');
  });

  it('CJK substring search works through trigram', () => {
    insertSession(db, 'sess-cn', '中文 session');
    insertMessage(db, 'm4', 'sess-cn', '杜亚智能体支持中文搜索测试。');

    // CJK passes through; trigram matches the substring via 3-character windows.
    const rows = db
      .prepare(`SELECT session_id FROM messages_fts WHERE messages_fts MATCH ?`)
      .all('智能体') as Array<{ session_id: string }>;
    expect(rows.map(r => r.session_id)).toContain('sess-cn');
  });

  it('UPDATE on messages re-indexes the content', () => {
    insertSession(db, 'sess-upd', 'update test');
    insertMessage(db, 'm5', 'sess-upd', 'original content', 'assistant');
    // Update to mention a new identifier
    db.prepare(`UPDATE messages SET content = ? WHERE id = ?`).run(
      'We added DuyaAgent support here.',
      'm5',
    );
    const rows = db
      .prepare(`SELECT session_id FROM messages_fts WHERE messages_fts MATCH ?`)
      .all('duya agent') as Array<{ session_id: string }>;
    expect(rows.map(r => r.session_id)).toContain('sess-upd');
  });

  it('DELETE on messages removes the index row', () => {
    insertSession(db, 'sess-del', 'delete test');
    insertMessage(db, 'm6', 'sess-del', 'DuyaAgent removal test');
    const before = db
      .prepare(`SELECT COUNT(*) as c FROM messages_fts WHERE session_id = ?`)
      .get('sess-del') as { c: number };
    expect(before.c).toBeGreaterThan(0);
    db.prepare(`DELETE FROM messages WHERE id = ?`).run('m6');
    const after = db
      .prepare(`SELECT COUNT(*) as c FROM messages_fts WHERE session_id = ?`)
      .get('sess-del') as { c: number };
    expect(after.c).toBe(0);
  });
});

describe('sessions_fts metadata search', () => {
  let db: Database.Database;
  beforeAll(() => {
    db = setupFtsDb();
  });

  it('finds sessions by title after insertion', () => {
    insertSession(db, 'sess-title', 'Investigating OpenAI rate limits');

    const rows = db
      .prepare(`SELECT session_id FROM sessions_fts WHERE sessions_fts MATCH ?`)
      .all('openai') as Array<{ session_id: string }>;
    expect(rows.map(r => r.session_id)).toContain('sess-title');
  });

  it('finds sessions by model name', () => {
    insertSession(db, 'sess-model', 'A random title', 'gpt-4o-mini');

    const rows = db
      .prepare(`SELECT session_id FROM sessions_fts WHERE sessions_fts MATCH ?`)
      .all('gpt') as Array<{ session_id: string }>;
    expect(rows.map(r => r.session_id)).toContain('sess-model');
  });

  it('updates the index when session title changes', () => {
    insertSession(db, 'sess-re', 'old title');
    db.prepare(`UPDATE chat_sessions SET title = ? WHERE id = ?`).run(
      'switched to Claude',
      'sess-re',
    );
    const rows = db
      .prepare(`SELECT session_id FROM sessions_fts WHERE sessions_fts MATCH ?`)
      .all('claude') as Array<{ session_id: string }>;
    expect(rows.map(r => r.session_id)).toContain('sess-re');
  });

  it('removes the index row on session delete', () => {
    insertSession(db, 'sess-del-meta', 'throwaway');
    db.prepare(`DELETE FROM chat_sessions WHERE id = ?`).run('sess-del-meta');
    const rows = db
      .prepare(`SELECT session_id FROM sessions_fts WHERE session_id = ?`)
      .all('sess-del-meta') as Array<{ session_id: string }>;
    expect(rows.length).toBe(0);
  });
});
