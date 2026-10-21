import { describe, expect, it } from 'vitest';
import {
  decodeRunFrame,
  readRunEventEnvelope,
  SseFrameDecoder,
} from '../src/index.js';
import type { RunEventEnvelope } from '@duya/agent-protocol';

const encoder = new TextEncoder();

function makeEnvelope(overrides: Record<string, unknown> = {}): RunEventEnvelope {
  return {
    runId: 'run-decoder',
    sessionId: 'session-decoder',
    seq: 1,
    timestamp: 1_700_000_000_000,
    traceId: 'trace-decoder',
    payload: { type: 'assistant.status', message: 'ready' },
    ...overrides,
  } as RunEventEnvelope;
}

describe('shared run stream decoding', () => {
  it('preserves a multi-byte UTF-8 character split at every byte boundary', () => {
    const decoder = new SseFrameDecoder();
    const encoded = encoder.encode('event: run\ndata: {"text":"你好🌱"}\n\n');
    const frames: { readonly id: string | null; readonly event: string; readonly data: string }[] = [];
    for (const byte of encoded) frames.push(...decoder.push(Uint8Array.of(byte)));

    expect(frames).toEqual([{ id: null, event: 'run', data: '{"text":"你好🌱"}' }]);
  });

  it('discards an unterminated final frame and accepts the next complete frame', () => {
    const decoder = new SseFrameDecoder();
    expect(decoder.push(encoder.encode('event: run\ndata: {"seq":1}'))).toEqual([]);
    decoder.end();
    expect(decoder.push(encoder.encode('event: run\ndata: {"seq":2}\n\n'))).toEqual([
      { id: null, event: 'run', data: '{"seq":2}' },
    ]);
  });

  it('rejects empty or malformed envelope identities before the surface sees them', () => {
    for (const invalid of [
      makeEnvelope({ runId: '' }),
      makeEnvelope({ sessionId: '' }),
      makeEnvelope({ traceId: 4 }),
      makeEnvelope({ timestamp: Number.NaN }),
    ]) {
      expect(readRunEventEnvelope(invalid)).toBeNull();
    }

    expect(decodeRunFrame({ id: '1', event: 'run', data: JSON.stringify(makeEnvelope({ runId: '' })) }))
      .toEqual({ kind: 'ignored', reason: 'malformed_envelope' });
  });

  it('normalizes malformed stream error identities to the generic upstream code', () => {
    expect(decodeRunFrame({
      id: null,
      event: 'error',
      data: JSON.stringify({ status: 502, code: 'run/other-session' }),
    })).toEqual({ kind: 'stream_error', code: 'upstream_unavailable' });
  });
});
