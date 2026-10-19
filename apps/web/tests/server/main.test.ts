import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveHostConnection } from '../../src/server/main.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('web server Host discovery', () => {
  it('reads the standard loopback Host runtime descriptor', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-web-main-'));
    roots.push(dataRoot);
    const runtimeDirectory = path.join(dataRoot, 'runtime');
    await fs.mkdir(runtimeDirectory);
    await fs.writeFile(path.join(runtimeDirectory, 'host-api.json'), JSON.stringify({
      apiVersion: 1,
      host: '127.0.0.1',
      port: 43210,
      token: 'server-only-token',
      pid: process.pid,
      startedAt: Date.now(),
    }));

    await expect(resolveHostConnection({ DUYA_DATA_ROOT: dataRoot } as NodeJS.ProcessEnv)).resolves.toEqual({
      origin: 'http://127.0.0.1:43210',
      token: 'server-only-token',
    });
  });

  it('rejects descriptors outside the Host runtime schema before starting a listener', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-web-main-'));
    roots.push(dataRoot);
    const runtimeDirectory = path.join(dataRoot, 'runtime');
    await fs.mkdir(runtimeDirectory);
    await fs.writeFile(path.join(runtimeDirectory, 'host-api.json'), JSON.stringify({
      apiVersion: 1,
      host: '192.0.2.10',
      port: 43210,
      token: 'server-only-token',
      pid: process.pid,
      startedAt: Date.now(),
    }));

    await expect(resolveHostConnection({ DUYA_DATA_ROOT: dataRoot } as NodeJS.ProcessEnv))
      .rejects.toThrow('invalid');
  });

  it('does not connect to a stale Host runtime descriptor', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-web-main-'));
    roots.push(dataRoot);
    const runtimeDirectory = path.join(dataRoot, 'runtime');
    await fs.mkdir(runtimeDirectory);
    await fs.writeFile(path.join(runtimeDirectory, 'host-api.json'), JSON.stringify({
      apiVersion: 1,
      host: '127.0.0.1',
      port: 43210,
      token: 'server-only-token',
      pid: 2_000_000_000,
      startedAt: Date.now(),
    }));

    await expect(resolveHostConnection({ DUYA_DATA_ROOT: dataRoot } as NodeJS.ProcessEnv))
      .rejects.toThrow('No live local Duya Host');
  });
});
