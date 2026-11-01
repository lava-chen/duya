/**
 * W2 slice A differential — direct-path approval-window parity (plan:
 * 2026-10-31 tool surface & harness convergence, W1 residuals / F18).
 *
 * The routed path re-resolves the live entry after approval (#558). On the
 * DIRECT path the approval window lives INSIDE the MCP executor: an `ask`
 * decision parks the call on `ports.requestPermission` while the executor
 * still holds its generation-captured `invoke` closure. A replace-set that
 * lands in that window would otherwise execute the pre-replacement
 * connection — the exact "approved A, executed B" signature. These tests pin
 * the generation-currency gate:
 *
 *   1. a registration replaced mid-approval fails with the named
 *      `authority_revoked` gate error and never invokes the stale closure;
 *   2. the control — no replacement — executes normally;
 *   3. the routed path (dispatcher → live entry executor) still passes the
 *      same check, because the dispatcher resolves the live executor;
 *   4. approval-wait cancellation: discarding the executor while a
 *      permission request is pending terminates the drain and never invokes
 *      the target — identically for a routed call and a direct MCP call.
 */

import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '../../src/tools/catalog/registry.js';
import { createMCPToolExecutor } from '../../src/tools/mcp-executor.js';
import { ToolInvokeTool } from '../../src/tools/discovery/ToolInvokeTool.js';
import { createToolInvokeDispatcherFromRegistry } from '../../src/tools/discovery/dispatcherFromRegistry.js';
import type { DiscoveryToolContext } from '../../src/tools/discovery/context.js';
import { createRealTargetResolver } from '../../src/tools/discovery/real-target.js';
import type { ExecutorConfig, ToolExecutionRegistry } from '../../src/tools/execution/index.js';
import { StreamingToolExecutor } from '../../src/tools/execution/StreamingToolExecutor.js';
import type { ToolExecutionPorts } from '../../src/tools/execution/ports.js';
import type { PermissionMode } from '../../src/authorization/permissions/types.js';

interface GateContext {
  toolUseId?: string;
  getAppState?: () => Record<string, unknown>;
  setAppState?: (update: (previous: Record<string, unknown>) => Record<string, unknown>) => void;
}

function makePorts(overrides: Record<string, unknown>): {
  getToolUseId: (context: GateContext) => string | undefined;
  getPermissionMode: () => PermissionMode | undefined;
  getAppState: (context: GateContext) => Record<string, unknown> | undefined;
  setAppState: (context: GateContext, update: (previous: Record<string, unknown>) => Record<string, unknown>) => void;
} & Record<string, unknown> {
  return {
    getToolUseId: (context) => context.toolUseId,
    getPermissionMode: () => undefined,
    getAppState: (context) => context.getAppState?.() ?? {},
    setAppState: (context, update) => { context.setAppState?.(update); },
    ...overrides,
  };
}

function makeDefinition(name: string): { name: string; description: string; input_schema: Record<string, unknown> } {
  return { name, description: 'w2 parity probe', input_schema: { type: 'object', properties: {} } };
}

describe('W2 direct-path generation currency (F18 parity)', () => {
  it('a registration replaced mid-approval fails with authority_revoked and never invokes stale', async () => {
    const registry = new ToolRegistry();
    let invoked = 0;
    const invoke = async () => { invoked += 1; return { id: 'r', name: 'mcp__third__tool', result: 'ran' }; };
    const executor1 = createMCPToolExecutor({
      toolName: 'mcp__third__tool',
      source: 'plugin',
      invoke,
      ports: makePorts({
        requestPermission: async () => {
          // The replace-set lands WHILE approval is pending — same shape the
          // production apply state machine commits (replaceByOwner('mcp', …)).
          registry.replaceByOwner('mcp', [
            {
              key: 'mcp__third__tool',
              definition: makeDefinition('mcp__third__tool'),
              executor: createMCPToolExecutor({
                toolName: 'mcp__third__tool',
                source: 'plugin',
                invoke,
                ports: makePorts({}),
              }) as never,
              meta: { exposure: 'eager', source: { kind: 'mcp', id: 'thirdparty' } },
            },
          ]);
          return 'allow' as const;
        },
        isExecutorCurrent: (toolName, executorRef) => registry.getExecutor(toolName) === executorRef,
      }),
    });
    registry.registerWithKey(
      'mcp__third__tool',
      makeDefinition('mcp__third__tool'),
      executor1 as never,
      'mcp',
      { exposure: 'eager', source: { kind: 'mcp', id: 'thirdparty' } },
    );

    const result = await executor1.execute({}, undefined, { toolUseId: 'call-1' } as GateContext);
    // The stale generation is refused with the named gate error; the captured
    // invoke closure never runs.
    expect(result.error).toBe(true);
    expect((result.metadata as { reason?: string }).reason).toBe('authority_revoked');
    expect(invoked).toBe(0);
  });

  it('control: no replacement executes normally through the same gate', async () => {
    const registry = new ToolRegistry();
    let invoked = 0;
    const invoke = async () => { invoked += 1; return { id: 'r', name: 'mcp__third__tool', result: 'ran' }; };
    const executor = createMCPToolExecutor({
      toolName: 'mcp__third__tool',
      source: 'plugin',
      invoke,
      ports: makePorts({
        requestPermission: async () => 'allow' as const,
        isExecutorCurrent: (toolName, executorRef) => registry.getExecutor(toolName) === executorRef,
      }),
    });
    registry.registerWithKey(
      'mcp__third__tool',
      makeDefinition('mcp__third__tool'),
      executor as never,
      'mcp',
      { exposure: 'eager', source: { kind: 'mcp', id: 'thirdparty' } },
    );

    const result = await executor.execute({}, undefined, { toolUseId: 'call-1' } as GateContext);
    expect(result.error).toBeUndefined();
    expect(invoked).toBe(1);
  });

  it('the routed path resolves the live executor and passes the same gate', async () => {
    const registry = new ToolRegistry();
    let invoked = 0;
    const invoke = async () => { invoked += 1; return { id: 'r', name: 'mcp__third__probe', result: 'ran' }; };
    const executor = createMCPToolExecutor({
      toolName: 'mcp__third__probe',
      source: 'plugin',
      invoke,
      ports: makePorts({
        // The executor's own ask gate (source 'plugin' → decideMcpSource
        // 'ask') resolves through the approval mark the dispatcher's unified
        // decision would leave; the standalone test grants it directly.
        requestPermission: async () => 'allow' as const,
        isExecutorCurrent: (toolName, executorRef) => registry.getExecutor(toolName) === executorRef,
      }),
    });
    registry.registerWithKey(
      'mcp__third__probe',
      makeDefinition('mcp__third__probe'),
      executor as never,
      'mcp',
      { exposure: 'deferred', source: { kind: 'mcp', id: 'thirdparty' } },
    );
    const invokeTool = new ToolInvokeTool();
    registry.register(invokeTool.toTool(), invokeTool as never, { exposure: 'eager' });
    const appState: Record<string, unknown> = {};
    const turnContext = {
      abortController: new AbortController(),
      workingDirectory: '/tmp/w2',
      sessionId: 'w2-parity',
      getAppState: () => appState,
      options: { sessionId: 'w2-parity' },
    } as unknown as DiscoveryToolContext;
    const snapshot = registry.snapshot(new Map());
    const entry = snapshot.catalogEntries.find((e) => e.internalName === 'mcp__third__probe')!;
    const dispatcher = createToolInvokeDispatcherFromRegistry({
      registry,
      getSnapshot: () => snapshot,
      checkPermission: async () => ({ behavior: 'allow' as const }),
      contextProvider: () => turnContext,
    } as never);
    invokeTool.setDispatcherForContext(turnContext, dispatcher);

    // The dispatcher resolves the LIVE entry, so its executor is current and
    // the gate lets it through — routed parity with the direct control.
    const outcome = await dispatcher.dispatch({ tool_id: entry.toolId, arguments: {} }, turnContext);
    expect(outcome.error).toBeUndefined();
    expect(invoked).toBe(1);
  });
});

describe('W2 approval-wait cancel parity', () => {
  function makeExecutorPorts(): ToolExecutionPorts<Record<string, unknown>> {
    return {
      readSession: (context) => ({
        abortController: context.abortController,
        workingDirectory: context.workingDirectory,
        sessionId: context.sessionId,
      }),
      getAppState: (context) => context.getAppState?.() ?? {},
      isInvocationApproved: (context, invocationId) =>
        (context.getAppState?.() as Record<string, unknown> | undefined)?.[invocationId] === true,
      markInvocationApproved: (context, invocationId) => {
        const state = context.getAppState?.();
        if (state) state[invocationId] = true;
      },
      createToolContext: (context, input) => ({ ...context, ...input }),
    };
  }

  function makeTurnContext(): Record<string, unknown> {
    const appState: Record<string, unknown> = {};
    return {
      abortController: new AbortController(),
      workingDirectory: '/tmp/w2',
      sessionId: 'w2-cancel',
      getAppState: () => appState,
      options: { sessionId: 'w2-cancel' },
    };
  }

  async function drain(executor: StreamingToolExecutor<Record<string, unknown>>): Promise<number> {
    let toolResults = 0;
    for await (const update of executor.getRemainingResults()) {
      const message = update.message as { role?: string } | undefined;
      if (message?.role === 'tool') toolResults += 1;
    }
    return toolResults;
  }

  it('discarding while a routed approval is pending terminates the drain without executing the target', async () => {
    const registry = new ToolRegistry();
    let invoked = 0;
    const executor = createMCPToolExecutor({
      toolName: 'mcp__third__slow',
      source: 'plugin',
      invoke: async () => { invoked += 1; return { id: 'r', name: 'mcp__third__slow', result: 'ran' }; },
      ports: makePorts({}),
    });
    registry.registerWithKey(
      'mcp__third__slow',
      makeDefinition('mcp__third__slow'),
      executor as never,
      'mcp',
      { exposure: 'deferred', source: { kind: 'mcp', id: 'thirdparty' } },
    );
    const invokeTool = new ToolInvokeTool();
    registry.register(invokeTool.toTool(), invokeTool as never, { exposure: 'eager' });
    const turnContext = makeTurnContext();
    const snapshot = registry.snapshot(new Map());
    const entry = snapshot.catalogEntries.find((e) => e.internalName === 'mcp__third__slow')!;
    const dispatcher = createToolInvokeDispatcherFromRegistry({
      registry,
      getSnapshot: () => snapshot,
      checkPermission: async () => ({ behavior: 'ask' as const }),
      contextProvider: () => turnContext as unknown as DiscoveryToolContext,
    } as never);
    invokeTool.setDispatcherForContext(turnContext as never, dispatcher);

    const streamExecutor = new StreamingToolExecutor<Record<string, unknown>>(
      registry as unknown as ToolExecutionRegistry,
      async () => true,
      turnContext as never,
      undefined as unknown as ExecutorConfig,
      makeExecutorPorts(),
    );
    streamExecutor.addTool({ id: 'invoke-cancel', name: 'tool_invoke', input: { tool_id: entry.toolId, arguments: {} } });
    const draining = drain(streamExecutor);
    await new Promise((resolve) => setTimeout(resolve, 40));
    streamExecutor.discard();
    const toolResults = await draining;
    expect(toolResults).toBeGreaterThanOrEqual(1);
    expect(invoked).toBe(0);
  });

  it('discarding while a direct MCP approval is pending behaves identically', async () => {
    const registry = new ToolRegistry();
    let invoked = 0;
    const executor = createMCPToolExecutor({
      toolName: 'mcp__third__slow2',
      source: 'plugin',
      invoke: async () => { invoked += 1; return { id: 'r', name: 'mcp__third__slow2', result: 'ran' }; },
      ports: makePorts({}),
    });
    registry.registerWithKey(
      'mcp__third__slow2',
      makeDefinition('mcp__third__slow2'),
      executor as never,
      'mcp',
      { exposure: 'eager', source: { kind: 'mcp', id: 'thirdparty' } },
    );
    const turnContext = makeTurnContext();
    const streamExecutor = new StreamingToolExecutor<Record<string, unknown>>(
      registry as unknown as ToolExecutionRegistry,
      async () => true,
      turnContext as never,
      undefined as unknown as ExecutorConfig,
      makeExecutorPorts(),
    );
    streamExecutor.addTool({ id: 'direct-cancel', name: 'mcp__third__slow2', input: {} });
    const draining = drain(streamExecutor);
    await new Promise((resolve) => setTimeout(resolve, 40));
    streamExecutor.discard();
    const toolResults = await draining;
    expect(toolResults).toBeGreaterThanOrEqual(1);
    expect(invoked).toBe(0);
  });
});
