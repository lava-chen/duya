/**
 * The `/init` route.
 *
 * ## What these assertions exist for
 *
 * The route is an OPTIONAL capability: a Host that cannot write into the
 * workspace answers 404 `agents_md_api_unavailable`, which is "this Host
 * cannot do that" and not "the write failed". The two are different
 * statements, and a caller has to be able to tell them apart.
 *
 * The route also takes a SESSION ID and never a path. The path in a client
 * request is a path the client chose; the session id is a name the Host
 * resolves against rows it owns.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { HostAgentsMdApiV1 } from '@duya/agent-protocol/doctor';
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

describe('the Host agents-md route', () => {
  const opened: HostSessionHttpServer[] = [];

  afterEach(async () => {
    for (const server of opened.splice(0)) await server.close();
  });

  it('refuses with a named code when the Host cannot write into a workspace', async () => {
    const { server, origin } = await startServer({});
    opened.push(server);

    const response = await fetch(`${origin}/v1/local/agents-md`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1' }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 'agents_md_api_unavailable' } });
  });

  it('rejects a request that names no session', async () => {
    const api: HostAgentsMdApiV1 = {
      async writeAgentsMd() {
        throw new Error('the capability must not be reached');
      },
    };
    const { server, origin } = await startServer({ agentsMdApi: api });
    opened.push(server);

    const response = await fetch(`${origin}/v1/local/agents-md`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: '' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: 'invalid_agents_md_request' } });
  });

  it('hands the session id to the capability and returns its answer', async () => {
    const seen: string[] = [];
    const api: HostAgentsMdApiV1 = {
      async writeAgentsMd(input) {
        seen.push(input.sessionId);
        return {
          ok: true,
          path: '/repo/AGENTS.md',
          created: true,
          upgraded: false,
          unchanged: false,
          version: 1,
        };
      },
    };
    const { server, origin } = await startServer({ agentsMdApi: api });
    opened.push(server);

    const client = new HostSessionHttpClient(origin, TOKEN);
    const result = await client.writeAgentsMd('session-7');

    expect(seen).toEqual(['session-7']);
    expect(result).toMatchObject({ ok: true, created: true, path: '/repo/AGENTS.md' });
  });

  it('reports a refusal to a client instead of throwing', async () => {
    const { server, origin } = await startServer({});
    opened.push(server);

    const client = new HostSessionHttpClient(origin, TOKEN);

    expect(await client.writeAgentsMd('session-1')).toMatchObject({
      ok: false,
      error: 'This Host cannot write into the workspace.',
    });
  });
});
