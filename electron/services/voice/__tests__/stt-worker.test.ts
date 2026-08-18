/**
 * stt-worker.test.ts — fork-IPC round-trip over the real worker subprocess.
 *
 * Plan 427 regression: the previous stdin JSON-lines transport silently
 * dropped PCM (ArrayBuffer serializes to `{}`), so the engine always saw
 * empty audio. This test forks the built worker entry exactly like
 * production, pushes 1.5 s of PCM through the IPC channel, and asserts the
 * cloud engine actually received it — the interim request fires (and fails
 * against an unreachable endpoint with code `network`). If serialization
 * regressed, the chunk would vanish and NO error would ever arrive.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const mocks = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../logging/logger', () => ({
  initLogger: vi.fn(),
  getLogger: () => mocks.logger,
  LogComponent: new Proxy({}, { get: (_t, p) => String(p) }),
}));

import { SttWorker } from '../stt-worker';

// Placeholder credential fixture for the unreachable endpoint — never a secret.
const apiKey = ['placeholder', 'voice', 'fixture'].join(':');

describe('SttWorker fork-IPC transport', () => {
  let worker: SttWorker;
  let errors: Array<{ message: string; code?: string }> = [];
  let interims: string[] = [];

  beforeAll(async () => {
    worker = new SttWorker({
      onInterim: (text) => interims.push(text),
      onFinal: () => undefined,
      onError: (message, code) => errors.push({ message, code }),
    });
    await worker.spawn();
  });

  afterAll(() => {
    worker.dispose();
  });

  it('initializes the cloud engine', async () => {
    const ready = await worker.init({
      kind: 'cloud',
      // Port 9 (discard) — connection refused immediately.
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey,
      model: 'whisper-1',
    });
    expect(ready).toBe(true);
  });

  it('delivers Int16Array PCM across the IPC channel (1.5 s triggers interim)', async () => {
    errors = [];
    // 1.5 s of loud PCM — crosses the 1 s interim minimum, so the engine
    // issues a transcription request. Only possible if samples arrived.
    worker.push(new Int16Array(24000).fill(12000));
    const deadline = Date.now() + 15_000;
    while (errors.length === 0 && interims.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // The request MUST fail (unreachable endpoint) — proving the audio
    // crossed the transport. A serialization regression yields no events.
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].code).toBe('network');
  }, 20_000);

  it('finalizes empty without events and disposes cleanly', async () => {
    const finals: string[] = [];
    const w2 = new SttWorker({
      onInterim: () => undefined,
      onFinal: (t) => finals.push(t),
      onError: (m) => {
        throw new Error(`unexpected error: ${m}`);
      },
    });
    await w2.spawn();
    const ready = await w2.init({
      kind: 'cloud',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey,
    });
    expect(ready).toBe(true);
    w2.finalize(); // empty buffer → immediate final with empty text
    const deadline = Date.now() + 10_000;
    while (finals.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(finals).toEqual(['']);
    w2.dispose();
  }, 15_000);
});
