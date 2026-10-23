import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PluginAppAssetServer } from './plugin-app-assets';

let root: string;
let server: PluginAppAssetServer;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'duya-app-assets-'));
  await mkdir(path.join(root, 'package', 'apps'), { recursive: true });
  await writeFile(path.join(root, 'package', 'apps', 'index.html'), '<script type="module" src="./main.js"></script>');
  await writeFile(path.join(root, 'package', 'apps', 'main.js'), 'window.parent.postMessage("ready", "*");');
  await writeFile(path.join(root, 'private.txt'), 'outside the installed package');
  server = new PluginAppAssetServer();
});

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

async function launch(session = 'session-a'): Promise<string> {
  return server.open(session, path.join(root, 'package'), path.join(root, 'package', 'apps', 'index.html'));
}

function rawGet(url: string, resource: string, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = request({ hostname: parsed.hostname, port: parsed.port, path: resource, headers: host ? { Host: host } : {} }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode!));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Plugin App package assets', () => {
  it('serves entry and relative module assets to an opaque-origin iframe', async () => {
    const entry = await launch();
    const html = await fetch(entry);
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(html.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
    expect(html.headers.get('referrer-policy')).toBe('no-referrer');
    const script = await fetch(new URL('./main.js', entry), { headers: { Origin: 'null' } });
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(script.headers.get('access-control-allow-origin')).toBe('*');
    expect(await script.text()).toContain('postMessage');
  });

  it('refuses unknown mounts, encoded traversal, escaped symlinks and foreign Host headers', async () => {
    const entry = await launch();
    const pathname = new URL(entry).pathname;
    const token = pathname.split('/')[1];
    await symlink(path.join(root, 'private.txt'), path.join(root, 'package', 'apps', 'escape.txt'));
    expect((await fetch(new URL('./escape.txt', entry))).status).toBe(404);
    expect(await rawGet(entry, `/${token}/%2e%2e/private.txt`)).toBe(404);
    expect(await rawGet(entry, pathname, 'untrusted.example')).toBe(403);
    expect((await fetch(new URL('/unknown/apps/index.html', entry))).status).toBe(404);
    expect((await fetch(entry, { method: 'POST' })).status).toBe(405);
  });

  it('revokes only the closed session and replaces an earlier launch of that session', async () => {
    const first = await launch();
    const other = await launch('session-b');
    const replacement = await launch();
    expect((await fetch(first)).status).toBe(404);
    expect((await fetch(replacement)).status).toBe(200);
    server.revoke('session-a');
    expect((await fetch(replacement)).status).toBe(404);
    expect((await fetch(other)).status).toBe(200);
  });
});
