import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionLedger } from '@duya/data/core-stores';
import { createMCPToolExecutor } from '@duya/agent-runtime/tools/mcp-executor';
import type { PluginAppInstanceRecord, PermissionRequestEvent } from '@duya/agent-protocol';
import { createHostPermissionRequestApi } from '../src/permission-request-api.js';
import { WorkerPermissionRequests } from '../src/worker-permission-requests.js';
import { createWorkerMCPExecutorPorts } from '../src/connector-services/worker-permission-binding.js';
import {
  createHostPluginAppInvocationApi,
  type HostPluginAppInvocationAuthority,
} from '../src/local-plugin-app-invocation-api.js';
import { WorkerSession } from '../src/worker-session-runtime.js';
import type { ToolUseContext } from '../src/worker-run-contracts.js';

const SESSION_ID = 'session-plugin-app';
const RUN_ID = 'run-plugin-app';
const PLUGIN_ID = 'com.duya.sample';
const APP_ID = 'counter';
const CAPABILITY = 'mcp:dashboard.read';
const TOOL_ID = 'mcp__plugin:com.duya.sample:dashboard__read';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface Harness {
  readonly session: WorkerSession;
  readonly api: ReturnType<typeof createHostPluginAppInvocationApi>;
  readonly connectorCalls: Array<Record<string, unknown>>;
  readonly state: {
    epoch: number;
    grants: string[];
    mappingValid: boolean;
    instanceStatus: PluginAppInstanceRecord['status'];
  };
  readonly pendingApprovals: () => Promise<readonly { id: string }[]>;
  readonly resolveApproval: (id: string, allow: boolean) => Promise<void>;
}

function buildHarness(): Harness {
  const database = new Database(':memory:');
  for (const migration of PermissionLedger.migrations) migration.up(database);
  const records = createHostPermissionRequestApi({ permissions: new PermissionLedger(database) });
  cleanups.push(() => database.close());

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

  const state = {
    epoch: 1,
    grants: [CAPABILITY],
    mappingValid: true,
    instanceStatus: 'active' as PluginAppInstanceRecord['status'],
  };

  const pendingResolvers = new Map<string, (decision: 'allow' | 'deny') => void>();
  const broker = new WorkerPermissionRequests(
    records,
    (_sessionId, message) => {
      const id = typeof message.id === 'string' ? message.id : '';
      const resolver = pendingResolvers.get(id);
      if (!resolver) return false;
      resolver(message.decision === 'allow' || message.decision === 'allow_once' || message.decision === 'allow_for_session'
        ? 'allow'
        : 'deny');
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

  const instance: PluginAppInstanceRecord = {
    instanceId: 'instance-1',
    pluginId: PLUGIN_ID,
    appId: APP_ID,
    stateSchemaVersion: 1,
    state: {},
    revision: 1,
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const authority: HostPluginAppInvocationAuthority = {
    resolveApp: async (pluginId, appId) =>
      pluginId === PLUGIN_ID && appId === APP_ID
        ? { appId: APP_ID, entry: 'apps/counter.html', requiredCapabilities: [CAPABILITY], stateSchemaVersion: 1 }
        : null,
    resolveGrantedCapabilities: async () => [...state.grants],
    resolveToolCapability: ({ descriptor }) =>
      state.mappingValid &&
      descriptor.source === 'plugin' &&
      descriptor.serverName === 'dashboard' &&
      descriptor.toolName === 'read' &&
      descriptor.pluginId === PLUGIN_ID
        ? CAPABILITY
        : null,
  };

  const caller = { sessionId: SESSION_ID, runId: RUN_ID, epoch: state.epoch };
  const api = createHostPluginAppInvocationApi({
    getInstance: async (instanceId) => {
      if (instanceId !== instance.instanceId) return null;
      return { ...instance, status: state.instanceStatus };
    },
    authority,
    currentRun: async () => ({ runId: RUN_ID, epoch: state.epoch }),
    isCurrentRun: async (_sessionId, runId, epoch) => runId === RUN_ID && epoch === state.epoch,
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
    session,
    api,
    connectorCalls,
    state,
    pendingApprovals: async () => records.listPendingPermissionRequests(SESSION_ID),
    resolveApproval: async (id, allow) => {
      await broker.resolvePermissionRequest(id, {
        status: allow ? 'allow' : 'deny',
        decision: allow ? 'allow_once' : 'deny',
      });
    },
  };
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

describe('Plugin App invocation against a live worker catalog', () => {
  it('describes plugin-owned MCP tools from the real registry', () => {
    const harness = buildHarness();

    const tools = harness.session.describePluginAppMcpTools(RUN_ID);

    expect(tools).toHaveLength(1);
    expect(tools[0]!.toolId).toBe('plugin:com.duya.sample%3Adashboard:read');
    expect(tools[0]!.descriptor).toEqual({
      source: 'plugin',
      serverName: 'dashboard',
      toolName: 'read',
      connectionId: 'dashboard',
      pluginId: PLUGIN_ID,
    });
  });

  it('runs the connector exactly once when the user approves', async () => {
    const harness = buildHarness();
    const binding = await harness.api.bindPluginAppInvocation({
      pluginId: PLUGIN_ID, appId: APP_ID, instanceId: 'instance-1', sessionId: SESSION_ID,
    });

    const invocation = harness.api.invokePluginAppTool({
      bindingId: binding.bindingId,
      nonce: binding.nonce,
      toolId: 'plugin:com.duya.sample%3Adashboard:read',
      arguments: { query: 'status' },
    });
    const approvalId = await waitForPendingApproval(harness);
    await harness.resolveApproval(approvalId, true);
    const result = await invocation;

    expect(result).toMatchObject({ ok: true });
    expect(harness.connectorCalls).toEqual([{ query: 'status' }]);
  });

  it('never reaches the connector when the user denies', async () => {
    const harness = buildHarness();
    const binding = await harness.api.bindPluginAppInvocation({
      pluginId: PLUGIN_ID, appId: APP_ID, instanceId: 'instance-1', sessionId: SESSION_ID,
    });

    const invocation = harness.api.invokePluginAppTool({
      bindingId: binding.bindingId,
      nonce: binding.nonce,
      toolId: 'plugin:com.duya.sample%3Adashboard:read',
      arguments: { query: 'status' },
    });
    const approvalId = await waitForPendingApproval(harness);
    await harness.resolveApproval(approvalId, false);
    const result = await invocation;

    expect(result).toMatchObject({ ok: false, code: 'tool_denied' });
    expect(harness.connectorCalls).toHaveLength(0);
  });

  it('drops the grant revoked during the approval wait', async () => {
    const harness = buildHarness();
    const binding = await harness.api.bindPluginAppInvocation({
      pluginId: PLUGIN_ID, appId: APP_ID, instanceId: 'instance-1', sessionId: SESSION_ID,
    });

    const invocation = harness.api.invokePluginAppTool({
      bindingId: binding.bindingId,
      nonce: binding.nonce,
      toolId: 'plugin:com.duya.sample%3Adashboard:read',
      arguments: { query: 'status' },
    });
    const approvalId = await waitForPendingApproval(harness);
    harness.state.grants = [];
    await harness.resolveApproval(approvalId, true);
    const result = await invocation;

    expect(result).toMatchObject({ ok: false, code: 'binding_revoked' });
    expect(harness.connectorCalls).toHaveLength(0);
  });

  it('drops the tool whose canonical mapping flipped during the approval wait', async () => {
    const harness = buildHarness();
    const binding = await harness.api.bindPluginAppInvocation({
      pluginId: PLUGIN_ID, appId: APP_ID, instanceId: 'instance-1', sessionId: SESSION_ID,
    });

    const invocation = harness.api.invokePluginAppTool({
      bindingId: binding.bindingId,
      nonce: binding.nonce,
      toolId: 'plugin:com.duya.sample%3Adashboard:read',
      arguments: { query: 'status' },
    });
    const approvalId = await waitForPendingApproval(harness);
    harness.state.mappingValid = false;
    await harness.resolveApproval(approvalId, true);
    const result = await invocation;

    expect(result).toMatchObject({ ok: false, code: 'binding_revoked' });
    expect(harness.connectorCalls).toHaveLength(0);
  });

  it('drops the attempt that went stale during the approval wait', async () => {
    const harness = buildHarness();
    const binding = await harness.api.bindPluginAppInvocation({
      pluginId: PLUGIN_ID, appId: APP_ID, instanceId: 'instance-1', sessionId: SESSION_ID,
    });

    const invocation = harness.api.invokePluginAppTool({
      bindingId: binding.bindingId,
      nonce: binding.nonce,
      toolId: 'plugin:com.duya.sample%3Adashboard:read',
      arguments: { query: 'status' },
    });
    const approvalId = await waitForPendingApproval(harness);
    harness.state.epoch = 2;
    await harness.resolveApproval(approvalId, true);
    const result = await invocation;

    expect(result).toMatchObject({ ok: false, code: 'binding_revoked' });
    expect(harness.connectorCalls).toHaveLength(0);
  });

  it('refuses an instance that is no longer active', async () => {
    const harness = buildHarness();
    const binding = await harness.api.bindPluginAppInvocation({
      pluginId: PLUGIN_ID, appId: APP_ID, instanceId: 'instance-1', sessionId: SESSION_ID,
    });
    harness.state.instanceStatus = 'revoked';

    const result = await harness.api.invokePluginAppTool({
      bindingId: binding.bindingId,
      nonce: binding.nonce,
      toolId: 'plugin:com.duya.sample%3Adashboard:read',
      arguments: { query: 'status' },
    });

    expect(result).toMatchObject({ ok: false, code: 'instance_inactive' });
    expect(harness.connectorCalls).toHaveLength(0);
  });

  it('refuses a capability that the manifest never requested', async () => {
    const harness = buildHarness();
    harness.state.grants = ['mcp:other.write'];

    const binding = await harness.api.bindPluginAppInvocation({
      pluginId: PLUGIN_ID, appId: APP_ID, instanceId: 'instance-1', sessionId: SESSION_ID,
    });

    const result = await harness.api.invokePluginAppTool({
      bindingId: binding.bindingId,
      nonce: binding.nonce,
      toolId: 'plugin:com.duya.sample%3Adashboard:read',
      arguments: { query: 'status' },
    });

    expect(result).toMatchObject({ ok: false, code: 'tool_unavailable' });
    expect(harness.connectorCalls).toHaveLength(0);
  });
});
