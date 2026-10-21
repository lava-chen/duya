import Ajv from 'ajv';
import { describe, expect, it, vi } from 'vitest';
import {
  createPluginAppBridge,
  createPluginAppMcpExecutor,
  type PluginAppBridgeBinding,
  type PluginAppBridgeMessage,
} from '../src/plugin-app-bridge.js';
import type { MCPExecutorPorts } from '@duya/agent-runtime/tools/mcp-executor';
import type { RuntimeToolResult } from '@duya/agent-runtime/tools/catalog/registry';
import type { PermissionMode } from '@duya/agent-runtime/authorization/permissions/types';

interface TestContext extends object {
  toolUseId: string;
  mode: PermissionMode;
  appState: Record<string, unknown>;
}

function makeHarness(decision: 'allow' | 'deny' | 'paused' = 'allow') {
  const source = {};
  const requests: unknown[] = [];
  const invocationIds: string[] = [];
  let current = true;
  let schemaRevision = 'schema-v1';
  let sharedAppState: Record<string, unknown> = {};
  const invoke = vi.fn(async (input: Record<string, unknown>): Promise<RuntimeToolResult> => ({
    id: 'result-1',
    name: 'search',
    result: String(input.query),
  }));
  const ports: MCPExecutorPorts<TestContext> = {
    getToolUseId: (context) => context.toolUseId,
    getPermissionMode: (context) => context.mode,
    getAppState: () => sharedAppState,
    setAppState: (_context, update) => { sharedAppState = update(sharedAppState); },
    requestPermission: vi.fn(async (_context, request) => {
      requests.push(request);
      return decision;
    }),
  };
  const executor = createPluginAppMcpExecutor({
    toolName: 'search',
    source: 'plugin',
    invoke,
    ports,
    isBindingCurrent: () => current,
  });
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile({
    type: 'object',
    properties: { query: { type: 'string', minLength: 1 } },
    required: ['query'],
    additionalProperties: false,
  });
  const binding: PluginAppBridgeBinding<TestContext> = {
    pluginId: 'plugin.test',
    app: {
      appId: 'search-panel',
      entry: 'apps/search-panel.html',
      requiredCapabilities: ['mcp.read'],
      stateSchemaVersion: 2,
    },
    instanceId: 'instance-1',
    nonce: 'instance-secret',
    source,
    origin: 'null',
    sessionId: 'session-1',
    runId: 'run-1',
    grantedCapabilities: ['mcp.read'],
    isCurrent: () => current,
    tools: [{
      toolId: 'plugin:connection-1:search',
      schemaRevision,
      capabilityId: 'mcp.read',
      validateArguments: (revision, input) => revision !== schemaRevision
        ? 'schema-unavailable'
        : validate(input) ? 'valid' : 'invalid',
      executor,
      createContext: (invocationId) => {
        invocationIds.push(invocationId);
        return { toolUseId: invocationId, mode: 'default', appState: sharedAppState };
      },
    }],
  };
  const message: PluginAppBridgeMessage = {
    type: 'mcp.invoke',
    pluginId: 'plugin.test',
    appId: 'search-panel',
    instanceId: 'instance-1',
    nonce: 'instance-secret',
    sessionId: 'session-1',
    runId: 'run-1',
    stateSchemaVersion: 2,
    toolId: 'plugin:connection-1:search',
    arguments: { query: 'water' },
  };
  return {
    binding,
    message,
    source,
    invoke,
    requests,
    invocationIds,
    ports,
    setCurrent(value: boolean) { current = value; },
    setSchemaRevision(value: string) { schemaRevision = value; },
  };
}

function event(source: object, origin = 'null') {
  return { source, origin };
}

describe('Plugin App bridge kernel', () => {
  it('invokes the captured MCP executor after its existing approval path allows', async () => {
    const h = makeHarness('allow');
    const bridge = createPluginAppBridge(h.binding);

    const result = await bridge.handle(event(h.source), h.message);

    expect(result).toMatchObject({ ok: true, result: { name: 'search', result: 'water' } });
    expect(h.ports.requestPermission).toHaveBeenCalledOnce();
    expect(h.invoke).toHaveBeenCalledOnce();
    expect(h.invoke).toHaveBeenCalledWith({ query: 'water' });
  });

  it('validates and executes one snapshot without mutating the caller payload', async () => {
    const h = makeHarness('allow');
    const originalArguments = { query: '  water  ' };
    const payload = { ...h.message, arguments: originalArguments };
    h.binding.tools[0]!.validateArguments = (_revision, input) => {
      input.query = String(input.query).trim();
      return 'valid';
    };

    const result = await createPluginAppBridge(h.binding).handle(event(h.source), payload);

    expect(result).toMatchObject({ ok: true });
    expect(h.invoke).toHaveBeenCalledWith({ query: 'water' });
    expect(originalArguments).toEqual({ query: '  water  ' });
  });

  it('mints distinct invocation IDs and asks again for changed arguments across calls', async () => {
    const h = makeHarness('allow');
    const bridge = createPluginAppBridge(h.binding);

    await expect(bridge.handle(event(h.source), h.message)).resolves.toMatchObject({ ok: true });
    await expect(bridge.handle(event(h.source), {
      ...h.message,
      arguments: { query: 'land' },
    })).resolves.toMatchObject({ ok: true });

    expect(h.invocationIds).toHaveLength(2);
    expect(new Set(h.invocationIds).size).toBe(2);
    expect(h.ports.requestPermission).toHaveBeenCalledTimes(2);
    expect(h.invoke).toHaveBeenCalledTimes(2);
    expect(h.invoke.mock.calls.map(([input]) => input)).toEqual([
      { query: 'water' },
      { query: 'land' },
    ]);
  });

  it('does not reuse the first approval when a second invocation is denied', async () => {
    const h = makeHarness('allow');
    vi.mocked(h.ports.requestPermission!)
      .mockResolvedValueOnce('allow')
      .mockResolvedValueOnce('deny');
    const bridge = createPluginAppBridge(h.binding);

    await expect(bridge.handle(event(h.source), h.message)).resolves.toMatchObject({ ok: true });
    await expect(bridge.handle(event(h.source), {
      ...h.message,
      arguments: { query: 'different query' },
    })).resolves.toMatchObject({ ok: false, error: { code: 'TOOL_DENIED' } });

    expect(h.invocationIds).toHaveLength(2);
    expect(new Set(h.invocationIds).size).toBe(2);
    expect(h.ports.requestPermission).toHaveBeenCalledTimes(2);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.invoke).toHaveBeenCalledWith({ query: 'water' });
  });

  it.each([
    ['wrong source', (h: ReturnType<typeof makeHarness>) => event({}, 'null')],
    ['wrong origin', (h: ReturnType<typeof makeHarness>) => event(h.source, 'https://attacker.example')],
  ])('rejects %s before asking or invoking', async (_label, makeEvent) => {
    const h = makeHarness();
    const bridge = createPluginAppBridge(h.binding);

    await expect(bridge.handle(makeEvent(h), h.message)).resolves.toMatchObject({ ok: false });
    expect(h.ports.requestPermission).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('rejects an invalid Host binding without an instance nonce', () => {
    const h = makeHarness();
    h.binding.nonce = '   ';

    expect(() => createPluginAppBridge(h.binding)).toThrow('non-empty instance nonce');
  });

  it.each([
    ['foreign plugin', { pluginId: 'plugin.other' }],
    ['foreign App definition', { appId: 'other-panel' }],
    ['foreign instance', { instanceId: 'instance-other' }],
    ['foreign session', { sessionId: 'session-other' }],
    ['foreign run', { runId: 'run-other' }],
    ['wrong state schema version', { stateSchemaVersion: 3 }],
    ['wrong nonce', { nonce: 'forged' }],
    ['undeclared method', { type: 'mcp.delete' }],
    ['undeclared tool', { toolId: 'plugin:connection-1:delete' }],
    ['extra payload authority', { permissionMode: 'bypassPermissions' }],
  ])('rejects %s before invoking', async (_label, patch) => {
    const h = makeHarness();
    const bridge = createPluginAppBridge(h.binding);

    await expect(bridge.handle(event(h.source), { ...h.message, ...patch })).resolves.toMatchObject({ ok: false });
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('rejects malformed arguments through the captured catalog schema validator', async () => {
    const h = makeHarness();
    const bridge = createPluginAppBridge(h.binding);

    await expect(bridge.handle(event(h.source), {
      ...h.message,
      arguments: { query: 123, injected: true },
    })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS' } });
    expect(h.ports.requestPermission).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('fails closed when the tool capability was requested but not granted', async () => {
    const h = makeHarness();
    h.binding.grantedCapabilities = [];

    await expect(createPluginAppBridge(h.binding).handle(event(h.source), h.message))
      .resolves.toMatchObject({ ok: false, error: { code: 'CAPABILITY_DENIED' } });
    expect(h.ports.requestPermission).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('fails closed when no host-injected validator is bound to the descriptor', async () => {
    const h = makeHarness();
    const tool = h.binding.tools[0];
    if (tool) tool.validateArguments = undefined;

    await expect(createPluginAppBridge(h.binding).handle(event(h.source), h.message))
      .resolves.toMatchObject({ ok: false, error: { code: 'SCHEMA_UNAVAILABLE' } });
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it.each(['deny', 'paused'] as const)('does not invoke after Runtime permission returns %s', async (decision) => {
    const h = makeHarness(decision);
    const bridge = createPluginAppBridge(h.binding);

    const result = await bridge.handle(event(h.source), h.message);

    expect(result).toMatchObject({ ok: false, error: { code: 'TOOL_DENIED' } });
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('rechecks the trusted instance binding after approval, inside the Runtime invoker guard', async () => {
    const h = makeHarness('allow');
    vi.mocked(h.ports.requestPermission!).mockImplementationOnce(async () => {
      h.setCurrent(false);
      return 'allow';
    });
    const bridge = createPluginAppBridge(h.binding);

    const result = await bridge.handle(event(h.source), h.message);

    expect(result).toMatchObject({ ok: false, error: { code: 'BINDING_REVOKED' } });
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('fails closed when the instance is stale or the captured schema revision changed', async () => {
    const stale = makeHarness();
    stale.setCurrent(false);
    await expect(createPluginAppBridge(stale.binding).handle(event(stale.source), stale.message))
      .resolves.toMatchObject({ ok: false, error: { code: 'BINDING_REVOKED' } });

    const schemaChanged = makeHarness();
    schemaChanged.setSchemaRevision('schema-v2');
    await expect(createPluginAppBridge(schemaChanged.binding).handle(event(schemaChanged.source), schemaChanged.message))
      .resolves.toMatchObject({ ok: false, error: { code: 'SCHEMA_UNAVAILABLE' } });
    expect(schemaChanged.invoke).not.toHaveBeenCalled();
  });
});
