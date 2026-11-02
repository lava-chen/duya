import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { HostSessionInputApiV1 } from '@duya/agent-protocol';
import { routeSessionInputs } from '../src/session-input-routes.js';

interface Captured {
  status: number;
  body: unknown;
}

async function call(
  target: string,
  api: HostSessionInputApiV1 | undefined,
  method = 'GET',
  body?: Record<string, unknown>,
): Promise<Captured> {
  let captured: Captured = { status: 0, body: null };
  await routeSessionInputs(
    { method } as IncomingMessage,
    new URL(`http://127.0.0.1${target}`),
    {} as ServerResponse,
    api,
    {
      readJson: async () => body ?? null,
      sendJson: (_response, status, responseBody) => { captured = { status, body: responseBody }; },
    },
  );
  return captured;
}

function api(overrides: Partial<HostSessionInputApiV1> = {}): HostSessionInputApiV1 {
  return {
    submitInput: async (request) => ({
      inputId: 'input-1',
      requestId: request.requestId,
      sessionId: request.sessionId,
      actor: { kind: 'user', id: 'local' },
      stage: 'delivered',
    }),
    readInputReceipt: async () => null,
    acquireControlLease: async () => null,
    releaseControlLease: async () => false,
    readControlLease: async () => null,
    ...overrides,
  };
}

describe('session input routes', () => {
  it('fails closed when the Host does not offer the surface', async () => {
    expect(await call('/v1/session-inputs', undefined, 'POST', {})).toEqual({
      status: 503,
      body: { error: { code: 'session_input_api_unavailable' } },
    });
  });

  it('refuses a submit that does not name a session, a request id and an intent', async () => {
    const apiImpl = api();
    expect((await call('/v1/session-inputs', apiImpl, 'POST', { sessionId: '', requestId: 'r1', intent: 'enqueue', content: 'x' })).status).toBe(400);
    expect((await call('/v1/session-inputs', apiImpl, 'POST', { sessionId: 's1', requestId: 'r1', intent: 'nope', content: 'x' })).status).toBe(400);
    expect((await call('/v1/session-inputs', apiImpl, 'POST', { sessionId: 's1', requestId: 'r1', intent: 'enqueue', content: 'x', actor: { kind: 'user' } })).status).toBe(400);
  });

  it('never lets a request carry an actor', async () => {
    // The identity is the Host's to derive. A body that names one is a
    // request the Host refuses to read, not one it silently ignores.
    const apiImpl = api();
    const captured = await call('/v1/session-inputs', apiImpl, 'POST', {
      sessionId: 's1',
      requestId: 'r1',
      intent: 'enqueue',
      content: 'x',
      actor: { kind: 'user', id: 'someone-else' },
    });
    expect(captured.status).toBe(400);
  });

  it('submits an input and returns its receipt', async () => {
    const captured = await call('/v1/session-inputs', api(), 'POST', {
      sessionId: 's1',
      requestId: 'r1',
      intent: 'enqueue',
      content: 'do the thing',
    });
    expect(captured.status).toBe(200);
    expect((captured.body as { receipt: { requestId: string } }).receipt.requestId).toBe('r1');
  });

  it('answers 404 for a receipt nobody has', async () => {
    expect(await call('/v1/session-inputs/receipt?sessionId=s1&requestId=r1', api())).toEqual({
      status: 404,
      body: { error: { code: 'session_input_not_found' } },
    });
  });

  it('reports a refused grant as an ordinary answer, not an error', async () => {
    // Somebody else holds the session: the caller asked for it and was told
    // no. That is a result, not a failure of the request.
    const captured = await call('/v1/session-inputs/lease', api(), 'POST', {
      sessionId: 's1',
      requestId: 'lease-1',
    });
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ lease: null });
  });

  it('refuses a lease request that names no session', async () => {
    expect((await call('/v1/session-inputs/lease', api(), 'POST', { requestId: 'lease-1' })).status).toBe(400);
    expect((await call('/v1/session-inputs/lease', api(), 'POST', {
      sessionId: 's1', requestId: 'lease-1', expectedRevision: 0,
    })).status).toBe(400);
  });

  it('releases a lease only for the revision it names', async () => {
    const captured = await call('/v1/session-inputs/lease/release', api({
      releaseControlLease: async (sessionId, revision) => sessionId === 's1' && revision === 3,
    }), 'POST', { sessionId: 's1', revision: 3 });
    expect(captured).toEqual({ status: 200, body: { released: true } });
  });

  it('answers 404 for a path it does not serve', async () => {
    expect((await call('/v1/session-inputs/unknown', api())).status).toBe(404);
  });
});
