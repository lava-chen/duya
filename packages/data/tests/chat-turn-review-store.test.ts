import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatTurnReviewStore } from '../src/chat-turn-review-store.js';

describe('ChatTurnReviewStore', () => {
  let db: Database.Database;
  let store: ChatTurnReviewStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE chat_turn_reviews (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        files_json TEXT NOT NULL,
        patch TEXT NOT NULL,
        additions INTEGER NOT NULL,
        removals INTEGER NOT NULL,
        truncated INTEGER NOT NULL,
        binary INTEGER NOT NULL,
        captured_at INTEGER NOT NULL,
        UNIQUE(session_id, turn_id)
      )
    `);
    store = new ChatTurnReviewStore(db);
  });

  afterEach(() => db.close());

  it('reads latest, history, id, and session-turn projections from Data', () => {
    store.save({
      id: 'review-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      workingDirectory: 'C:/repo',
      files: [{ path: 'a.ts', status: 'modified', additions: 2, removals: 1 }],
      patch: 'patch one',
      additions: 2,
      removals: 1,
      truncated: false,
      binary: false,
      capturedAt: 100,
    });
    store.save({
      id: 'review-2',
      sessionId: 'session-1',
      turnId: 'turn-2',
      workingDirectory: 'C:/repo',
      files: [{ path: 'b.ts', status: 'added', additions: 4, removals: 0 }],
      patch: 'patch two',
      additions: 4,
      removals: 0,
      truncated: true,
      binary: false,
      capturedAt: 200,
    });
    store.save({
      id: 'review-other',
      sessionId: 'session-other',
      turnId: 'turn-other',
      workingDirectory: 'C:/other',
      files: [],
      patch: '',
      additions: 0,
      removals: 0,
      truncated: false,
      binary: false,
      capturedAt: 300,
    });

    expect(store.getLatestForSession('session-1')).toMatchObject({
      id: 'review-2',
      sessionId: 'session-1',
      turnId: 'turn-2',
      filesJson: '[{"path":"b.ts","status":"added","additions":4,"removals":0}]',
      truncated: 1,
      capturedAt: 200,
    });
    expect(store.listForSession('session-1', 1)).toEqual([{
      id: 'review-2',
      turnId: 'turn-2',
      filesJson: '[{"path":"b.ts","status":"added","additions":4,"removals":0}]',
      additions: 4,
      removals: 0,
      capturedAt: 200,
    }]);
    expect(store.getById('review-1')?.patch).toBe('patch one');
    expect(store.getBySessionAndTurnId('session-1', 'turn-1')?.id).toBe('review-1');
    expect(store.getById('missing')).toBeNull();
    expect(store.getLatestForSession('missing')).toBeNull();
  });
});
