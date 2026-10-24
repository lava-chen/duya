/**
 * The session-level exits over HTTP.
 *
 * ## What is under test
 *
 * The ROUTE, not the executor. Two things can go wrong at this boundary and
 * they are not the same failure:
 *
 * 1. A refusal must arrive as a JSON body with the right status and code.
 *    A refusal that arrives as a 200 SSE stream (or as a stream that opens
 *    and then carries the refusal) is a bug: the client committed to reading
 *    a stream before it learned there would not be one.
 * 2. A success must arrive as a stream whose frames are the ones the
 *    contract names.
 *
 * So the capability under test is a FAKE: it reserves, refuses, or streams on
 * demand. The executor's own behaviour is covered by `session-compaction.test.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type {
  HostSessionApiV1,
  HostSessionCompactionApiV1,
  HostSessionSideQuestionApiV1,
  SessionCompactEvent,
  SessionCompactInput,
  SessionCompactReservation,
} from '@duya/agent-protocol';
import { HostSessionHttpClient } from '../src/http-client.js';
import { HostSessionHttpServer, type HostSessionHttpServerOptions } from '../src/http-server.js';
import { HostSessionCompactionError } from '../src/session-compaction.js';

const TOKEN = 'test-token';

let server: HostSessionHttpServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

/** A session API whose `get` answers for exactly the listed sessions. */
function sessionApi(known: readonly string[]): HostSessionApiV1 {
  return {
    async get(sessionId: string) {
      return known.includes(sessionId) ? ({ id: sessionId } as never) : null;
    },
  } as unknown as HostSessionApiV1;
}

/** A compaction capability whose reservation is scripted by the test. */
function compactionApi(
  reserve: (input: SessionCompactInput) => SessionCompactReservation,
): HostSessionCompactionApiV1 {
  return { reserve };
}

function events(...frames: SessionCompactEvent[]): AsyncIterable<SessionCompactEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const frame of frames) yield frame;
    },
  };
}

async function startServer(
  options: Partial<HostSessionHttpServerOptions> & { api?: HostSessionApiV1 },
): Promise<{ origin: string; client: HostSessionHttpClient }> {
  server = new HostSessionHttpServer({
    api: options.api ?? sessionApi(['session-1']),
    taskApi: {} as HostSessionHttpServerOptions['taskApi'],
    token: TOKEN,
    ...options,
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.port}`;
  return { origin, client: new HostSessionHttpClient(origin, TOKEN) };
}

describe('POST /v1/sessions/{id}/compact', () => {
  it('answers 404 agent_compaction_unavailable when the capability is not injected', async () => {
    const { origin } = await startServer({});
    const response = await fetch(`${origin}/v1/sessions/session-1/compact`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'agent_compaction_unavailable' } });
  });

  it('answers 404 session_not_found for a session the Host does not know', async () => {
    const { origin } = await startServer({
      api: sessionApi([]),
      sessionCompactionApi: compactionApi(() => ({ ok: true, events: events() })),
    });
    const response = await fetch(`${origin}/v1/sessions/session-1/compact`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'session_not_found' } });
  });

  it('answers 409 session_busy as JSON, not as a stream', async () => {
    const { origin } = await startServer({
      sessionCompactionApi: compactionApi(() => ({
        ok: false,
        status: 409,
        code: 'session_busy',
        message: 'The session has an unsettled run.',
      })),
    });
    const response = await fetch(`${origin}/v1/sessions/session-1/compact`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(409);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'session_busy' } });
  });

  it('answers 409 compact_in_flight as JSON', async () => {
    const { origin } = await startServer({
      sessionCompactionApi: compactionApi(() => ({
        ok: false,
        status: 409,
        code: 'compact_in_flight',
        message: 'A compaction is already running for this session.',
      })),
    });
    const response = await fetch(`${origin}/v1/sessions/session-1/compact`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'compact_in_flight' } });
  });

  it('streams the compaction frames in order', async () => {
    const { origin } = await startServer({
      sessionCompactionApi: compactionApi(() => ({
        ok: true,
        events: events(
          { event: 'compact:started', data: { sessionId: 'session-1' } },
          { event: 'compact:keepalive', data: { at: 1 } },
          {
            event: 'compact:completed',
            data: {
              status: 'ok',
              strategy: 'summary',
              tokensRemoved: 900,
              tokensRetained: 100,
              removedCount: 12,
              messageCount: 3,
            },
          },
        ),
      })),
    });
    const response = await fetch(`${origin}/v1/sessions/session-1/compact`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const body = await response.text();
    expect(body).toContain('event: compact:started');
    expect(body).toContain('event: compact:keepalive');
    expect(body).toContain('event: compact:completed');
    expect(body.indexOf('compact:started')).toBeLessThan(body.indexOf('compact:completed'));
  });

  it('rejects a non-string instructions field', async () => {
    const { origin } = await startServer({
      sessionCompactionApi: compactionApi(() => ({ ok: true, events: events() })),
    });
    const response = await fetch(`${origin}/v1/sessions/session-1/compact`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ instructions: 7 }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_compact_request' } });
  });

  it('accepts an empty body', async () => {
    const { origin } = await startServer({
      sessionCompactionApi: compactionApi(() => ({ ok: true, events: events() })),
    });
    const response = await fetch(`${origin}/v1/sessions/session-1/compact`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
  });
});

describe('POST /v1/sessions/{id}/btw', () => {
  it('answers 404 agent_side_question_unavailable when the capability is not injected', async () => {
    const { origin } = await startServer({});
    const response = await fetch(`${origin}/v1/sessions/session-1/btw`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'why?' }),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'agent_side_question_unavailable' },
    });
  });

  it('answers the question with the worker answer', async () => {
    const { origin } = await startServer({
      sideQuestionApi: {
        async ask(input) {
          expect(input).toEqual({ sessionId: 'session-1', question: 'why?' });
          return { answer: 'because' };
        },
      } as HostSessionSideQuestionApiV1,
    });
    const response = await fetch(`${origin}/v1/sessions/session-1/btw`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'why?' }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ answer: 'because' });
  });

  it('rejects an empty question', async () => {
    const { origin } = await startServer({
      sideQuestionApi: { async ask() { return { answer: '' }; } } as HostSessionSideQuestionApiV1,
    });
    const response = await fetch(`${origin}/v1/sessions/session-1/btw`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ question: '   ' }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_side_question_request' },
    });
  });

  it('answers 404 session_not_found for a session the Host does not know', async () => {
    const { origin } = await startServer({
      api: sessionApi([]),
      sideQuestionApi: { async ask() { return { answer: '' }; } } as HostSessionSideQuestionApiV1,
    });
    const response = await fetch(`${origin}/v1/sessions/session-1/btw`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'why?' }),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'session_not_found' } });
  });
});

describe('the route matchers', () => {
  it('does not let the generic session matcher swallow the exit paths', async () => {
    const { origin } = await startServer({
      sessionCompactionApi: compactionApi(() => ({
        ok: false,
        status: 409,
        code: 'compact_in_flight',
        message: 'busy',
      })),
    });
    // The generic session matcher answers GET /v1/sessions/{id}; the exit
    // paths are POSTs under the same prefix. A matcher registered first would
    // make these 404 as "unknown session" instead of reaching their handler.
    const response = await fetch(`${origin}/v1/sessions/session-1/compact`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(409);
  });
});

describe('the Host client methods', () => {
  it('parses the compaction frames into event and data pairs', async () => {
    const { client } = await startServer({
      sessionCompactionApi: compactionApi(() => ({
        ok: true,
        events: events(
          { event: 'compact:started', data: { sessionId: 'session-1' } },
          { event: 'compact:keepalive', data: { at: 1 } },
          {
            event: 'compact:completed',
            data: {
              status: 'ok',
              strategy: 'summary',
              tokensRemoved: 900,
              tokensRetained: 100,
              removedCount: 12,
              messageCount: 3,
            },
          },
        ),
      })),
    });
    const frames: Array<{ event: string; data: unknown }> = [];
    for await (const frame of client.compactSession('session-1')) {
      frames.push(frame);
    }
    expect(frames.map((frame) => frame.event)).toEqual([
      'compact:started',
      'compact:keepalive',
      'compact:completed',
    ]);
    expect(frames[2]?.data).toMatchObject({ status: 'ok', removedCount: 12, messageCount: 3 });
  });

  it('forwards the instructions to the compaction request', async () => {
    const seen: SessionCompactInput[] = [];
    const { client } = await startServer({
      sessionCompactionApi: compactionApi((input) => {
        seen.push(input);
        return { ok: true, events: events() };
      }),
    });
    for await (const _frame of client.compactSession('session-1', { instructions: 'keep the plan' })) {
      void _frame;
    }
    expect(seen).toEqual([{ sessionId: 'session-1', instructions: 'keep the plan' }]);
  });

  it('turns a compaction refusal into a typed client error', async () => {
    const { client } = await startServer({
      sessionCompactionApi: compactionApi(() => ({
        ok: false,
        status: 409,
        code: 'session_busy',
        message: 'busy',
      })),
    });
    const iterate = async (): Promise<void> => {
      for await (const _frame of client.compactSession('session-1')) void _frame;
    };
    await expect(iterate()).rejects.toMatchObject({ status: 409, code: 'session_busy' });
  });

  it('reads the side question answer', async () => {
    const { client } = await startServer({
      sideQuestionApi: { async ask() { return { answer: 'because' }; } } as HostSessionSideQuestionApiV1,
    });
    await expect(client.askSideQuestion('session-1', 'why?')).resolves.toEqual({ answer: 'because' });
  });

  it('turns a side question refusal into a typed client error', async () => {
    const { client } = await startServer({
      sideQuestionApi: {
        async ask() {
          throw new HostSessionCompactionError(409, 'no_live_worker', 'No live worker for this session.');
        },
      } as unknown as HostSessionSideQuestionApiV1,
    });
    await expect(client.askSideQuestion('session-1', 'why?')).rejects.toMatchObject({
      status: 409,
      code: 'no_live_worker',
    });
  });
});
