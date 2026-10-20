import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HostSessionHttpClient } from '../src/http-client.js';
import { startLocalHost, type LocalHostHandle } from '../src/local-host.js';

const TOKEN = 'plugin-app-invocation-http-test-token';
const roots: string[] = [];
const hosts: LocalHostHandle[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function open() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-app-invocation-http-'));
  roots.push(dataRoot);
  const host = await startLocalHost({ dataRoot, port: 0, token: TOKEN, ephemeral: true });
  hosts.push(host);
  return { host, client: new HostSessionHttpClient(host.origin, TOKEN) };
}

describe('authenticated Host Plugin App invocation route', () => {
  it('rejects missing local auth, browser Origins, forged authority fields, and missing trusted resolver', async () => {
    const { host } = await open();
    const url = `${host.origin}/v1/local/plugin-app-invocations/bind`;
    const input = { pluginId: 'com.duya.sample', appId: 'counter', instanceId: 'instance-1', sessionId: 'session-1' };
    expect((await fetch(url, { method: 'POST', body: JSON.stringify(input) })).status).toBe(401);
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    expect((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://app.example' },
      body: JSON.stringify(input) })).status).toBe(403);
    for (const extra of [{ runId: 'forged' }, { grantedCapabilities: ['mcp:write'] }, { connectorId: 'forged' }]) {
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...input, ...extra }) });
      expect(response.status).toBe(400);
    }
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(input) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'plugin_app_invocation_authority_unavailable' } });
  });

  it('types only binding and invocation selector fields in the Host client contract', async () => {
    const { client } = await open();
    await expect(client.bindPluginAppInvocation({
      pluginId: 'com.duya.sample', appId: 'counter', instanceId: 'instance-1', sessionId: 'session-1',
    })).rejects.toMatchObject({ status: 503 });
  });
});
