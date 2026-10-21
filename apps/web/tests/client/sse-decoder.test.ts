/**
 * SSE framing tests.
 *
 * These are the transport's byte-level contract with the BFF. The cases are the
 * ones that produce SILENT corruption rather than a visible failure: a frame
 * split between chunks, a multi-byte character split between chunks, and a
 * trailing partial frame that a lenient parser would turn into a real event.
 */

import { describe, expect, it } from 'vitest';
import { SseFrameDecoder } from '../../src/client/sse.js';
import { decodeRunFrame } from '../../src/client/envelope.js';
import { bytes, RUN_ID, SESSION_ID } from './fixtures.js';
import type { RunEventEnvelope } from '@duya/agent-protocol';

describe('SseFrameDecoder', () => {
  it('holds a frame that spans chunks until its terminator arrives', () => {
    const decoder = new SseFrameDecoder();
    const whole = 'id: 4\nevent: run\ndata: {"seq":4}\n\n';

    expect(decoder.push(bytes(whole.slice(0, 12)))).toEqual([]);
    expect(decoder.push(bytes(whole.slice(12, whole.length - 2)))).toEqual([]);
    expect(decoder.push(bytes(whole.slice(whole.length - 2)))).toEqual([
      { id: '4', event: 'run', data: '{"seq":4}' },
    ]);
  });

  it('dispatches every whole frame in a single chunk', () => {
    const decoder = new SseFrameDecoder();
    const frames = decoder.push(bytes('id: 1\nevent: run\ndata: {"a":1}\n\nid: 2\nevent: run\ndata: {"b":2}\n\n'));

    expect(frames).toEqual([
      { id: '1', event: 'run', data: '{"a":1}' },
      { id: '2', event: 'run', data: '{"b":2}' },
    ]);
  });

  it('keeps a Chinese payload intact when a chunk ends mid character', () => {
    const text = '正在读取 README.md，共 3 个文件。';
    const payload = JSON.stringify({ note: text });
    const whole = `id: 7\nevent: run\ndata: ${payload}\n\n`;
    const all = bytes(whole);

    // Find a byte offset that lands inside the first multi-byte character. The
    // frame prefix is ASCII, so the first non-ASCII byte is the one to split on.
    let splitAt = -1;
    for (let index = 0; index < all.length; index += 1) {
      if ((all[index] ?? 0) >= 0x80) {
        splitAt = index + 1;
        break;
      }
    }
    expect(splitAt).toBeGreaterThan(0);

    const decoder = new SseFrameDecoder();
    const first = decoder.push(all.slice(0, splitAt));
    const second = decoder.push(all.slice(splitAt));

    expect(first).toEqual([]);
    expect(second).toHaveLength(1);
    const frame = second[0];
    expect(frame?.event).toBe('run');
    expect(JSON.parse(frame?.data ?? '{}')).toEqual({ note: text });
    // The replacement character is what a per-chunk decode produces; it must not
    // appear anywhere in the decoded payload.
    expect(frame?.data).not.toContain('\uFFFD');
  });

  it('treats a keep-alive comment as nothing at all', () => {
    const decoder = new SseFrameDecoder();
    expect(decoder.push(bytes(': keep-alive\n\n'))).toEqual([]);
    expect(decoder.push(bytes(': keep-alive\nid: 9\nevent: run\ndata: {"seq":9}\n\n'))).toHaveLength(1);
  });

  it('accepts CRLF line endings without leaving a stray carriage return', () => {
    const decoder = new SseFrameDecoder();
    const frames = decoder.push(bytes('id: 3\r\nevent: run\r\ndata: {"seq":3}\r\n\r\n'));

    expect(frames).toEqual([{ id: '3', event: 'run', data: '{"seq":3}' }]);
  });

  it('joins multi-line data with a newline, per the SSE rules', () => {
    const decoder = new SseFrameDecoder();
    const frames = decoder.push(bytes('id: 5\nevent: run\ndata: {"a":1,\ndata: "b":2}\n\n'));

    expect(frames[0]?.data).toBe('{"a":1,\n"b":2}');
  });

  it('defaults the event name to message and reads an id with no data', () => {
    const decoder = new SseFrameDecoder();
    expect(decoder.push(bytes('data: hello\n\n'))).toEqual([{ id: null, event: 'message', data: 'hello' }]);
    expect(decoder.push(bytes('id: 12\n\n'))).toEqual([{ id: '12', event: 'message', data: '' }]);
  });

  it('discards an unterminated trailing frame instead of dispatching half of it', () => {
    const decoder = new SseFrameDecoder();
    expect(decoder.push(bytes('id: 8\nevent: run\ndata: {"seq":8'))).toEqual([]);
    decoder.end();
    // Nothing buffered survives; the next real frame still decodes cleanly.
    expect(decoder.push(bytes('id: 9\nevent: run\ndata: {"seq":9}\n\n'))).toHaveLength(1);
  });
});

describe('decodeRunFrame', () => {
  const envelope: RunEventEnvelope = {
    runId: RUN_ID,
    sessionId: SESSION_ID,
    seq: 2,
    timestamp: 1_700_000_000_000,
    traceId: 'trace-web-transport',
    payload: { type: 'assistant.status', message: 'Working' } as RunEventEnvelope['payload'],
  };

  it('admits a well formed Host envelope', () => {
    const decoded = decodeRunFrame({
      id: '2',
      event: 'run',
      data: JSON.stringify(envelope),
    });

    expect(decoded.kind).toBe('envelope');
    if (decoded.kind !== 'envelope') return;
    expect(decoded.envelope.seq).toBe(2);
    expect(decoded.envelope.runId).toBe(RUN_ID);
  });

  it('refuses an envelope whose sequence is not a positive integer', () => {
    for (const seq of [0, -1, 1.5, '2', null]) {
      const decoded = decodeRunFrame({
        id: null,
        event: 'run',
        data: JSON.stringify({ ...envelope, seq }),
      });
      expect(decoded).toEqual({ kind: 'ignored', reason: 'malformed_envelope' });
    }
  });

  it('refuses an envelope with no payload discriminant', () => {
    const decoded = decodeRunFrame({
      id: '2',
      event: 'run',
      data: JSON.stringify({ runId: RUN_ID, sessionId: SESSION_ID, seq: 2, timestamp: 1, traceId: 't' }),
    });

    expect(decoded).toEqual({ kind: 'ignored', reason: 'malformed_envelope' });
  });

  it('counts unreadable JSON and foreign event names as ignored frames', () => {
    expect(decodeRunFrame({ id: null, event: 'run', data: '{not json' }))
      .toEqual({ kind: 'ignored', reason: 'malformed_json' });
    expect(decodeRunFrame({ id: null, event: 'legacy', data: '{}' }))
      .toEqual({ kind: 'ignored', reason: 'unknown_event' });
  });

  it('surfaces the BFF stream failure frame as a host error, not as an event', () => {
    const decoded = decodeRunFrame({
      id: null,
      event: 'error',
      data: JSON.stringify({ status: 502, code: 'upstream_unavailable' }),
    });

    expect(decoded).toEqual({ kind: 'stream_error', code: 'upstream_unavailable' });
    expect(decodeRunFrame({ id: null, event: 'error', data: 'not json' }))
      .toEqual({ kind: 'stream_error', code: 'upstream_unavailable' });
  });
});
