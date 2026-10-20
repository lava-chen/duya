/**
 * T31b — Plugin App capability grant store (plan 610, dispatch doc 25).
 *
 * These tests pin the persistence contract of the grant ledger only: that a
 * grant records what the user actually approved, that the approved tool
 * scope is preserved verbatim, that revocation is durable, and that a
 * re-approval replaces the scope. They prove nothing about an iframe or a
 * production App MCP call — the Host-side acceptance in the plan covers that.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoreDataHost } from '../src/core-data-host.js';
import {
  PluginAppGrantStoreError,
  type PluginAppCapabilityTool,
} from '../src/plugin-app-grant-store.js';

const temporaryDirectories: string[] = [];
const openHosts: CoreDataHost[] = [];

afterEach(() => {
  for (const host of openHosts.splice(0)) host.close();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createHost(): CoreDataHost {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-app-grant-test-'));
  temporaryDirectories.push(root);
  const host = new CoreDataHost({
    filename: path.join(root, 'duya-core.db'),
    rolloutRoot: path.join(root, 'sessions'),
    attachmentsRoot: path.join(root, 'attachments'),
    messageLogPorts: {
      botSessionIdPrefix: 'bot:',
      parseBotSessionId: () => null,
      getBotSessionLogPath: (agentId, dataRoot) => path.join(dataRoot, 'agents', agentId, 'sessions.jsonl'),
      getBotSessionsDir: (agentId, dataRoot) => path.join(dataRoot, 'agents', agentId, 'sessions'),
    },
  });
  openHosts.push(host);
  return host;
}

const READ_TOOL: PluginAppCapabilityTool = { serverName: 'dashboard', toolName: 'read' };
const EXPORT_TOOL: PluginAppCapabilityTool = { serverName: 'dashboard', toolName: 'export' };

function expectStoreError(action: () => unknown, reason: PluginAppGrantStoreError['reason']): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PluginAppGrantStoreError);
  expect((caught as PluginAppGrantStoreError).reason).toBe(reason);
}

describe('PluginAppGrantStore', () => {
  it('records the approved tool scope verbatim', () => {
    const store = createHost().stores.appGrants;

    const grant = store.grant({
      pluginId: 'com.duya.sample',
      appId: 'dashboard',
      capability: 'mcp:dashboard.read',
      mappingRevision: 'rev-1',
      tools: [READ_TOOL],
    });

    expect(grant).toMatchObject({
      pluginId: 'com.duya.sample',
      appId: 'dashboard',
      capability: 'mcp:dashboard.read',
      mappingRevision: 'rev-1',
      revokedAt: null,
    });
    expect(grant.tools).toEqual([READ_TOOL]);
    expect(store.listActiveCapabilities('com.duya.sample', 'dashboard')).toEqual(['mcp:dashboard.read']);
  });

  it('keeps the scope when the plugin later widens the mapping', () => {
    const store = createHost().stores.appGrants;
    store.grant({
      pluginId: 'com.duya.sample',
      appId: 'dashboard',
      capability: 'mcp:dashboard.read',
      mappingRevision: 'rev-1',
      tools: [READ_TOOL],
    });

    const stored = store.get('com.duya.sample', 'dashboard', 'mcp:dashboard.read');

    expect(stored?.tools).toEqual([READ_TOOL]);
    expect(stored?.mappingRevision).toBe('rev-1');
  });

  it('replaces the scope on re-approval and clears a revocation', () => {
    const store = createHost().stores.appGrants;
    store.grant({
      pluginId: 'com.duya.sample',
      appId: 'dashboard',
      capability: 'mcp:dashboard.read',
      mappingRevision: 'rev-1',
      tools: [READ_TOOL],
    });

    expect(store.revoke({ pluginId: 'com.duya.sample', appId: 'dashboard', capability: 'mcp:dashboard.read' })).toBe(true);
    expect(store.listActiveCapabilities('com.duya.sample', 'dashboard')).toEqual([]);
    expect(store.get('com.duya.sample', 'dashboard', 'mcp:dashboard.read')?.revokedAt).toEqual(expect.any(Number));

    const reapproved = store.grant({
      pluginId: 'com.duya.sample',
      appId: 'dashboard',
      capability: 'mcp:dashboard.read',
      mappingRevision: 'rev-2',
      tools: [READ_TOOL, EXPORT_TOOL],
    });

    expect(reapproved.revokedAt).toBeNull();
    expect(reapproved.mappingRevision).toBe('rev-2');
    expect(reapproved.tools).toEqual([READ_TOOL, EXPORT_TOOL]);
    expect(store.listActiveCapabilities('com.duya.sample', 'dashboard')).toEqual(['mcp:dashboard.read']);
  });

  it('reports a repeated revoke as nothing to revoke', () => {
    const store = createHost().stores.appGrants;
    store.grant({
      pluginId: 'com.duya.sample',
      appId: 'dashboard',
      capability: 'mcp:dashboard.read',
      mappingRevision: 'rev-1',
      tools: [READ_TOOL],
    });
    store.revoke({ pluginId: 'com.duya.sample', appId: 'dashboard', capability: 'mcp:dashboard.read' });

    expect(store.revoke({ pluginId: 'com.duya.sample', appId: 'dashboard', capability: 'mcp:dashboard.read' })).toBe(false);
  });

  it('isolates one App from another and one plugin from another', () => {
    const store = createHost().stores.appGrants;
    store.grant({
      pluginId: 'com.duya.sample',
      appId: 'dashboard',
      capability: 'mcp:dashboard.read',
      mappingRevision: 'rev-1',
      tools: [READ_TOOL],
    });

    expect(store.listActiveCapabilities('com.duya.sample', 'reports')).toEqual([]);
    expect(store.listActiveCapabilities('com.duya.other', 'dashboard')).toEqual([]);
    expect(store.get('com.duya.other', 'dashboard', 'mcp:dashboard.read')).toBeNull();
  });

  it('rejects a blank field and a malformed tool entry', () => {
    const store = createHost().stores.appGrants;

    expectStoreError(() => store.grant({
      pluginId: '',
      appId: 'dashboard',
      capability: 'mcp:dashboard.read',
      mappingRevision: 'rev-1',
      tools: [],
    }), 'invalid_input');
    expectStoreError(() => store.grant({
      pluginId: 'com.duya.sample',
      appId: 'dashboard',
      capability: 'mcp:dashboard.read',
      mappingRevision: 'rev-1',
      tools: [{ serverName: 'dashboard' } as unknown as PluginAppCapabilityTool],
    }), 'invalid_tools');
  });

  it('stores only the grant columns it declares', () => {
    const host = createHost();
    const columns = host.database.db
      .prepare('PRAGMA table_info(plugin_app_grants)')
      .all() as Array<{ name: string }>;

    expect(columns.map((column) => column.name).sort()).toEqual([
      'app_id',
      'capability',
      'granted_at',
      'mapping_revision',
      'plugin_id',
      'revoked_at',
      'tools_json',
    ]);
  });
});
