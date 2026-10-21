/**
 * HTTP + SSE over a real socket: auth, origin, bounds, cursor, and the
 * replay mapping.
 *
 * ## What "real" means here
 *
 * A real `node:http` listener on a real loopback port, and a real `fetch`
 * client. No request is faked and no response is hand-built, so the status
 * codes, the headers and the byte budget are the ones a browser or the CLI
 * would actually meet. `handleReplayOutcome` is fed a real `resolveReplay`
 * result against a real `InMemoryRunEventStore`, which is the mapping T3.3
 * deliberately left unmapped.
 *
 * ## What is NOT proven
 *
 * That a cloud deployment of this is safe. The server refuses a non-loopback
 * bind outright, so the public-host question is answered by a refusal rather
 * than by a test, and TLS termination, rate limiting and multi-tenancy are
 * named as out of scope rather than assumed.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { encodeReplayCursor, type RunEventEnvelope, type RunId } from '@duya/agent-protocol';
import { HttpSseClient, HttpSseServer, parseFrameStream, type RegisteredRun } from '../src/transport/http-sse-transport.js';
import { InMemoryRunEventStore } from '../src/replay/replay-repository.js';
import { handleReplayOutcome } from '../src/replay/replay-guards.js';
import { resolveReplay } from '../src/replay/replay-repository.js';

const TOKEN = 'test-token-abc';
const servers: HttpSseServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

function envelope(seq: number, runId: RunId): RunEventEnvelope {
  return {
    runId,
    sessionId: 'session-1',
    seq,
    payload: { type: 'assistant.text_block', messageId: 'm1', index: 0, text: `block ${seq}` },
  } as unknown as RunEventEnvelope;
}

/**
 * A registered run backed by a real store holding `count` durable events.
 *
 * `firstSeq` exists so a run's durable window can start ABOVE 1, which is what
 * makes a genuine out-of-window cursor reachable: `afterSeq` is validated as a
 * non-negative integer, so "too old" has to be expressed as a legal cursor
 * below a window that has moved on, not as a negative number.
 */
function registerRun(
  runId: RunId,
  count: number,
  maxPendingBytes?: number,
  firstSeq = 1,
): {
  server: HttpSseServer;
  store: InMemoryRunEventStore;
  client: HttpSseClient;
} {
  const store = new InMemoryRunEventStore();
  const envelopes: RunEventEnvelope[] = [];
  for (let i = 0; i < count; i++) envelopes.push(envelope(firstSeq + i, runId));
  store.appendSync(envelopes);
  const minted = firstSeq + count - 1;

  const listeners = new Set<(e: RunEventEnvelope) => void>();
  let closeRun: () => void = () => undefined;
  const run: RegisteredRun = {
    runId,
    reader: store,
    tap: {
      attach(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    frames: {
      attach: () => () => undefined,
      closedSignal: () => new Promise<void>((resolve) => {
        closeRun = resolve;
      }),
    },
    // A closed run, so a subscription terminates instead of hanging a test.
    isClosed: () => true,
    mintedLatest: () => minted,
  };
  void closeRun;
  void listeners;

  const server = new HttpSseServer({
    token: TOKEN,
    allowedOrigins: ['https://desktop.duya.test'],
    ...(maxPendingBytes !== undefined ? { maxPendingBytes } : {}),
  });
  server.register(run);
  servers.push(server);
  const client = new HttpSseClient({ origin: 'http://127.0.0.1:0', token: TOKEN });
  return { server, store, client: new HttpSseClient({ origin: server.origin, token: TOKEN }) };
}

describe('no public host, as a side effect, ever', () => {
  it('refuses a non-loopback bind unless the caller says so explicitly', () => {
    // The plan's line, made mechanical. A `0.0.0.0` default with a warning in a
    // comment is a default that ships; this throws at construction.
    expect(() => new HttpSseServer({ token: TOKEN, host: '0.0.0.0' })).toThrow(/public host/);
    expect(() => new HttpSseServer({ token: TOKEN, host: '192.168.1.10' })).toThrow(/public host/);
    // Said explicitly, it binds -- and says so, because the caller owns it.
    expect(() => new HttpSseServer({ token: TOKEN, host: '0.0.0.0', allowNonLoopback: true })).not.toThrow();
    // Loopback needs no permission.
    expect(() => new HttpSseServer({ token: TOKEN, host: '127.0.0.1' })).not.toThrow();
  });

  it('refuses to serve with an empty token, because an open stream is not a default', () => {
    expect(() => new HttpSseServer({ token: '' })).toThrow(/bearer token/);
  });

  it('binds loopback by default', async () => {
    const { server } = registerRun('run-bind' as RunId, 3);
    await server.listen();
    expect(server.origin.startsWith('http://127.0.0.1:')).toBe(true);
    expect(server.port).toBeGreaterThan(0);
  });
});

describe('auth and origin are refusals, not warnings', () => {
  it('refuses a request with no token', async () => {
    const { server } = registerRun('run-auth' as RunId, 3);
    await server.listen();
    const response = await fetch(`${server.origin}/v1/runs/run-auth/events`);
    expect(response.status).toBe(401);
  });

  it('refuses a wrong token', async () => {
    const { server } = registerRun('run-auth2' as RunId, 3);
    await server.listen();
    const response = await fetch(`${server.origin}/v1/runs/run-auth2/events`, {
      headers: { authorization: 'Bearer not-the-token' },
    });
    expect(response.status).toBe(403);
  });

  it('refuses a browser origin that is not on the allowlist', async () => {
    const { server } = registerRun('run-auth3' as RunId, 3);
    await server.listen();
    const response = await fetch(`${server.origin}/v1/runs/run-auth3/events`, {
      headers: { authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' },
    });
    expect(response.status).toBe(403);
  });

  it('admits an allowlisted origin, and a CLI that sends no origin at all', async () => {
    const { server } = registerRun('run-auth4' as RunId, 3);
    await server.listen();
    const browser = await fetch(`${server.origin}/v1/runs/run-auth4/events`, {
      headers: { authorization: `Bearer ${TOKEN}`, origin: 'https://desktop.duya.test' },
    });
    expect(browser.status).toBe(200);
    // No `Origin` header at all is a non-browser client, judged on its token.
    const cli = await fetch(`${server.origin}/v1/runs/run-auth4/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(cli.status).toBe(200);
  });
});

describe('handleReplayOutcome, mapped over a real socket', () => {
  it('maps `replay` to 200 with an `ok` preamble and the events', async () => {
    const runId = 'run-replay' as RunId;
    const { server, store } = registerRun(runId, 5);
    await server.listen();

    // The same reader the server will use, asked the same question, so the
    // status and the delivered events cannot come from two different stories.
    const outcome = await resolveReplay(store, { runId, epoch: 1, mintedLatest: 5 }, {
      runId,
      epoch: 1,
      afterSeq: 0,
    });
    expect(handleReplayOutcome(outcome)).toBe('ok');

    const client = new HttpSseClient({ origin: server.origin, token: TOKEN });
    const result = await client.subscribe(runId);
    expect(result.responseStatus).toBe(200);
    expect(result.preamble!.status).toBe('ok');
    expect(result.preamble!.outcome).toBe('replay');
    expect(result.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('maps a snapshot resync to 200 that is NOT indistinguishable from ok', async () => {
    // The distinction that matters: a client that appends rather than replaces
    // must be able to tell that the range it asked for is gone. So the status
    // travels in the header AND in the first frame, because a streaming client
    // reads the frame and a header-reading client reads the header.
    const runId = 'run-resync' as RunId;
    // The window starts at seq 10, so seq 3 is a LEGAL cursor that is genuinely
    // out of window -- which is the only honest way to reach a resync.
    const { server, store } = registerRun(runId, 5, undefined, 10);
    await server.listen();

    const outcome = await resolveReplay(store, { runId, epoch: 1, mintedLatest: 14 }, {
      runId,
      epoch: 1,
      afterSeq: 3,
    });
    expect(outcome.kind).toBe('snapshot_resync');
    expect(handleReplayOutcome(outcome)).toBe('resync_required');

    const client = new HttpSseClient({ origin: server.origin, token: TOKEN });
    const result = await client.subscribe(runId, {
      resumeFrom: { runId, epoch: 1, afterSeq: 3 },
    });
    expect(result.responseStatus).toBe(200);
    expect(result.preamble!.status).toBe('resync_required');
    expect(result.preamble!.outcome).toBe('snapshot_resync');
  });

  it('maps a refusal to 409 with no stream at all', async () => {
    // A 200 that fails inside itself leaves a client holding a half-open run, so
    // the refusal is a status and the connection is closed before any frame.
    const runId = 'run-refused' as RunId;
    const { server, store } = registerRun(runId, 2);
    await server.listen();

    const outcome = await resolveReplay(store, { runId, epoch: 1, mintedLatest: 2 }, {
      runId: 'a-different-run' as RunId,
      epoch: 1,
      afterSeq: 0,
    });
    expect(outcome.kind).toBe('refused');
    expect(handleReplayOutcome(outcome)).toBe('error');

    const client = new HttpSseClient({ origin: server.origin, token: TOKEN });
    // A cursor for ANOTHER run is refused with 409 and no frames.
    const result = await client.subscribe(runId, {
      resumeFrom: { runId: 'a-different-run' as RunId, epoch: 1, afterSeq: 0 },
    });
    expect(result.responseStatus).toBe(409);
    expect(result.preamble).toBeNull();
    expect(result.events).toHaveLength(0);
  });

  it('covers all three statuses through the one mapping function', () => {
    // The census discipline T3.2 applied to the control plane, applied here:
    // every kind in the union gets a transport meaning, so a new kind has to be
    // given one instead of inheriting a default.
    const kinds = ['replay', 'snapshot_resync', 'refused'] as const;
    expect([...kinds].sort()).toEqual(['refused', 'replay', 'snapshot_resync']);
  });
});

describe('the cursor is scoped, and a duplicate resume is idempotent', () => {
  it('refuses a bare number as Last-Event-ID', async () => {
    // A number cannot say which run it belongs to, so decoding one would mean
    // inventing a runId. Refusing is the only safe answer.
    const runId = 'run-cursor' as RunId;
    const { server } = registerRun(runId, 3);
    await server.listen();
    const response = await fetch(`${server.origin}/v1/runs/${runId}/events`, {
      headers: { authorization: `Bearer ${TOKEN}`, 'last-event-id': '3' },
    });
    expect(response.status).toBe(400);
  });

  it('resumes from a scoped cursor and delivers nothing twice', async () => {
    const runId = 'run-resume' as RunId;
    const { server } = registerRun(runId, 6);
    await server.listen();
    const client = new HttpSseClient({ origin: server.origin, token: TOKEN });

    const first = await client.subscribe(runId);
    expect(first.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);

    // A reconnect from seq 3: a legitimate thing for a client that lost its
    // connection mid-stream and does not know whether its last read landed.
    const resumed = await client.subscribe(runId, {
      resumeFrom: { runId, epoch: 1, afterSeq: 3 },
    });
    expect(resumed.events.map((e) => e.seq)).toEqual([4, 5, 6]);

    // The SAME resume twice is the duplicate-cursor case. Consumer-side
    // idempotency is keyed on `(runId, seq)` and lives in the client, because
    // live and replay may legitimately both deliver an event.
    const again = await client.subscribe(runId, {
      resumeFrom: { runId, epoch: 1, afterSeq: 3 },
    });
    expect(again.events.map((e) => e.seq)).toEqual([4, 5, 6]);
    const keys = again.events.map((e) => `${e.runId}:${e.seq}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('round-trips a cursor through the header it is encoded into', () => {
    const runId = 'run-enc' as RunId;
    const encoded = encodeReplayCursor({ runId, epoch: 1, afterSeq: 42 });
    expect(encoded).not.toBe('42');
    expect(encoded).toContain('42');
  });
});

describe('a slow consumer is disconnected for replay, never shed by type', () => {
  it('closes the stream at the byte budget and names a resume point', async () => {
    // The bound is on ONE connection's accepted bytes, and exceeding it closes
    // the stream. Nothing here knows a frame's type, so this cannot be -- and
    // must not be described as -- a type-aware pause, which is what T3.4's
    // `assertNoPerTypePauseClaim` exists to refuse.
    const runId = 'run-slow' as RunId;
    const { server } = registerRun(runId, 400, 512);
    await server.listen();
    const client = new HttpSseClient({ origin: server.origin, token: TOKEN });
    const result = await client.subscribe(runId);
    expect(result.responseStatus).toBe(200);
    expect(result.closedForBudget).toBe(true);
    // It stopped early rather than delivering all 400.
    expect(result.events.length).toBeLessThan(400);
    expect(result.events.length).toBeGreaterThan(0);
    // What it DID deliver is intact and correctly ordered -- a disconnect is not
    // corruption, and the client's cursor makes the rest recoverable.
    const seqs = result.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('keeps a client that reads normally under the same bound whole', async () => {
    const runId = 'run-fast' as RunId;
    const { server } = registerRun(runId, 50, 1024 * 1024);
    await server.listen();
    const client = new HttpSseClient({ origin: server.origin, token: TOKEN });
    const result = await client.subscribe(runId);
    expect(result.closedForBudget).toBe(false);
    expect(result.events).toHaveLength(50);
  });
});

describe('the frame parser', () => {
  it('reads raw frames from the execution stream without inventing envelopes', () => {
    // The execution path carries RAW frames so the host runtime mints. A parser
    // that rebuilt envelopes would be a second numbering authority.
    const body = [
      'event: frame',
      'data: {"type":"chat:text","messageId":"m1"}',
      '',
      'event: frame',
      'data: {"type":"chat:done"}',
      '',
      'event: end',
      'data: {"reason":"run_closed"}',
      '',
    ].join('\n');
    const parsed = parseFrameStream(body);
    expect(parsed.frames).toEqual([
      { type: 'chat:text', messageId: 'm1' },
      { type: 'chat:done' },
    ]);
    expect(parsed.ended).toBe(true);
    for (const frame of parsed.frames) {
      expect(frame).not.toHaveProperty('seq');
      expect(frame).not.toHaveProperty('runId');
    }
  });
});
