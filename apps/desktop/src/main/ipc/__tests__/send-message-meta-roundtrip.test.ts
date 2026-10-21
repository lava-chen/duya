/**
 * Plan 489 P2.2 — SendMessage card payload round-trip (pure, no sqlite).
 *
 * SendMessageTool nests its card payload (attachment url/alt, widget,
 * cursor-agent bcId, secret-request descriptor, text images) under
 * message metadata.sendMessage. The write adapter must persist that key
 * (whitelist) and the read adapter must surface it as the flat
 * `send_message_meta` column so bot-direct cards survive reload.
 *
 * Mirrors core-db-adapters-source-pure.test.ts — imports only the
 * adapter module (no better-sqlite3) so it can't hit the EBUSY lock.
 */
import { describe, it, expect } from 'vitest';
import {
  ipcMessageToNewEvent,
  storedEventToIpcMessage,
  type MessageRow,
} from '../core-db-adapters';

const SESSION = 'bot:test:roundtrip';

function roundtrip(dto: Record<string, unknown>): MessageRow | null {
  const event = ipcMessageToNewEvent(SESSION, dto as never, null);
  const stored = {
    id: event.id,
    sessionId: event.sessionId,
    seq: 1,
    turnId: null,
    kind: 'message' as const,
    payload: JSON.stringify(event.payload),
    createdAt: event.createdAt,
  };
  return storedEventToIpcMessage(stored);
}

describe('Plan 489 P2.2 — sendMessage card payload round-trip', () => {
  it('persists and reads back an attachment card payload', () => {
    const row = roundtrip({
      id: 'att-1',
      session_id: SESSION,
      role: 'assistant',
      content: 'see attached',
      msg_type: 'attachment',
      source: 'send_message',
      metadata: {
        source: 'send_message',
        sendMessage: { url: 'https://example.com/report.pdf', alt: 'report.pdf' },
      },
      created_at: 1725500000000,
    });
    expect(row).not.toBeNull();
    expect(row!.msg_type).toBe('attachment');
    expect(row!.source).toBe('send_message');
    const meta = JSON.parse(row!.send_message_meta ?? 'null');
    expect(meta).toEqual({
      url: 'https://example.com/report.pdf',
      alt: 'report.pdf',
    });
  });

  it('persists and reads back widget / cursor-agent / secret-request payloads', () => {
    const widget = roundtrip({
      id: 'w-1',
      session_id: SESSION,
      role: 'assistant',
      content: 'pick one',
      msg_type: 'widget',
      source: 'send_message',
      metadata: {
        source: 'send_message',
        sendMessage: { widget: { prompt: 'Which night?', options: ['the 12th', 'the 14th'] } },
      },
      created_at: 1725500000001,
    });
    expect(JSON.parse(widget!.send_message_meta ?? 'null')).toEqual({
      widget: { prompt: 'Which night?', options: ['the 12th', 'the 14th'] },
    });

    const cursor = roundtrip({
      id: 'c-1',
      session_id: SESSION,
      role: 'assistant',
      content: 'run started',
      msg_type: 'cursor-agent',
      source: 'send_message',
      metadata: { source: 'send_message', sendMessage: { bcId: 'bc-123' } },
      created_at: 1725500000002,
    });
    expect(JSON.parse(cursor!.send_message_meta ?? 'null')).toEqual({ bcId: 'bc-123' });

    const secret = roundtrip({
      id: 's-1',
      session_id: SESSION,
      role: 'assistant',
      content: 'need a token',
      msg_type: 'secret-request',
      source: 'send_message',
      metadata: {
        source: 'send_message',
        sendMessage: { secret: { label: 'Slack token', connector: 'slack', field: 'bot_token' } },
      },
      created_at: 1725500000003,
    });
    expect(JSON.parse(secret!.send_message_meta ?? 'null')).toEqual({
      secret: { label: 'Slack token', connector: 'slack', field: 'bot_token' },
    });
  });

  it('persists text-kind images and plain rows without card payload', () => {
    const withImages = roundtrip({
      id: 'img-1',
      session_id: SESSION,
      role: 'assistant',
      content: 'look',
      msg_type: 'text',
      source: 'send_message',
      metadata: {
        source: 'send_message',
        sendMessage: { images: [{ url: 'file:///tmp/a.png', alt: 'a' }] },
      },
      created_at: 1725500000004,
    });
    expect(JSON.parse(withImages!.send_message_meta ?? 'null')).toEqual({
      images: [{ url: 'file:///tmp/a.png', alt: 'a' }],
    });

    const plain = roundtrip({
      id: 'p-1',
      session_id: SESSION,
      role: 'assistant',
      content: 'no card',
      msg_type: 'text',
      source: 'send_message',
      metadata: { source: 'send_message' },
      created_at: 1725500000005,
    });
    expect(plain!.send_message_meta).toBeNull();
  });
});
