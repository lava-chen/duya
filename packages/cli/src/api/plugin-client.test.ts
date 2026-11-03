import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PluginApiClient } from './plugin-client.js';

describe('PluginApiClient', () => {
  it('explains when the connected Host predates plugin management and releases its lease', async () => {
    const previousDataRoot = process.env.DUYA_DATA_ROOT;
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'duya-plugin-client-'));
    let leaseClosedResolve: () => void = () => undefined;
    const leaseClosed = new Promise<void>((resolve) => {
      leaseClosedResolve = resolve;
    });
    const server = createServer((req, res) => {
      if (req.url === '/v1/host/lease') {
        res.on('close', leaseClosedResolve);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.flushHeaders();
        return;
      }
      if (req.url === '/v1/plugins') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'not_found' } }));
        return;
      }
      res.writeHead(404).end();
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
      await mkdir(path.join(dataRoot, 'runtime'), { recursive: true });
      await writeFile(path.join(dataRoot, 'runtime', 'host-api.json'), JSON.stringify({
        apiVersion: 1,
        host: '127.0.0.1',
        port: address.port,
        token: 'plugin-client-test-token',
        pid: process.pid,
        startedAt: Date.now(),
      }));
      process.env.DUYA_DATA_ROOT = dataRoot;

      const client = await PluginApiClient.connect();
      await expect(client.get('/v1/plugins')).rejects.toMatchObject({
        message: 'The connected Duya Host does not support plugin management. Restart DUYA Desktop or the Host, then retry.',
        httpStatus: 404,
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          leaseClosed,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Host lease was not released')), 2_000);
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    } finally {
      if (previousDataRoot === undefined) delete process.env.DUYA_DATA_ROOT;
      else process.env.DUYA_DATA_ROOT = previousDataRoot;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});
