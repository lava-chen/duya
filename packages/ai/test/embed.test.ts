import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAIClient } from '../src/index.js';
import { createAIClientWithRetry } from '../src/retry-client.js';

/** Spin up a local HTTP server that captures embed requests. Returns one
 *  vector per input (fixed length-2 vectors). */
function startFakeOllamaServer() {
  let lastBody: unknown = null;
  let lastPath: string | null = null;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      lastBody = raw ? JSON.parse(raw) : null;
      lastPath = req.url ?? null;
      res.setHeader('Content-Type', 'application/json');
      const inputCount = Array.isArray((lastBody as { input?: unknown })?.input)
        ? ((lastBody as { input: unknown[] }).input.length)
        : 1;
      res.end(
        JSON.stringify({
          embeddings: Array.from({ length: inputCount }, (_, i) => [0.1 * (i + 1), 0.2]),
        }),
      );
    });
  });
  return new Promise<{
    server: Server;
    url: string;
    body: () => unknown;
    path: () => string | null;
  }>(
    (resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          server,
          url: `http://127.0.0.1:${port}`,
          body: () => lastBody,
          path: () => lastPath,
        });
      });
    },
  );
}

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

describe('AIClient.embed', () => {
  it('ollama client posts to /api/embed with model + input and returns vectors', async () => {
    const fake = await startFakeOllamaServer();
    servers.push(fake.server);

    const client = createAIClient({
      apiKey: '',
      baseURL: fake.url,
      model: 'bge-m3',
      apiFormat: 'ollama',
      providerId: 'ollama',
    });
    expect(typeof client.embed).toBe('function');
    const vectors = await client.embed!(['hello', 'world']);
    expect(vectors).toEqual([
      [0.1, 0.2],
      [0.2, 0.2],
    ]);
    expect(fake.body()).toEqual({ model: 'bge-m3', input: ['hello', 'world'] });
  });

  it('strips a trailing /v1 suffix before hitting the native endpoint', async () => {
    const fake = await startFakeOllamaServer();
    servers.push(fake.server);

    const client = createAIClient({
      apiKey: '',
      baseURL: `${fake.url}/v1`,
      model: 'bge-m3',
      apiFormat: 'ollama',
      providerId: 'ollama',
    });
    await client.embed!(['x']);
    // The client must have hit {base}/api/embed, never {base}/v1/api/embed.
    expect(fake.path()).toBe('/api/embed');
    expect(fake.body()).toEqual({ model: 'bge-m3', input: ['x'] });
  });

  it('lazy proxy forwards embed to the underlying client', async () => {
    const fake = await startFakeOllamaServer();
    servers.push(fake.server);
    const client = createAIClient({
      apiKey: '',
      baseURL: fake.url,
      model: 'bge-m3',
      apiFormat: 'ollama',
      providerId: 'ollama',
    });
    const vectors = await client.embed!(['a', 'b']);
    expect(vectors).toHaveLength(2);
  });

  it('anthropic client embed rejects (no embeddings endpoint → callers degrade)', async () => {
    const client = createAIClient({
      apiKey: 'sk-test',
      baseURL: 'https://api.anthropic.com',
      model: 'claude-sonnet-4',
      apiFormat: 'anthropic',
      providerId: 'anthropic',
    });
    await expect(client.embed!(['x'])).rejects.toThrow(/does not support embed/);
  });

  it('retry-wrapped client forwards embed to the underlying client', async () => {
    const fake = await startFakeOllamaServer();
    servers.push(fake.server);
    const client = createAIClientWithRetry({
      apiKey: '',
      baseURL: fake.url,
      model: 'bge-m3',
      apiFormat: 'ollama',
      providerId: 'ollama',
    });
    expect(typeof client.embed).toBe('function');
    const vectors = await client.embed!(['hello', 'world']);
    expect(vectors).toEqual([
      [0.1, 0.2],
      [0.2, 0.2],
    ]);
  });
});
