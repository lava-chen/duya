import Database from 'better-sqlite3';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionLedger } from '@duya/data/core-stores';
import { PluginAppGrantStore } from '@duya/data/plugin-app-grant-store';
import { PluginAppInstanceStore } from '@duya/data/plugin-app-instance-store';
import { resolveDatabasePaths } from '@duya/data/data-paths';
import { createMCPToolExecutor } from '@duya/agent-runtime/tools/mcp-executor';
import type { PermissionRequestEvent } from '@duya/agent-protocol';
import type { PluginAppDefinition } from '@duya/plugin-core/apps/declarations';
import { createHostPermissionRequestApi } from '../src/permission-request-api.js';
import { WorkerPermissionRequests } from '../src/worker-permission-requests.js';
import { createWorkerMCPExecutorPorts } from '../src/connector-services/worker-permission-binding.js';
import { createHostPluginAppInvocationApi } from '../src/local-plugin-app-invocation-api.js';
import { createHostPluginAppGrantAuthority } from '../src/local-plugin-app-grant-authority.js';
import { WorkerSession } from '../src/worker-session-runtime.js';
import type { ToolUseContext } from '../src/worker-run-contracts.js';
import { startLocalHost, type LocalHostHandle } from '../src/local-host.js';

const PLUGIN_ID = 'com.duya.sample';
const APP_ID = 'counter';
const CAPABILITY = 'mcp:dashboard.read';
const TOOL_ID = 'mcp__plugin:com.duya.sample:dashboard__read';
const BOUND_TOOL_ID = 'plugin:com.duya.sample%3Adashboard:read';
const SESSION_ID = 'session-plugin-app';
const RUN_ID = 'run-plugin-app';
const TOKEN = 'plugin-app-grant-authority-test-token';
const READ_SCOPE = [{ serverName: 'dashboard', toolName: 'read' }];
const WRITE_SCOPE = { serverName: 'dashboard', toolName: 'write' };

const cleanups: Array<() => void | Promise<void>> = [];
const roots: string[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  // The data root holds the core database, so it can only be removed once
  // the Host and every connection to it are closed.
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

interface Harness {
  readonly host: LocalHostHandle;
  readonly authority: ReturnType<typeof createHostPluginAppGrantAuthority>;
  readonly api: ReturnType<typeof createHostPluginAppInvocationApi>;
  readonly instanceId: string;
  readonly connectorCalls: Array<Record<string, unknown>>;
  readonly pendingApprovals: () => Promise<readonly { id: string }[]>;
  readonly resolveApproval: (id: string, allow: boolean) => Promise<void>;
  /** The manifest the trusted resolver publishes; the test may widen it. */
  readonly manifest: { app: PluginAppDefinition };
}

function declaredApp(tools: readonly { serverName: string; toolName: string }[]): PluginAppDefinition {
  return {
    appId: APP_ID,
    entry: 'apps/counter.html',
    requiredCapabilities: [CAPABILITY],
    stateSchemaVersion: 1,
    capabilityTools: [{ capability: CAPABILITY, tools: [...tools] }],
  };
}

function headers(origin?: string): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    ...(origin === undefined ? {} : { origin }),
  };
}

async function openHarness(): Promise<Harness> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-app-grant-authority-'));
  roots.push(dataRoot);
  const manifest = { app: declaredApp(READ_SCOPE) };
  const resolveApp = async (pluginId: string, appId: string): Promise<PluginAppDefinition | null> =>
    pluginId === PLUGIN_ID && appId === APP_ID ? manifest.app : null;

  // The Host composes its own authority from the durable grant ledger and the
  // trusted manifest resolver, and serves the grant route with it.
  const host = await startLocalHost({
    dataRoot,
    port: 0,
    token: TOKEN,
    ephemeral: true,
    pluginAppManifestResolver: resolveApp,
  });
  cleanups.push(() => host.close());

  // A second connection to the same core database: the ledger the Host
  // writes is the ledger the authority reads.
  const coreDatabasePath = resolveDatabasePaths({ dataRoot }).coreDatabasePath;
  const database = new Database(coreDatabasePath);
  cleanups.push(() => database.close());
  const grantStore = new PluginAppGrantStore(database);
  const instanceStore = new PluginAppInstanceStore(database);
  const authority = createHostPluginAppGrantAuthority({ store: grantStore, resolveApp });

  const instanceResponse = await fetch(`${host.origin}/v1/local/plugin-app-instances`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ pluginId: PLUGIN_ID, appId: APP_ID, stateSchemaVersion: 1, state: {} }),
  });
  expect(instanceResponse.status).toBe(201);
  const instancePayload = await instanceResponse.json() as { instance: { instanceId: string } };
  const instanceId = instancePayload.instance.instanceId;

  const ledger = new Database(':memory:');
  for (const migration of PermissionLedger.migrations) migration.up(ledger);
  const records = createHostPermissionRequestApi({ permissions: new PermissionLedger(ledger) });
  cleanups.push(() => ledger.close());

  const session = new WorkerSession(
    {
      apiKey: 'test-key',
      model: 'test-model',
      sessionId: SESSION_ID,
      provider: 'anthropic',
      baseURL: 'http://127.0.0.1:1',
      workingDirectory: process.cwd(),
    },
    { createRegistry: () => { throw new Error('the MCP catalog is registered directly'); } },
  );

  const connectorCalls: Array<Record<string, unknown>> = [];
  const executor = createMCPToolExecutor({
    toolName: 'dashboard.read',
    source: 'plugin',
    invoke: async (input) => {
      connectorCalls.push(input);
      return { id: 'call-1', name: 'dashboard.read', result: JSON.stringify({ rows: 1 }) };
    },
    ports: createWorkerMCPExecutorPorts({
      getActiveMCPManager: () => null,
      getNonMCPModelVisibleToolNames: () => new Set<string>(),
      setActiveMCPRuntime: async () => ({ removedKeys: [], addedKeys: [], keptKeys: [] }),
      getPermissionMode: () => 'default',
    }),
  });

  session.activeMCPRegistry.registerWithKey(
    TOOL_ID,
    {
      name: TOOL_ID,
      description: 'Read the dashboard.',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
      mcpInfo: {
        serverName: 'dashboard',
        toolName: 'read',
        source: 'plugin',
        connectionId: 'dashboard',
        pluginId: PLUGIN_ID,
      },
    },
    executor,
    'mcp',
    { discovery: { namespace: 'dashboard', conciseHint: 'Read the dashboard.', tags: [] } },
  );

  const pendingResolvers = new Map<string, (decision: 'allow' | 'deny') => void>();
  const broker = new WorkerPermissionRequests(
    records,
    (_sessionId, message) => {
      const id = typeof message.id === 'string' ? message.id : '';
      const resolver = pendingResolvers.get(id);
      if (!resolver) return false;
      resolver(message.decision === 'allow' || message.decision === 'allow_once' ||
        message.decision === 'allow_for_session' ? 'allow' : 'deny');
      return true;
    },
    () => true,
  );
  cleanups.push(() => broker.closeAll());

  const requestPermission = async (request: PermissionRequestEvent): Promise<'allow' | 'deny' | 'paused'> => {
    await broker.request(SESSION_ID, RUN_ID, {
      id: request.id,
      toolName: request.toolName,
      toolInput: request.toolInput,
      expiresAt: request.expiresAt,
    });
    return new Promise<'allow' | 'deny' | 'paused'>((resolve) => {
      pendingResolvers.set(request.id, (decision) => {
        pendingResolvers.delete(request.id);
        resolve(decision);
      });
    });
  };

  const controller = new AbortController();
  const internals = session as unknown as {
    abortController: AbortController | null;
    currentToolUseContext: ToolUseContext | undefined;
    currentRunId: string | null;
  };
  internals.abortController = controller;
  internals.currentRunId = RUN_ID;
  internals.currentToolUseContext = {
    toolUseId: 'tool-use-turn',
    getAppState: () => ({}),
    setAppState: () => undefined,
    abortController: controller,
    options: { tools: [], commands: [], mainLoopModel: 'test-model', mcpClients: [] },
    requestPermission,
  };

  const caller = { sessionId: SESSION_ID, runId: RUN_ID, epoch: 1 };
  const api = createHostPluginAppInvocationApi({
    getInstance: async (requested) => instanceStore.get(requested),
    authority,
    currentRun: async () => ({ runId: RUN_ID, epoch: 1 }),
    isCurrentRun: async (_sessionId, runId, epoch) => runId === RUN_ID && epoch === 1,
    worker: {
      describeMcpTools: async (input) => session.describePluginAppMcpTools(input.runId),
      invokeMcpTool: async (input) => session.invokePluginAppMcpTool({
        runId: input.runId,
        toolId: input.toolId,
        schemaRevision: input.schemaRevision,
        arguments: input.arguments,
        isBindingCurrent: () => api.isBindingCurrent(input.bindingId, input.nonce, input.toolId, caller),
      }),
    },
  });

  return {
    host,
    authority,
    api,
    instanceId,
    connectorCalls,
    pendingApprovals: async () => records.listPendingPermissionRequests(SESSION_ID),
    resolveApproval: async (id, allow) => {
      await broker.resolvePermissionRequest(id, {
        status: allow ? 'allow' : 'deny',
        decision: allow ? 'allow_once' : 'deny',
      });
    },
    manifest,
  };
}

function grantUrl(host: LocalHostHandle): string {
  return `${host.origin}/v1/local/plugin-app-grants`;
}

async function grantOverHttp(
  host: LocalHostHandle,
  tools: readonly { serverName: string; toolName: string }[] = READ_SCOPE,
): Promise<Response> {
  return fetch(grantUrl(host), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      pluginId: PLUGIN_ID,
      appId: APP_ID,
      capability: CAPABILITY,
      tools,
    }),
  });
}

async function revokeOverHttp(host: LocalHostHandle): Promise<Response> {
  return fetch(grantUrl(host), {
    method: 'DELETE',
    headers: headers(),
    body: JSON.stringify({ pluginId: PLUGIN_ID, appId: APP_ID, capability: CAPABILITY }),
  });
}

async function waitForPendingApproval(harness: Harness): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const pending = await harness.pendingApprovals();
    if (pending.length > 0) return pending[0]!.id;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the invocation never reached the approval round-trip');
}

const DESCRIPTOR = {
  source: 'plugin',
  serverName: 'dashboard',
  toolName: 'read',
  connectionId: 'dashboard',
  pluginId: PLUGIN_ID,
};

describe('Plugin App grant ledger as the invocation authority', () => {
  it('authorizes the tool only through a grant the privileged route wrote', async () => {
    const harness = await openHarness();

    expect(await harness.authority.resolveGrantedCapabilities({
      pluginId: PLUGIN_ID, appId: APP_ID, instanceId: harness.instanceId,
      sessionId: SESSION_ID, runId: RUN_ID,
    })).toEqual([]);
    expect(harness.authority.resolveToolCapability({
      pluginId: PLUGIN_ID, app: harness.manifest.app, descriptor: DESCRIPTOR,
    })).toBeNull();

    const granted = await grantOverHttp(harness.host);
    expect(granted.status).toBe(200);
    const payload = await granted.json() as { grant: { mappingRevision: string; revokedAt: number | null } };
    expect(payload.grant.mappingRevision).toMatch(/^[a-f0-9]{32}$/);
    expect(payload.grant.revokedAt).toBeNull();

    expect(await harness.authority.resolveGrantedCapabilities({
      pluginId: PLUGIN_ID, appId: APP_ID, instanceId: harness.instanceId,
      sessionId: SESSION_ID, runId: RUN_ID,
    })).toEqual([CAPABILITY]);
    expect(harness.authority.resolveToolCapability({
      pluginId: PLUGIN_ID, app: harness.manifest.app, descriptor: DESCRIPTOR,
    })).toBe(CAPABILITY);

    const binding = await harness.api.bindPluginAppInvocation({
      pluginId: PLUGIN_ID, appId: APP_ID, instanceId: harness.instanceId, sessionId: SESSION_ID,
    });
    const invocation = harness.api.invokePluginAppTool({
      bindingId: binding.bindingId,
      nonce: binding.nonce,
      toolId: BOUND_TOOL_ID,
      arguments: { query: 'status' },
    });
    const approvalId = await waitForPendingApproval(harness);
    await harness.resolveApproval(approvalId, true);
    const result = await invocation;

    expect(result).toMatchObject({ ok: true });
    expect(harness.connectorCalls).toEqual([{ query: 'status' }]);
  });

  it('stops resolving the capability once the grant is revoked', async () => {
    const harness = await openHarness();
    expect((await grantOverHttp(harness.host)).status).toBe(200);

    const revoked = await revokeOverHttp(harness.host);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ revoked: true });

    expect(await harness.authority.resolveGrantedCapabilities({
      pluginId: PLUGIN_ID, appId: APP_ID, instanceId: harness.instanceId,
      sessionId: SESSION_ID, runId: RUN_ID,
    })).toEqual([]);
    expect(harness.authority.resolveToolCapability({
      pluginId: PLUGIN_ID, app: harness.manifest.app, descriptor: DESCRIPTOR,
    })).toBeNull();

    const binding = await harness.api.bindPluginAppInvocation({
      pluginId: PLUGIN_ID, appId: APP_ID, instanceId: harness.instanceId, sessionId: SESSION_ID,
    });
    const result = await harness.api.invokePluginAppTool({
      bindingId: binding.bindingId,
      nonce: binding.nonce,
      toolId: BOUND_TOOL_ID,
      arguments: { query: 'status' },
    });

    expect(result).toMatchObject({ ok: false, code: 'tool_unavailable' });
    expect(harness.connectorCalls).toHaveLength(0);
  });

  it('refuses a descriptor whose explicit plugin conflicts with its scoped server owner', async () => {
    const harness = await openHarness();
    expect((await grantOverHttp(harness.host)).status).toBe(200);

    expect(harness.authority.resolveToolCapability({
      pluginId: PLUGIN_ID,
      app: harness.manifest.app,
      descriptor: {
        ...DESCRIPTOR,
        serverName: 'plugin:com.foreign.owner:dashboard',
        pluginId: PLUGIN_ID,
      },
    })).toBeNull();
    const { pluginId: _pluginId, ...foreignDescriptor } = DESCRIPTOR;
    expect(harness.authority.resolveToolCapability({
      pluginId: PLUGIN_ID,
      app: harness.manifest.app,
      descriptor: { ...foreignDescriptor, serverName: 'plugin:com.foreign.owner:dashboard' },
    })).toBeNull();
  });

  it('refuses a capability whose mapping widened after the approval', async () => {
    const harness = await openHarness();
    expect((await grantOverHttp(harness.host)).status).toBe(200);
    expect(harness.authority.resolveToolCapability({
      pluginId: PLUGIN_ID, app: harness.manifest.app, descriptor: DESCRIPTOR,
    })).toBe(CAPABILITY);

    // The plugin now claims one more tool for the same capability. The stored
    // revision still digests the approved scope, so the grant no longer
    // covers the declared mapping.
    harness.manifest.app = declaredApp([...READ_SCOPE, WRITE_SCOPE]);

    expect(await harness.authority.resolveGrantedCapabilities({
      pluginId: PLUGIN_ID, appId: APP_ID, instanceId: harness.instanceId,
      sessionId: SESSION_ID, runId: RUN_ID,
    })).toEqual([]);
    expect(harness.authority.resolveToolCapability({
      pluginId: PLUGIN_ID, app: harness.manifest.app, descriptor: DESCRIPTOR,
    })).toBeNull();

    const binding = await harness.api.bindPluginAppInvocation({
      pluginId: PLUGIN_ID, appId: APP_ID, instanceId: harness.instanceId, sessionId: SESSION_ID,
    });
    const result = await harness.api.invokePluginAppTool({
      bindingId: binding.bindingId,
      nonce: binding.nonce,
      toolId: BOUND_TOOL_ID,
      arguments: { query: 'status' },
    });

    expect(result).toMatchObject({ ok: false, code: 'tool_unavailable' });
    expect(harness.connectorCalls).toHaveLength(0);
  });

  it('refuses a capability whose mapping narrowed after the approval', async () => {
    const harness = await openHarness();
    // The user approves a scope of two tools.
    harness.manifest.app = declaredApp([...READ_SCOPE, WRITE_SCOPE]);
    expect((await grantOverHttp(harness.host, [...READ_SCOPE, WRITE_SCOPE])).status).toBe(200);
    expect(harness.authority.resolveToolCapability({
      pluginId: PLUGIN_ID, app: harness.manifest.app, descriptor: DESCRIPTOR,
    })).toBe(CAPABILITY);

    // The plugin then claims fewer tools. The approved scope still covers the
    // declared one, but the stored revision no longer digests it, so the
    // grant needs a fresh approval.
    harness.manifest.app = declaredApp(READ_SCOPE);

    expect(await harness.authority.resolveGrantedCapabilities({
      pluginId: PLUGIN_ID, appId: APP_ID, instanceId: harness.instanceId,
      sessionId: SESSION_ID, runId: RUN_ID,
    })).toEqual([]);
    expect(harness.authority.resolveToolCapability({
      pluginId: PLUGIN_ID, app: harness.manifest.app, descriptor: DESCRIPTOR,
    })).toBeNull();

    const binding = await harness.api.bindPluginAppInvocation({
      pluginId: PLUGIN_ID, appId: APP_ID, instanceId: harness.instanceId, sessionId: SESSION_ID,
    });
    const result = await harness.api.invokePluginAppTool({
      bindingId: binding.bindingId,
      nonce: binding.nonce,
      toolId: BOUND_TOOL_ID,
      arguments: { query: 'status' },
    });

    expect(result).toMatchObject({ ok: false, code: 'tool_unavailable' });
    expect(harness.connectorCalls).toHaveLength(0);
  });
});
