/**
 * webhook-server.test.ts — request authentication for the Feishu webhook
 * receiver (ISS-17).
 *
 * These drive a real http.Server on an ephemeral port and assert on the
 * wire, because the defect being pinned here was precisely a control that
 * looked present in the code but did not reject anything.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';

import { FeishuWebhookServer } from './webhook-server.js';

const PATH = '/feishu/webhook';
const TOKEN = 'tok-correct-horse';
const ENCRYPT_KEY = 'enc-key-value';

interface Harness {
  server: FeishuWebhookServer;
  base: string;
  received: unknown[];
  logs: string[];
}

let harness: Harness | null = null;

async function start(
  opts: { verificationToken?: string; encryptKey?: string; path?: string } = {},
): Promise<Harness> {
  const received: unknown[] = [];
  const logs: string[] = [];
  const server = new FeishuWebhookServer({
    port: 0,
    host: '127.0.0.1',
    path: opts.path ?? PATH,
    verificationToken: opts.verificationToken,
    encryptKey: opts.encryptKey,
    onEvent: async (event) => {
      received.push(event);
    },
    onLog: (message) => logs.push(message),
  });
  await server.start();
  // The listen port is only known after start(); read it back off the server.
  const address = (server as unknown as { _server: http.Server })._server?.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const h: Harness = { server, base: `http://127.0.0.1:${port}`, received, logs };
  harness = h;
  return h;
}

interface PostResult {
  status: number;
  body: string;
}

function post(
  h: Harness,
  opts: { path?: string; headers?: Record<string, string>; body?: unknown; raw?: string } = {},
): Promise<PostResult> {
  const body = opts.raw ?? JSON.stringify(opts.body ?? { type: 'event_callback' });
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${h.base}${opts.path ?? PATH}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(opts.headers ?? {}) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** Build the headers a genuine signed Feishu request would carry. */
function signed(h: { body: string }, nonce: string, tsSeconds: number, key = ENCRYPT_KEY) {
  const timestamp = String(tsSeconds);
  const signature = crypto
    .createHash('sha256')
    .update(`${timestamp}\n${nonce}\n${key}\n${h.body}`)
    .digest('hex');
  return {
    'X-Lark-Request-Timestamp': timestamp,
    'X-Lark-Request-Nonce': nonce,
    'X-Lark-Signature': signature,
    'X-Lark-Request-Token': TOKEN,
  };
}

beforeEach(() => {
  harness = null;
});

afterEach(async () => {
  await harness?.server.stop();
  harness = null;
});

describe('mandatory token check (ISS-17)', () => {
  // The original guard was `if (headerToken && headerToken !== token)`,
  // which meant an omitted header passed. These are the regression cases.
  it('rejects a request with NO token header', async () => {
    const h = await start({ verificationToken: TOKEN });
    const res = await post(h, { body: { type: 'event_callback' } });
    expect(res.status).toBe(401);
    expect(h.received).toHaveLength(0);
  });

  it('rejects a request with a wrong token', async () => {
    const h = await start({ verificationToken: TOKEN });
    const res = await post(h, { headers: { 'X-Lark-Request-Token': 'wrong' } });
    expect(res.status).toBe(401);
    expect(h.received).toHaveLength(0);
  });

  it('rejects a token that merely shares a prefix', async () => {
    const h = await start({ verificationToken: TOKEN });
    const res = await post(h, { headers: { 'X-Lark-Request-Token': TOKEN.slice(0, 4) } });
    expect(res.status).toBe(401);
  });

  it('accepts a request with the correct token', async () => {
    const h = await start({ verificationToken: TOKEN });
    const res = await post(h, {
      headers: { 'X-Lark-Request-Token': TOKEN },
      body: { type: 'event_callback', event: { message_id: 'm1' } },
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.received).toHaveLength(1);
  });
});

describe('fail closed without a configured token', () => {
  it('refuses every request when verificationToken is absent', async () => {
    const h = await start({});
    const res = await post(h, { body: { type: 'event_callback' } });
    expect(res.status).toBe(503);
    expect(h.received).toHaveLength(0);
  });

  it('refuses even a request that presents some token', async () => {
    const h = await start({});
    const res = await post(h, { headers: { 'X-Lark-Request-Token': 'anything' } });
    expect(res.status).toBe(503);
    expect(h.received).toHaveLength(0);
  });

  it('says so once at construction', async () => {
    await start({});
    expect(harness?.logs.join(' ')).toMatch(/no verificationToken/);
  });
});

describe('path routing', () => {
  it('404s a request to a different path', async () => {
    const h = await start({ verificationToken: TOKEN });
    const res = await post(h, { path: '/elsewhere', headers: { 'X-Lark-Request-Token': TOKEN } });
    expect(res.status).toBe(404);
    expect(h.received).toHaveLength(0);
  });

  it('still accepts the configured path with a query string', async () => {
    const h = await start({ verificationToken: TOKEN });
    const res = await post(h, {
      path: `${PATH}?foo=bar`,
      headers: { 'X-Lark-Request-Token': TOKEN },
    });
    expect(res.status).toBe(200);
  });
});

describe('encryptKey signature verification', () => {
  it('accepts a correctly signed request', async () => {
    const h = await start({ verificationToken: TOKEN, encryptKey: ENCRYPT_KEY });
    const raw = JSON.stringify({ type: 'event_callback', event: { message_id: 'm1' } });
    const res = await post(h, { raw, headers: signed({ body: raw }, 'nonce-ok', Math.floor(Date.now() / 1000)) });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.received).toHaveLength(1);
  });

  it('rejects a request with no signature headers at all', async () => {
    const h = await start({ verificationToken: TOKEN, encryptKey: ENCRYPT_KEY });
    const res = await post(h, { headers: { 'X-Lark-Request-Token': TOKEN } });
    expect(res.status).toBe(401);
    expect(h.received).toHaveLength(0);
  });

  it('rejects a tampered body', async () => {
    const h = await start({ verificationToken: TOKEN, encryptKey: ENCRYPT_KEY });
    const signedBody = JSON.stringify({ type: 'event_callback', event: { message_id: 'm1' } });
    const headers = signed({ body: signedBody }, 'nonce-tamper', Math.floor(Date.now() / 1000));
    const tampered = JSON.stringify({ type: 'event_callback', event: { message_id: 'EVIL' } });
    const res = await post(h, { raw: tampered, headers });
    expect(res.status).toBe(401);
    expect(h.received).toHaveLength(0);
  });

  it('rejects a signature made with the wrong key', async () => {
    const h = await start({ verificationToken: TOKEN, encryptKey: ENCRYPT_KEY });
    const raw = JSON.stringify({ type: 'event_callback' });
    const res = await post(h, {
      raw,
      headers: signed({ body: raw }, 'nonce-wrongkey', Math.floor(Date.now() / 1000), 'not-the-key'),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a stale timestamp', async () => {
    const h = await start({ verificationToken: TOKEN, encryptKey: ENCRYPT_KEY });
    const raw = JSON.stringify({ type: 'event_callback' });
    const stale = Math.floor(Date.now() / 1000) - 3600;
    const res = await post(h, { raw, headers: signed({ body: raw }, 'nonce-stale', stale) });
    expect(res.status).toBe(401);
    expect(h.logs.join(' ')).toMatch(/stale timestamp/);
  });

  it('rejects a replayed nonce', async () => {
    const h = await start({ verificationToken: TOKEN, encryptKey: ENCRYPT_KEY });
    const raw = JSON.stringify({ type: 'event_callback' });
    const now = Math.floor(Date.now() / 1000);
    const headers = signed({ body: raw }, 'nonce-replay', now);

    const first = await post(h, { raw, headers });
    expect(first.status).toBe(200);

    const second = await post(h, { raw, headers });
    expect(second.status).toBe(401);
    expect(h.logs.join(' ')).toMatch(/replayed nonce/);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.received).toHaveLength(1);
  });

  it('skips the signature check when no encryptKey is configured', async () => {
    const h = await start({ verificationToken: TOKEN });
    const res = await post(h, {
      headers: { 'X-Lark-Request-Token': TOKEN },
      body: { type: 'event_callback' },
    });
    expect(res.status).toBe(200);
  });
});

describe('challenge handshake', () => {
  it('answers a url_verification carrying the configured token', async () => {
    const h = await start({ verificationToken: TOKEN });
    const res = await post(h, {
      headers: { 'X-Lark-Request-Token': TOKEN },
      body: { type: 'url_verification', token: TOKEN, challenge: 'abc123' },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ challenge: 'abc123' });
  });

  it('does not answer a url_verification with the wrong body token', async () => {
    const h = await start({ verificationToken: TOKEN });
    const res = await post(h, {
      headers: { 'X-Lark-Request-Token': TOKEN },
      body: { type: 'url_verification', token: 'nope', challenge: 'abc123' },
    });
    // Falls through to the event path with a non-event body; must not 200
    // as a successful challenge echo.
    expect(JSON.parse(res.body)).not.toEqual({ challenge: 'abc123' });
  });
});

describe('pre-existing guards still hold', () => {
  it('405s a non-POST request to the webhook path', async () => {
    const h = await start({ verificationToken: TOKEN });
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${h.base}${PATH}`, { method: 'GET' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(405);
  });

  it('500s on a malformed JSON body rather than crashing', async () => {
    const h = await start({ verificationToken: TOKEN });
    const res = await post(h, {
      raw: '{not json',
      headers: { 'X-Lark-Request-Token': TOKEN },
    });
    expect(res.status).toBe(500);
  });
});
