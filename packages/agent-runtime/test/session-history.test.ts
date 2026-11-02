/**
 * The session history restore, at the Runtime's new home.
 *
 * These cases used to live in `packages/host/tests/worker-session-history.test.ts`.
 * They moved with the implementation, and they are the same cases: a
 * migration that also changed the behaviour would make a failure impossible
 * to attribute to either the move or the change.
 */

import { describe, expect, it, vi } from 'vitest';
import { hydrateSessionHistory } from '../src/session/index.js';

interface Row {
  readonly id: string;
}

interface ParsedDocument {
  readonly message_id: string;
  readonly filename: string;
}

interface Message {
  readonly id: string;
  readonly body: string;
}

describe('hydrateSessionHistory', () => {
  it('groups parsed documents and persists a repair without synthetic checkpoint rows', async () => {
    const replace = vi.fn(async (_sessionId: string, _messages: readonly Message[], _generation: number) => ({
      success: true,
    }));
    const rows = [{ id: 'message-1' }, { id: 'rebase:checkpoint' }];
    const result = await hydrateSessionHistory('session-1', {
      load: async () => ({
        messages: rows,
        parsedDocuments: [
          { message_id: 'message-1', filename: 'notes.txt' },
          { message_id: 'message-1', filename: 'table.csv' },
        ],
      }),
      loadAttachments: () => new Map([['message-1', [{ data: 'image-data' }]]]),
      toMessage: (row, attachments, parsedDocuments) => ({
        id: row.id,
        body: JSON.stringify({
          attachments: attachments?.get(row.id),
          parsedDocuments: parsedDocuments?.get(row.id),
        }),
      }),
      validate: (messages) => [...messages],
      messageId: (message) => message.id,
      replace,
      checkpointIdSuffix: ':checkpoint',
    });

    expect(result.rowCount).toBe(2);
    expect(result.messages).toHaveLength(2);
    expect(result.repairAttempted).toBe(true);
    expect(replace).toHaveBeenCalledWith('session-1', [
      expect.objectContaining({ id: 'message-1' }),
    ], 0);
    expect(result.messages[0]?.body).toContain('notes.txt');
    expect(result.messages[0]?.body).toContain('table.csv');
    expect(result.messages[0]?.body).toContain('image-data');
  });

  it('keeps history when the optional attachment read fails and avoids replacing unchanged messages', async () => {
    const replace = vi.fn();
    const message: Message = { id: 'message-1', body: 'text' };
    const result = await hydrateSessionHistory('session-1', {
      load: async () => ({ messages: [{ id: 'message-1' }] }),
      loadAttachments: () => { throw new Error('attachment store unavailable'); },
      toMessage: () => message,
      validate: (messages) => messages,
      messageId: (item) => item.id,
      replace,
      checkpointIdSuffix: ':checkpoint',
    });

    expect(result.messages).toEqual([message]);
    expect(result.repairAttempted).toBe(false);
    expect(replace).not.toHaveBeenCalled();
  });

  it('returns an empty history without loading attachments', async () => {
    const loadAttachments = vi.fn();
    const result = await hydrateSessionHistory('session-1', {
      load: async () => ({ messages: [] }),
      loadAttachments,
      toMessage: () => ({ id: 'unused', body: '' }),
      validate: (messages) => messages,
      messageId: (message) => message.id,
      replace: async () => ({ success: true }),
      checkpointIdSuffix: ':checkpoint',
    });

    expect(result).toEqual({ rowCount: 0, messages: [], repairAttempted: false });
    expect(loadAttachments).not.toHaveBeenCalled();
  });

  it('reports the repair result instead of swallowing it', async () => {
    // A history that was rewritten is a different fact from one that was only
    // read, and the caller is the one that has to know which happened.
    const result = await hydrateSessionHistory('session-1', {
      load: async () => ({ messages: [{ id: 'message-1' }] }),
      loadAttachments: () => new Map(),
      toMessage: (row) => ({ id: row.id, body: 'text' }),
      validate: (messages) => [...messages],
      messageId: (message) => message.id,
      replace: async () => ({ success: false, reason: 'read-only store' }),
      checkpointIdSuffix: ':checkpoint',
    });

    expect(result.repairAttempted).toBe(true);
    expect(result.repairResult).toEqual({ success: false, reason: 'read-only store' });
  });
});
