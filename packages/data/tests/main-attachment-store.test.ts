import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MainAttachmentStore } from '../src/main-attachment-store.js';

describe('MainAttachmentStore image history', () => {
  let db: Database.Database;
  let store: MainAttachmentStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE message_attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        session_id TEXT NOT NULL,
        attachment_type TEXT NOT NULL,
        mime_type TEXT,
        data TEXT NOT NULL,
        original_url TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    store = new MainAttachmentStore(db);
  });

  afterEach(() => db.close());

  it('returns only legacy image rows for the session, oldest first, with payloads intact', () => {
    const insert = db.prepare(`
      INSERT INTO message_attachments
        (id, message_id, session_id, attachment_type, mime_type, data, original_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run('image-late', 'message-1', 'session-1', 'image', 'image/png', 'base64-late', 'https://x.minimax.io/late', 20);
    insert.run('doc', 'message-1', 'session-1', 'parsed_document', 'application/pdf', '{"text":"doc"}', null, 10);
    insert.run('image-early', 'message-2', 'session-1', 'image', 'image/jpeg', 'base64-early', 'https://x.minimax.io/early', 5);
    insert.run('other-session', 'message-3', 'session-2', 'image', 'image/png', 'other-bytes', 'https://x.minimax.io/other', 1);

    expect(store.getImageAttachmentsForSession('session-1')).toEqual([
      {
        id: 'image-early',
        message_id: 'message-2',
        session_id: 'session-1',
        attachment_type: 'image',
        mime_type: 'image/jpeg',
        data: 'base64-early',
        original_url: 'https://x.minimax.io/early',
        created_at: 5,
      },
      {
        id: 'image-late',
        message_id: 'message-1',
        session_id: 'session-1',
        attachment_type: 'image',
        mime_type: 'image/png',
        data: 'base64-late',
        original_url: 'https://x.minimax.io/late',
        created_at: 20,
      },
    ]);
  });
});
