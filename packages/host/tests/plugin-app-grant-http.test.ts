import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostPluginAppInvocationAuthority } from '../src/local-plugin-app-invocation-api.js';
import { startLocalHost, type LocalHostHandle } from '../src/local-host.js';

const TOKEN = 'plugin-app-grant-http-test-token';
const roots: string[] = [];
const hosts: LocalHostHandle[] = [];
const READ_SCOPE = [{ serverName: 'dashboard', toolName: 'read' }];
const WRITE_SCOPE = [{ serverName: 'dashboard', toolName: 'write' }];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function open(withAuthority = true) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-app-grant-http-'));
  roots.push(dataRoot);
  const authority: HostPluginAppInvocationAuthority = {
    resolveApp: async (pluginId, appId) => pluginId === 'com.duya.sample' && appId === 'counter'
      ? {
        appId,
        entry: 'apps/counter.html',
        requiredCapabilities: ['mcp:dashboard.read'],
        stateSchemaVersion: 1,
        capabilityTools: [{ capability: 'mcp:dashboard.read', tools: READ_SCOPE }],
      }
      : null,
    resolveGrantedCapabilities: async () => [],
    resolveToolCapability: ({ descriptor }) =>
      descriptor.source === 'plugin' && descriptor.serverName === 'dashboard' &&
        descriptor.toolName === 'read' && descriptor.pluginId === 'com.duya.sample'
        ? 'mcp:dashboard.read'
        : null,
  };
  const host = await startLocalHost({
    dataRoot,
    port: 0,
    token: TOKEN,
    ephemeral: true,
    ...(withAuthority ? { pluginAppInvocationAuthority: authority } : {}),
  });
  hosts.push(host);
  return host;
}

function grantUrl(host: LocalHostHandle): string {
  return `${host.origin}/v1/local/plugin-app-grants`;
}

function headers(origin?: string): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    ...(origin === undefined ? {} : { origin }),
  };
}

describe('authenticated Host Plugin App grant route', () => {
  it('fails closed without manifest authority and rejects browser Origins', async () => {
    const host = await open(false);
    const body = { pluginId: 'com.duya.sample', appId: 'counter', capability: 'mcp:dashboard.read', tools: READ_SCOPE };
    const response = await fetch(grantUrl(host), { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'plugin_app_grant_authority_unavailable' } });

    const browser = await fetch(grantUrl(host), {
      method: 'POST', headers: headers('https://app.example'), body: JSON.stringify(body),
    });
    expect(browser.status).toBe(403);
  });

  it('accepts only the exact current tool scope and computes the persisted mapping revision in Host', async () => {
    const host = await open();
    const body = { pluginId: 'com.duya.sample', appId: 'counter', capability: 'mcp:dashboard.read', tools: READ_SCOPE };

    const mismatchedScope = await fetch(grantUrl(host), {
      method: 'POST', headers: headers(), body: JSON.stringify({ ...body, tools: [...READ_SCOPE, ...WRITE_SCOPE] }),
    });
    expect(mismatchedScope.status).toBe(409);

    const nestedExtraField = await fetch(grantUrl(host), {
      method: 'POST', headers: headers(), body: JSON.stringify({
        ...body,
        tools: [{ serverName: 'dashboard', toolName: 'read', capability: 'mcp:anything' }],
      }),
    });
    expect(nestedExtraField.status).toBe(400);

    const callerRevision = await fetch(grantUrl(host), {
      method: 'POST', headers: headers(), body: JSON.stringify({ ...body, mappingRevision: 'caller-chosen' }),
    });
    expect(callerRevision.status).toBe(400);

    const granted = await fetch(grantUrl(host), { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    expect(granted.status).toBe(200);
    const payload = await granted.json() as { grant: { mappingRevision: string; tools: unknown[]; revokedAt: number | null } };
    expect(payload.grant.mappingRevision).toMatch(/^[a-f0-9]{32}$/);
    expect(payload.grant.tools).toEqual(READ_SCOPE);
    expect(payload.grant.revokedAt).toBeNull();

    const revoked = await fetch(grantUrl(host), {
      method: 'DELETE', headers: headers(), body: JSON.stringify({
        pluginId: 'com.duya.sample', appId: 'counter', capability: 'mcp:dashboard.read',
      }),
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ revoked: true });
    const listed = await fetch(`${grantUrl(host)}?pluginId=com.duya.sample&appId=counter`, { headers: headers() });
    const rows = await listed.json() as { grants: Array<{ revokedAt: number | null }> };
    expect(rows.grants).toHaveLength(1);
    expect(rows.grants[0]?.revokedAt).toEqual(expect.any(Number));
  });
});
