/**
 * W1 approval / cancel / result-correlation differential (plan:
 * 2026-10-31 tool surface & harness convergence, W1 / F18 / F23).
 *
 *   - APPROVAL: deny and paused never reach the target; a target removed
 *     during the permission window fails with TOOL_NOT_FOUND (extends the
 *     F18 binding suite to removal, complementing its schema-change case).
 *   - CANCEL/TIMEOUT: queued routed calls are dropped by discard() exactly
 *     like queued direct calls; a wrapper exceeding the executor's
 *     per-tool timeout is rejected by the same race as a direct call, and
 *     an uncooperative target orphans identically on both paths.
 *   - RESULT CORRELATION (F23): the wrapper preserves the provider call id
 *     and forwards the target's metadata/images/pendingContext additively.
 */

import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '../../src/tools/catalog/registry.js';
import { ToolInvokeTool, type ToolInvokeOutcome } from '../../src/tools/discovery/ToolInvokeTool.js';
import { createToolInvokeDispatcherFromRegistry } from '../../src/tools/discovery/dispatcherFromRegistry.js';
import { createRealTargetResolver } from '../../src/tools/discovery/real-target.js';
import type { DiscoveryToolContext } from '../../src/tools/discovery/context.js';
import { drain, makePipeline, makeProbe, registerDeferred, registerInvokeRouter, sleep, wireDispatcher } from './w1-diff-harness.js';
import type { Probe, ProbeContext } from './w1-diff-harness.js';

function makeTurnContext(): ProbeContext {
  const appState: Record<string, unknown> = {};
  return {
    abortController: new AbortController(),
    workingDirectory: '/tmp/w1-diff',
    sessionId: 'w1-approval',
    getAppState: () => appState,
    options: { sessionId: 'w1-approval' },
  };
}

describe('W1 approval semantics', () => {
  function makeApprovalHarness(
    checkPermission: () => Promise<{ behavior: 'allow' | 'deny' | 'ask'; message?: string }>,
  ): { registry: ToolRegistry; invokeTool: ToolInvokeTool; turnContext: ProbeContext; toolId: string; probe: Probe } {
    const registry = new ToolRegistry();
    const probe = makeProbe('mcp__w1__gated', 10);
    registerDeferred(registry, probe);
    const invokeTool = new ToolInvokeTool();
    registerInvokeRouter(registry, invokeTool);
    const turnContext = makeTurnContext();
    const toolId = wireDispatcher(registry, invokeTool, turnContext, { checkPermission });
    return { registry, invokeTool, turnContext, toolId, probe };
  }

  it('deny decision never executes the target', async () => {
    const { invokeTool, turnContext, toolId, probe } = makeApprovalHarness(async () => ({ behavior: 'deny' as const, message: 'nope' }));
    const result = await invokeTool.execute(
      { tool_id: toolId, arguments: {} },
      undefined,
      turnContext as unknown as DiscoveryToolContext,
    );
    expect(result.error).toBe(true);
    expect((result.metadata as { errorCode?: string } | undefined)?.errorCode).toBe('TOOL_PERMISSION_DENIED');
    expect(probe.state.started).toBe(0);
  });

  it('paused decision surfaces TOOL_APPROVAL_PENDING without executing the target', async () => {
    const { invokeTool, turnContext, toolId, probe } = makeApprovalHarness(async () => ({ behavior: 'ask' as const }));
    const contextWithPause = {
      ...turnContext,
      requestPermission: async () => 'paused' as const,
    } as unknown as DiscoveryToolContext;
    const result = await invokeTool.execute(
      { tool_id: toolId, arguments: {} },
      undefined,
      contextWithPause,
    );
    expect(result.error).toBe(true);
    expect((result.metadata as { errorCode?: string } | undefined)?.errorCode).toBe('TOOL_APPROVAL_PENDING');
    expect(probe.state.started).toBe(0);
  });

  it('a target removed during the permission window fails with TOOL_NOT_FOUND and never executes', async () => {
    const registry = new ToolRegistry();
    const probe = makeProbe('mcp__w1__vanish', 10);
    registerDeferred(registry, probe);
    const invokeTool = new ToolInvokeTool();
    registerInvokeRouter(registry, invokeTool);
    const turnContext = makeTurnContext();
    const toolId = wireDispatcher(registry, invokeTool, turnContext, {
      // The removal lands WHILE approval is pending: the pre-permission
      // live check passed, the post-decision re-check (F18) catches it.
      checkPermission: async () => {
        registry.unregister('mcp__w1__vanish');
        return { behavior: 'allow' as const };
      },
    });

    const result = await invokeTool.execute(
      { tool_id: toolId, arguments: {} },
      undefined,
      turnContext as unknown as DiscoveryToolContext,
    );
    expect(result.error).toBe(true);
    expect((result.metadata as { errorCode?: string } | undefined)?.errorCode).toBe('TOOL_NOT_FOUND');
    expect(probe.state.started).toBe(0);
  });
});

describe('W1 cancel and timeout parity', () => {
  it('queued routed calls are dropped by discard() exactly like queued direct calls', async () => {
    const registry = new ToolRegistry();
    const probe = makeProbe('mcp__w1__slow', 60);
    registerDeferred(registry, probe);
    const invokeTool = new ToolInvokeTool();
    registerInvokeRouter(registry, invokeTool);
    const turnContext = makeTurnContext();
    const toolId = wireDispatcher(registry, invokeTool, turnContext);

    const pipeline = makePipeline(registry, turnContext, {
      resolveSchedulingTarget: createRealTargetResolver(registry),
    });
    pipeline.addTool({ id: 'invoke-q', name: 'tool_invoke', input: { tool_id: toolId, arguments: {} } });
    pipeline.discard();
    const outcome = await drain(pipeline);
    expect(outcome.toolResults).toHaveLength(0);
    expect(probe.state.started).toBe(0);

    const registry2 = new ToolRegistry();
    const probe2 = makeProbe('mcp__w1__slow', 60);
    registerDeferred(registry2, probe2, 'eager');
    const pipeline2 = makePipeline(registry2, makeTurnContext(), {});
    pipeline2.addTool({ id: 'direct-q', name: 'mcp__w1__slow', input: {} });
    pipeline2.discard();
    const outcome2 = await drain(pipeline2);
    expect(outcome2.toolResults).toHaveLength(0);
    expect(probe2.state.started).toBe(0);
  });

  it('a routed call exceeding the executor timeout is rejected by the same race as a direct call', async () => {
    const registry = new ToolRegistry();
    const probe = makeProbe('mcp__w1__slow', 250);
    registerDeferred(registry, probe);
    const invokeTool = new ToolInvokeTool();
    registerInvokeRouter(registry, invokeTool);
    const turnContext = makeTurnContext();
    const toolId = wireDispatcher(registry, invokeTool, turnContext);

    const pipeline = makePipeline(registry, turnContext, {
      resolveSchedulingTarget: createRealTargetResolver(registry),
      // Disable the executor's default retry so the 60ms timeout surfaces
      // deterministically instead of being absorbed by a retry attempt.
      config: { maxExecutionTimeMs: 60, enableRetry: false },
    });
    pipeline.addTool({ id: 'invoke-t', name: 'tool_invoke', input: { tool_id: toolId, arguments: {} } });
    const outcome = await drain(pipeline);
    expect(outcome.toolResults).toHaveLength(1);
    expect(outcome.toolResults[0]!.error).toBe(true);
    expect(outcome.toolResults[0]!.content).toContain('timed out');
    await sleep(300);
    expect(probe.state.completed).toBe(1);
  });
});

describe('W1 result correlation (F23)', () => {
  it('the wrapper preserves the provider call id end to end', async () => {
    const registry = new ToolRegistry();
    const probe = makeProbe('mcp__w1__probe', 10);
    registerDeferred(registry, probe);
    const invokeTool = new ToolInvokeTool();
    registerInvokeRouter(registry, invokeTool);
    const turnContext = makeTurnContext();
    const toolId = wireDispatcher(registry, invokeTool, turnContext);

    const pipeline = makePipeline(registry, turnContext, {
      resolveSchedulingTarget: createRealTargetResolver(registry),
    });
    pipeline.addTool({ id: 'provider-call-id', name: 'tool_invoke', input: { tool_id: toolId, arguments: {} } });
    const outcome = await drain(pipeline);
    expect(probe.state.completed).toBe(1);
    expect(outcome.toolResults).toHaveLength(1);
    expect(outcome.toolResults[0]!.id).toBe('provider-call-id');
    expect(outcome.toolResults[0]!.error).toBe(false);
  });

  it('dispatcher outcome carries target metadata/images/pendingContext and the wrapper forwards them', async () => {
    const registry = new ToolRegistry();
    const probe = makeProbe('mcp__w1__meta', 5);
    (probe.executor as { execute: unknown }).execute = async () => ({
      id: 'r-meta',
      name: 'mcp__w1__meta',
      result: 'meta-ok',
      metadata: { exitCode: 3 },
      images: [{ data: 'aGk=', mediaType: 'image/png' }],
      pendingContext: Promise.resolve({ followUp: 'ctx' }),
    });
    registerDeferred(registry, probe);
    const invokeTool = new ToolInvokeTool();
    registerInvokeRouter(registry, invokeTool);
    const turnContext = makeTurnContext();
    const snapshot = registry.snapshot(new Map());
    const entry = snapshot.catalogEntries.find((e) => e.internalName === 'mcp__w1__meta')!;

    const dispatcher = createToolInvokeDispatcherFromRegistry({
      registry,
      getSnapshot: () => snapshot,
      checkPermission: async () => ({ behavior: 'allow' as const }),
      contextProvider: () => turnContext as unknown as DiscoveryToolContext,
    } as never);
    invokeTool.setDispatcherForContext(turnContext as unknown as DiscoveryToolContext, dispatcher);
    const outcome: ToolInvokeOutcome = await dispatcher.dispatch(
      { tool_id: entry.toolId, arguments: {} },
      turnContext as unknown as DiscoveryToolContext,
    );
    expect(outcome.metadata).toEqual({ exitCode: 3 });
    expect(outcome.images).toEqual([{ data: 'aGk=', mediaType: 'image/png' }]);
    expect(outcome.pendingContext).toBeDefined();

    const result = await invokeTool.execute(
      { tool_id: entry.toolId, arguments: {} },
      undefined,
      turnContext as unknown as DiscoveryToolContext,
    );
    expect(result.metadata).toEqual({ exitCode: 3 });
    expect(result.images).toEqual([{ data: 'aGk=', mediaType: 'image/png' }]);
  });
});
