import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { browserBuildRoot, resolveHostConnection, resolveStaticRoot } from '../../src/server/main.js';

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

describe('web server browser build root', () => {
  it('resolves the browser build next to the compiled server entry', () => {
    const distServerEntry = path.join(os.tmpdir(), 'duya-web-dist', 'server', 'main.js');
    const moduleUrl = pathToFileURL(distServerEntry).href;

    expect(browserBuildRoot(moduleUrl)).toBe(path.join(os.tmpdir(), 'duya-web-dist', 'client') + path.sep);
  });

  it('serves statically only when the build root holds a document', async () => {
    const distRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-web-dist-'));
    roots.push(distRoot);
    const browserRoot = path.join(distRoot, 'browser');

    await expect(resolveStaticRoot(browserRoot)).resolves.toBeUndefined();

    await fs.mkdir(path.join(browserRoot, 'assets'), { recursive: true });
    await expect(resolveStaticRoot(browserRoot)).resolves.toBeUndefined();

    await fs.writeFile(path.join(browserRoot, 'index.html'), '<!doctype html><div id="root"></div>');
    await expect(resolveStaticRoot(browserRoot)).resolves.toBe(browserRoot);
  });

  it('stays API-only when index.html is a directory instead of a built document', async () => {
    const distRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-web-dist-'));
    roots.push(distRoot);
    const browserRoot = path.join(distRoot, 'browser');
    await fs.mkdir(path.join(browserRoot, 'index.html'), { recursive: true });

    await expect(resolveStaticRoot(browserRoot)).resolves.toBeUndefined();
  });
});
