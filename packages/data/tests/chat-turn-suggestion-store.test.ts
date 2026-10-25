import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatTurnSuggestionStore } from '../src/chat-turn-suggestion-store.js';

describe('ChatTurnSuggestionStore', () => {
  let db: Database.Database;
  let store: ChatTurnSuggestionStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE chat_turn_suggestions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        suggestion TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(session_id, turn_id)
      )
    `);
    store = new ChatTurnSuggestionStore(db);
  });

  afterEach(() => db.close());

  it('reads the newest suggestion of a session', () => {
    store.save({
      id: 'suggestion-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      suggestion: '跑一下测试',
      createdAt: 100,
    });
    store.save({
      id: 'suggestion-2',
      sessionId: 'session-1',
      turnId: 'turn-2',
      suggestion: '补个文档',
      createdAt: 200,
    });
    store.save({
      id: 'suggestion-other',
      sessionId: 'session-other',
      turnId: 'turn-other',
      suggestion: '别的会话',
      createdAt: 300,
    });

    expect(store.getLatestForSession('session-1')).toMatchObject({
      id: 'suggestion-2',
      sessionId: 'session-1',
      turnId: 'turn-2',
      suggestion: '补个文档',
      createdAt: 200,
    });
    expect(store.getBySessionAndTurnId('session-1', 'turn-1')?.suggestion).toBe('跑一下测试');
    expect(store.getLatestForSession('missing')).toBeNull();
    expect(store.getBySessionAndTurnId('session-1', 'missing')).toBeNull();
  });

  it('replaces the suggestion of the same turn instead of adding a row', () => {
    store.save({
      id: 'suggestion-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      suggestion: '第一条',
      createdAt: 100,
    });
    store.save({
      id: 'suggestion-1b',
      sessionId: 'session-1',
      turnId: 'turn-1',
      suggestion: '改写后的',
      createdAt: 150,
    });

    const row = db
      .prepare('SELECT COUNT(*) AS count FROM chat_turn_suggestions WHERE session_id = ?')
      .get('session-1') as { count: number };
    expect(row.count).toBe(1);
    expect(store.getLatestForSession('session-1')?.suggestion).toBe('改写后的');
  });
});
