import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../src/tools/catalog/registry.js';
import { createMCPToolExecutor } from '../../src/tools/mcp-executor.js';
import { createToolInvokeDispatcherFromRegistry } from '../../src/tools/discovery/dispatcherFromRegistry.js';
import { ToolInvokeTool } from '../../src/tools/discovery/ToolInvokeTool.js';
import type { DiscoveryToolContext } from '../../src/tools/discovery/context.js';
import type { ToolPermissionDecision, ToolPermissionRequest } from '../../src/tools/execution/contracts.js';
import { buildPermissions } from '../../src/authorization/permission-gate.js';
import { normalizeCanUseToolDecision } from '../../src/authorization/tool-invoke-decision.js';
import type { ToolInvokeDispatcherDeps } from '../../src/tools/discovery/dispatcherFromRegistry.js';

function harness(answer: ToolPermissionDecision) {
  const name = 'mcp__thirdparty__write';
  let appState: Record<string, unknown> = { toolPermissionContext: { mode: 'default' } };
  const requestPermission = vi.fn(async (_request: ToolPermissionRequest) => answer);
  const context: DiscoveryToolContext = {
    toolUseId: 'model-call-1',
    options: {},
    getAppState: () => appState,
    setAppState: (update) => { appState = update(appState); },
    requestPermission,
  };
  const invoke = vi.fn(async (input: Record<string, unknown>) => ({ id: 'mcp-result', name, result: String(input.value) }));
  const executor = createMCPToolExecutor<DiscoveryToolContext>({
    toolName: name,
    source: 'plugin',
    invoke,
    ports: {
      getToolUseId: (active) => active.toolUseId,
      getPermissionMode: () => 'default',
      getAppState: (active) => active.getAppState?.(),
      setAppState: (active, update) => active.setAppState?.(update),
      requestPermission: (active, request) => active.requestPermission?.({ ...request, mode: 'generic' }) ?? Promise.resolve(undefined),
    },
  });
  const registry = new ToolRegistry();
  registry.register({ name, description: 'Write a third party value', input_schema: {
    type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false,
  } }, executor, { exposure: 'deferred', source: { kind: 'mcp', id: 'thirdparty' } });
  const snapshot = registry.snapshot(new Map());
  const entry = snapshot.catalogEntries[0];
  if (!entry) throw new Error('Missing deferred test tool');
  const checkPermission = vi.fn(async () => ({ behavior: 'ask' as const }));
  const dispatcherDeps: ToolInvokeDispatcherDeps = { registry, getSnapshot: () => snapshot, checkPermission, contextProvider: () => ({ ...context, toolUseId: 'turn-level-placeholder' }) };
  const dispatcher = createToolInvokeDispatcherFromRegistry(dispatcherDeps);
  const metaTool = new ToolInvokeTool();
  metaTool.setDispatcherForContext(context, dispatcher);
  return { context, metaTool, dispatcherDeps, toolId: entry.toolId, checkPermission, requestPermission, invoke, getAppState: () => appState };
}

describe('deferred MCP approval through the real meta tool and source guard', () => {
  it('reuses a consumed persisted grant across the gate, meta dispatcher and MCP guard without another prompt', async () => {
    const h = harness('deny');
    let available = true;
    const consumeApprovedEffect = vi.fn(async () => {
      const granted = available;
      available = false;
      return granted;
    });
    const { canUseTool } = buildPermissions({
      warn: vi.fn(), getPermissionMode: () => 'default',
      alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {}, additionalWorkingDirectories: new Map(),
      getAbortController: () => null, llmClient: {}, model: 'test-model', getMessages: () => [],
      hasPermissionsToUseTool: async () => ({ behavior: 'ask' }), getModeCoordinator: () => undefined,
    }, { workingDirectory: null, approval: { consumeApprovedEffect, alwaysAllowTools: new Set() } });
    const input = { value: 'persisted approval' };
    const id = `model-call-1:deferred:${h.toolId}`;
    expect(await canUseTool('mcp__thirdparty__write', input, id)).toMatchObject({ allowed: true, userApproved: true });
    h.dispatcherDeps.checkPermission = async (name, args, callId) => normalizeCanUseToolDecision(await canUseTool(name, args, callId));
    const result = await h.metaTool.execute({ tool_id: h.toolId, arguments: input }, undefined, h.context);
    expect(result.error).toBeUndefined();
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.invoke).toHaveBeenCalledWith(input);
    expect(consumeApprovedEffect).toHaveBeenCalledTimes(1);
    expect(h.requestPermission).not.toHaveBeenCalled();
  });

  it('executes after one approval using the model call identity rather than a turn placeholder', async () => {
    const h = harness('allow');
    const result = await h.metaTool.execute({ tool_id: h.toolId, arguments: { value: 'approved' } }, undefined, h.context);
    const id = `model-call-1:deferred:${h.toolId}`;
    expect(result.error).toBeUndefined();
    expect(result.result).toBe('approved');
    expect(h.requestPermission).toHaveBeenCalledTimes(1);
    expect(h.requestPermission.mock.calls[0]?.[0]).toMatchObject({ id, toolInput: { value: 'approved' } });
    expect(h.checkPermission).toHaveBeenCalledWith('mcp__thirdparty__write', { value: 'approved' }, id);
    expect(h.getAppState()._approvedToolUses).toEqual({ [id]: true });
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });

  it.each(['deny', 'paused'] as const)('does not execute or record approval when the user answers %s', async (answer) => {
    const h = harness(answer);
    const result = await h.metaTool.execute({ tool_id: h.toolId, arguments: { value: 'blocked' } }, undefined, h.context);
    expect(result.error).toBe(true);
    expect(result.metadata?.errorCode).toBe(answer === 'deny' ? 'TOOL_PERMISSION_DENIED' : 'TOOL_APPROVAL_PENDING');
    expect(h.requestPermission).toHaveBeenCalledTimes(1);
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.getAppState()).not.toHaveProperty('_approvedToolUses');
  });
});
