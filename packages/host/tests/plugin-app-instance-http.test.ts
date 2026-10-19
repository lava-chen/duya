import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HostSessionHttpClient } from '../src/http-client.js';
import { startLocalHost, type LocalHostHandle } from '../src/local-host.js';

const TOKEN = 'plugin-app-instance-http-test-token';
const roots: string[] = [];
const hosts: LocalHostHandle[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function open(root?: string) {
  const dataRoot = root ?? await fs.mkdtemp(path.join(os.tmpdir(), 'duya-app-instance-http-'));
  if (root === undefined) roots.push(dataRoot);
  const host = await startLocalHost({ dataRoot, port: 0, token: TOKEN, ephemeral: true });
  hosts.push(host);
  return { dataRoot, host, client: new HostSessionHttpClient(host.origin, TOKEN) };
}

describe('production Host Plugin App instance API', () => {
  it('mints isolated identities and preserves CAS/revocation through Host restart', async () => {
    const first = await open();
    const create = (appId: string) => first.client.createPluginAppInstance({
      pluginId: 'com.duya.sample', appId, stateSchemaVersion: 1, state: { count: 0 },
    });
    const a = await create('counter');
    const b = await create('counter');
    const c = await create('notes');
    expect(new Set([a.instanceId, b.instanceId, c.instanceId]).size).toBe(3);
    expect(a.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await first.client.listPluginAppInstances('com.duya.sample', 'counter')).toHaveLength(2);
    expect(await first.client.listPluginAppInstances('other.plugin')).toEqual([]);
    expect(await first.client.writePluginAppInstanceState(a.instanceId, {
      expectedRevision: 1, expectedSchemaVersion: 1, state: { count: 4 },
    })).toMatchObject({ ok: true, instance: { revision: 2, state: { count: 4 } } });
    expect(await first.client.writePluginAppInstanceState(a.instanceId, {
      expectedRevision: 1, expectedSchemaVersion: 1, state: { count: 99 },
    })).toMatchObject({ ok: false, reason: 'stale_revision' });
    expect(await first.client.writePluginAppInstanceState(a.instanceId, {
      expectedRevision: 2, expectedSchemaVersion: 2, state: { count: 99 },
    })).toMatchObject({ ok: false, reason: 'schema_mismatch' });
    expect(await first.client.setPluginAppInstanceStatus(a.instanceId, {
      expectedRevision: 2, status: 'revoked',
    })).toMatchObject({ ok: true, instance: { revision: 3, status: 'revoked' } });
    hosts.splice(hosts.indexOf(first.host), 1);
    await first.host.close();
    const reopened = await open(first.dataRoot);
    expect(await reopened.client.getPluginAppInstance(a.instanceId)).toMatchObject({
      state: { count: 4 }, revision: 3, status: 'revoked',
    });
    expect(await reopened.client.getPluginAppInstance(b.instanceId)).toMatchObject({
      state: { count: 0 }, revision: 1, status: 'active',
    });
    expect(await reopened.client.setPluginAppInstanceStatus(a.instanceId, {
      expectedRevision: 3, status: 'active',
    })).toMatchObject({ ok: false, reason: 'invalid_transition' });
    expect(await reopened.client.getPluginAppInstance('not-an-instance')).toBeNull();
  });

  it('keeps trusted-local authentication and refuses forged authority fields', async () => {
    const { host } = await open();
    const url = `${host.origin}/v1/local/plugin-app-instances`;
    const input = { pluginId: 'sample', appId: 'counter', stateSchemaVersion: 1 };
    expect((await fetch(url + '?pluginId=sample')).status).toBe(401);
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    expect((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://foreign.example' },
      body: JSON.stringify(input) })).status).toBe(403);
    for (const extra of [{ instanceId: 'forged' }, { grantedCapabilities: ['mcp.write'] }, { runId: 'forged' }]) {
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...input, ...extra }) });
      expect(response.status).toBe(400);
    }
    expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify({
      ...input, state: { huge: 'x'.repeat(300_000) },
    }) })).status).toBe(413);
    expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify({
      ...input, stateSchemaVersion: 0,
    }) })).status).toBe(400);
  });
});
