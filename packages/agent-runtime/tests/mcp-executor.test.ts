import { describe, expect, it, vi } from 'vitest';
import type { PermissionMode } from '../src/authorization/permissions/types.js';
import type { RuntimeToolResult } from '../src/tools/catalog/registry.js';
import type { ToolPermissionRequest } from '../src/tools/execution/contracts.js';
import {
  createMCPToolExecutor,
  type MCPExecutorPorts,
} from '../src/tools/mcp-executor.js';

interface TestContext extends object {
  toolUseId: string;
  mode?: PermissionMode;
  appState: Record<string, unknown>;
}

function setup(decision: 'allow' | 'deny' | 'paused' = 'allow') {
  const context: TestContext = {
    toolUseId: 'call-1',
    mode: 'default',
    appState: {},
  };
  const requests: ToolPermissionRequest[] = [];
  const invoke = vi.fn(async (input: Record<string, unknown>): Promise<RuntimeToolResult> => ({
    id: 'result-1',
    name: 'search',
    result: String(input.query ?? ''),
  }));
  const ports: MCPExecutorPorts<TestContext> = {
    getToolUseId: (current) => current.toolUseId,
    getPermissionMode: (current) => current.mode,
    getAppState: (current) => current.appState,
    setAppState: (current, update) => {
      current.appState = update(current.appState);
    },
    requestPermission: vi.fn(async (_current, request) => {
      requests.push(request);
      return decision;
    }),
  };
  return { context, invoke, ports, requests };
}

describe('createMCPToolExecutor', () => {
  it.each(['bundled', 'settings'] as const)(
    'invokes trusted %s provenance without asking',
    async (source) => {
      const harness = setup();
      const executor = createMCPToolExecutor({
        toolName: 'search',
        source,
        invoke: harness.invoke,
        ports: harness.ports,
      });

      await expect(executor.execute({ query: 'water' }, undefined, harness.context)).resolves.toMatchObject({
        name: 'search',
        result: 'water',
      });
      expect(harness.ports.requestPermission).not.toHaveBeenCalled();
      expect(harness.invoke).toHaveBeenCalledOnce();
    },
  );

  it('reuses an approved tool-use marker for the same call id', async () => {
    const harness = setup();
    harness.context.appState._approvedToolUses = { 'call-1': true };
    const executor = createMCPToolExecutor({
      toolName: 'search',
      source: 'plugin',
      invoke: harness.invoke,
      ports: harness.ports,
    });

    await executor.execute({ query: 'water' }, undefined, harness.context);

    expect(harness.ports.requestPermission).not.toHaveBeenCalled();
    expect(harness.invoke).toHaveBeenCalledOnce();
  });

  it('asks with the stable invocation id and marks an allowed tool use', async () => {
    const harness = setup('allow');
    const executor = createMCPToolExecutor({
      toolName: 'search',
      source: 'plugin',
      invoke: harness.invoke,
      ports: harness.ports,
    });

    await executor.execute({ query: 'water' }, undefined, harness.context);

    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]).toMatchObject({
      id: 'call-1',
      toolName: 'search',
      toolInput: { query: 'water' },
      mode: 'generic',
      decisionReason: 'MCP tool "search" requires explicit user approval',
    });
    expect(harness.context.appState._approvedToolUses).toEqual({ 'call-1': true });
    expect(harness.invoke).toHaveBeenCalledOnce();
  });

  it('rechecks Host binding authority after approval and stops before the connector call when revoked', async () => {
    const harness = setup('allow');
    harness.ports.beforeInvoke = vi.fn(async () => false);
    const executor = createMCPToolExecutor({
      toolName: 'search',
      source: 'plugin',
      invoke: harness.invoke,
      ports: harness.ports,
    });

    const result = await executor.execute({ query: 'water' }, undefined, harness.context);

    expect(harness.ports.requestPermission).toHaveBeenCalledOnce();
    expect(harness.ports.beforeInvoke).toHaveBeenCalledOnce();
    expect(harness.invoke).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      error: true,
      result: '[MCP permission gate] Invocation authority was revoked before execution.',
    });
    expect((result as { metadata?: { reason?: string } }).metadata?.reason).toBe('authority_revoked');
  });

  it('does not invoke after a user denies', async () => {
    const harness = setup('deny');
    const executor = createMCPToolExecutor({
      toolName: 'search',
      source: 'plugin',
      invoke: harness.invoke,
      ports: harness.ports,
    });

    const result = await executor.execute({ query: 'water' }, undefined, harness.context);

    expect(result).toMatchObject({
      error: true,
      result: '[MCP permission gate] Permission denied by user',
      metadata: { source: 'plugin', gateKind: 'ask' },
    });
    expect(harness.invoke).not.toHaveBeenCalled();
  });

  it('returns the durable waiting result without invoking after a paused answer', async () => {
    const harness = setup('paused');
    const executor = createMCPToolExecutor({
      toolName: 'search',
      source: 'plugin',
      invoke: harness.invoke,
      ports: harness.ports,
    });

    const result = await executor.execute({ query: 'water' }, undefined, harness.context);

    expect(result).toMatchObject({
      error: true,
      result: expect.stringContaining('Waiting for user approval.'),
      metadata: { source: 'plugin', gateKind: 'ask' },
    });
    expect(harness.invoke).not.toHaveBeenCalled();
  });

  it('denies third-party execution when no interactive user can answer', async () => {
    const harness = setup();
    delete harness.ports.requestPermission;
    const executor = createMCPToolExecutor({
      toolName: 'search',
      source: 'unknown',
      invoke: harness.invoke,
      ports: harness.ports,
    });

    const result = await executor.execute({ query: 'water' }, undefined, harness.context);

    expect(result).toMatchObject({
      error: true,
      metadata: { source: 'unknown', gateKind: 'deny' },
    });
    expect(harness.invoke).not.toHaveBeenCalled();
  });

  it('uses session-mode fallback when the call context has no permission callback', async () => {
    const harness = setup();
    harness.ports.requestPermission = async () => undefined;
    const executor = createMCPToolExecutor({
      toolName: 'search',
      source: 'plugin',
      invoke: harness.invoke,
      ports: harness.ports,
    });

    const result = await executor.execute({ query: 'water' }, undefined, harness.context);

    expect(result).toMatchObject({ error: true, metadata: { gateKind: 'deny' } });
    expect(harness.invoke).not.toHaveBeenCalled();
  });

  it.each(['dontAsk', 'bypassPermissions'] as const)(
    'respects the no-prompt %s mode when there is no request port',
    async (mode) => {
      const harness = setup();
      harness.context.mode = mode;
      delete harness.ports.requestPermission;
      const executor = createMCPToolExecutor({
        toolName: 'search',
        source: 'plugin',
        invoke: harness.invoke,
        ports: harness.ports,
      });

      await executor.execute({ query: 'water' }, undefined, harness.context);

      expect(harness.invoke).toHaveBeenCalledOnce();
    },
  );
});
