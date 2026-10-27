import { afterEach, describe, expect, it } from 'vitest';

import { WebhookServer, type WebhookRequest, type WebhookResponse } from './webhook-server.js';

const servers: WebhookServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function start(options: {
  onRequest?: (req: WebhookRequest) => Promise<WebhookResponse>;
  maxBodyBytes?: number;
} = {}): Promise<{ server: WebhookServer; base: string; requests: WebhookRequest[] }> {
  const requests: WebhookRequest[] = [];
  const server = new WebhookServer({
    port: 0,
    paths: ['/hook'],
    ...(options.maxBodyBytes ? { maxBodyBytes: options.maxBodyBytes } : {}),
    onRequest: async (req) => {
      requests.push(req);
      return options.onRequest ? options.onRequest(req) : { status: 200, body: '{"ok":true}' };
    },
  });
  await server.listen();
  servers.push(server);
  return { server, base: `http://127.0.0.1:${server.port}`, requests };
}

describe('WebhookServer', () => {
  it('binds an ephemeral port and reports it', async () => {
    const { server } = await start();
    expect(server.isListening).toBe(true);
    expect(server.port).toBeGreaterThan(0);
  });

  it('answers the health probe without calling onRequest', async () => {
    const { base, requests } = await start();
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(requests).toHaveLength(0);
  });

  it('404s an unregistered path', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/nope`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(404);
  });

  it('passes raw bytes, query and headers to the handler', async () => {
    const { base, requests } = await start();
    const body = JSON.stringify({ hello: 'world' });
    const response = await fetch(`${base}/hook?x=1`, {
      method: 'POST',
      headers: { 'x-custom': 'v', 'content-type': 'application/json' },
      body,
    });

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe('/hook');
    expect(requests[0].query.get('x')).toBe('1');
    expect(requests[0].headers['x-custom']).toBe('v');
    // The handler must see exactly the bytes that were signed, not a re-encode.
    expect(requests[0].rawBody.equals(Buffer.from(body))).toBe(true);
  });

  it('rejects an oversized body with 413 before buffering it', async () => {
    const { base } = await start({ maxBodyBytes: 1024 });
    const response = await fetch(`${base}/hook`, {
      method: 'POST',
      body: 'x'.repeat(4096),
    });
    expect(response.status).toBe(413);
  });

  it('surfaces a handler exception as 500 instead of hanging the socket', async () => {
    const { base } = await start({
      onRequest: async () => {
        throw new Error('boom');
      },
    });
    const response = await fetch(`${base}/hook`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(500);
  });

  it('returns handler-authored status and content type', async () => {
    const { base } = await start({
      onRequest: async () => ({ status: 202, body: 'challenge', contentType: 'text/plain' }),
    });
    const response = await fetch(`${base}/hook`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(202);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toBe('challenge');
  });

  it('close() stops listening and is idempotent', async () => {
    const { server } = await start();
    await server.close();
    expect(server.isListening).toBe(false);
    await server.close();
  });
});
