/**
 * The session handoff route.
 *
 * ## What these assertions exist for
 *
 * The route is an OPTIONAL capability, and the difference between "this Host
 * cannot answer" and "the answer is empty" is the whole point: a Host
 * without a desktop app refuses `POST /v1/local/session-handoff` with 404
 * `session_handoff_unavailable`. A handoff that failed is a different
 * statement from a handoff that was never possible, and the caller has to
 * be able to tell them apart.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { HostSessionHandoffApiV1 } from '@duya/agent-protocol/session-handoff';
import { HostSessionHttpClient } from '../src/http-client.js';
import { HostSessionHttpServer, type HostSessionHttpServerOptions } from '../src/http-server.js';

const TOKEN = 'test-token';

/** A server with only the capabilities a case needs. */
async function startServer(
  overrides: Partial<HostSessionHttpServerOptions>,
): Promise<{ server: HostSessionHttpServer; origin: string }> {
  const server = new HostSessionHttpServer({
    api: {} as HostSessionHttpServerOptions['api'],
    taskApi: {} as HostSessionHttpServerOptions['taskApi'],
    token: TOKEN,
    ...overrides,
  });
  await server.listen();
  return { server, origin: `http://127.0.0.1:${server.port}` };
}

describe('the Host session handoff route', () => {
  const opened: HostSessionHttpServer[] = [];

  afterEach(async () => {
    for (const server of opened.splice(0)) await server.close();
  });

  it('refuses with a named code when the Host has no desktop app', async () => {
    const { server, origin } = await startServer({});
    opened.push(server);

    const response = await fetch(`${origin}/v1/local/session-handoff`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1' }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 'session_handoff_unavailable' } });
  });

  it('reports the refusal to a client instead of throwing', async () => {
    const { server, origin } = await startServer({});
    opened.push(server);

    const client = new HostSessionHttpClient(origin, TOKEN);

    expect(await client.openInDesktopApp('session-1')).toMatchObject({
      ok: false,
      code: 'session_handoff_unavailable',
    });
  });

  it('hands the session over when the desktop app accepts it', async () => {
    const seen: string[] = [];
    const api: HostSessionHandoffApiV1 = {
      openInDesktopApp: async (input) => {
        seen.push(input.sessionId);
        return { ok: true };
      },
    };
    const { server, origin } = await startServer({ sessionHandoffApi: api });
    opened.push(server);

    const client = new HostSessionHttpClient(origin, TOKEN);

    expect(await client.openInDesktopApp('session-1')).toEqual({ ok: true });
    expect(seen).toEqual(['session-1']);
  });

  it('reports the desktop app\'s refusal with its own code', async () => {
    const api: HostSessionHandoffApiV1 = {
      openInDesktopApp: async () => ({
        ok: false,
        code: 'desktop_app_unreachable',
        message: 'no renderer is attached',
      }),
    };
    const { server, origin } = await startServer({ sessionHandoffApi: api });
    opened.push(server);

    const client = new HostSessionHttpClient(origin, TOKEN);

    expect(await client.openInDesktopApp('session-1')).toMatchObject({
      ok: false,
      code: 'desktop_app_unreachable',
      message: 'no renderer is attached',
    });
  });

  it('refuses a request that names no session', async () => {
    const { server, origin } = await startServer({
      sessionHandoffApi: { openInDesktopApp: async () => ({ ok: true }) },
    });
    opened.push(server);

    const response = await fetch(`${origin}/v1/local/session-handoff`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: 'invalid_session_handoff_request' } });
  });
});
