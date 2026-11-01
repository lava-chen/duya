/**
 * W1 scheduling differential (plan: 2026-10-31 tool surface & harness
 * convergence, W1 / F17 / F26). All scenarios run the REAL machinery:
 * resolver → pipeline → executor → dispatcher → target executor.
 *
 *   - SCHEDULING PARITY (F26): a routed call is batched like a direct call
 *     of its resolved target. A deferred MCP read via tool_invoke now
 *     overlaps like the direct pair (W0 pinned the serial cliff);
 *     SYSTEM-classified targets and unresolvable IDs stay fail-closed
 *     exclusive.
 *   - WAVE PARITY (F17): the planner consumes the TARGET's write-path
 *     declarations — same-file routed writes serialise across waves,
 *     disjoint-file routed writes share a wave, and a routed/direct write
 *     collision behaves like two direct writes.
 */

import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '../../src/tools/catalog/registry.js';
import { ToolInvokeTool } from '../../src/tools/discovery/ToolInvokeTool.js';
import { createRealTargetResolver } from '../../src/tools/discovery/real-target.js';
import { drain, makePipeline, makeProbe, registerDeferred, registerInvokeRouter, toolIdOf, wireDispatcher } from './w1-diff-harness.js';
import type { Probe, ProbeContext } from './w1-diff-harness.js';

function makeTurnContext(): ProbeContext {
  const appState: Record<string, unknown> = {};
  return {
    abortController: new AbortController(),
    workingDirectory: '/tmp/w1-diff',
    sessionId: 'w1-scheduling',
    getAppState: () => appState,
    options: { sessionId: 'w1-scheduling' },
  };
}

/** Full stack: deferred probe + invoke router + dispatcher + tool id. */
function makeInvokeStack(delayMs = 90): {
  registry: ToolRegistry;
  probe: Probe;
  turnContext: ProbeContext;
  toolId: string;
} {
  const registry = new ToolRegistry();
  const probe = makeProbe('mcp__w1__probe', delayMs);
  registerDeferred(registry, probe);
  const invokeTool = new ToolInvokeTool();
  registerInvokeRouter(registry, invokeTool);
  const turnContext = makeTurnContext();
  const toolId = wireDispatcher(registry, invokeTool, turnContext);
  return { registry, probe, turnContext, toolId };
}

function makeWriterStack(): { registry: ToolRegistry; probe: Probe; turnContext: ProbeContext; toolId: string } {
  const registry = new ToolRegistry();
  const probe = makeProbe('mcp__w1__writer', 40, {
    concurrencySafe: true,
    extractWritePaths: (input) => [String(input.path)],
  });
  // Mirror a real write-capable executor: the static declaration carries
  // the `__from_input__` sentinel so the planner consults the extractor.
  (probe.executor as { dependencies?: unknown }).dependencies = { writePaths: ['__from_input__'] };
  registerDeferred(registry, probe);
  const invokeTool = new ToolInvokeTool();
  registerInvokeRouter(registry, invokeTool);
  const turnContext = makeTurnContext();
  const toolId = wireDispatcher(registry, invokeTool, turnContext);
  return { registry, probe, turnContext, toolId };
}

describe('W1 scheduling parity (F26)', () => {
  it('two routed calls of the same MCP read target run concurrently, like the direct pair', async () => {
    const { registry, probe, turnContext, toolId } = makeInvokeStack();
    const pipeline = makePipeline(registry, turnContext, {
      resolveSchedulingTarget: createRealTargetResolver(registry),
    });
    pipeline.addTool({ id: 'invoke-1', name: 'tool_invoke', input: { tool_id: toolId, arguments: {} } });
    pipeline.addTool({ id: 'invoke-2', name: 'tool_invoke', input: { tool_id: toolId, arguments: {} } });
    const outcome = await drain(pipeline);
    expect(outcome.toolResults).toHaveLength(2);
    expect(probe.state.maxActive).toBe(2);
  });

  it('mixed batch: a routed call overlaps a direct call of the same read target', async () => {
    const { registry, probe, turnContext, toolId } = makeInvokeStack();
    const pipeline = makePipeline(registry, turnContext, {
      resolveSchedulingTarget: createRealTargetResolver(registry),
    });
    pipeline.addTool({ id: 'direct-1', name: 'mcp__w1__probe', input: {} });
    pipeline.addTool({ id: 'invoke-1', name: 'tool_invoke', input: { tool_id: toolId, arguments: {} } });
    await drain(pipeline);
    expect(probe.state.maxActive).toBe(2);
  });

  it('a SYSTEM-classified routed target stays exclusive against a concurrent direct read', async () => {
    const registry = new ToolRegistry();
    const systemProbe = makeProbe('deferred_probe_system', 60);
    registerDeferred(registry, systemProbe);
    const readProbe = makeProbe('mcp__w1__reader', 60);
    registerDeferred(registry, readProbe);
    const invokeTool = new ToolInvokeTool();
    registerInvokeRouter(registry, invokeTool);
    const turnContext = makeTurnContext();
    const systemToolId = toolIdOf(registry, 'deferred_probe_system');
    wireDispatcher(registry, invokeTool, turnContext);

    const pipeline = makePipeline(registry, turnContext, {
      resolveSchedulingTarget: createRealTargetResolver(registry),
    });
    pipeline.addTool({ id: 'direct-1', name: 'mcp__w1__reader', input: {} });
    pipeline.addTool({ id: 'invoke-1', name: 'tool_invoke', input: { tool_id: systemToolId, arguments: {} } });
    await drain(pipeline);

    expect(readProbe.state.maxActive).toBe(1);
    expect(systemProbe.state.maxActive).toBe(1);
    expect(readProbe.state.completed).toBe(1);
    expect(systemProbe.state.completed).toBe(1);
  });

  it('an unresolvable routed ID keeps the fail-closed exclusive schedule', async () => {
    const registry = new ToolRegistry();
    const readProbe = makeProbe('mcp__w1__reader', 60);
    registerDeferred(registry, readProbe);
    const invokeTool = new ToolInvokeTool();
    registerInvokeRouter(registry, invokeTool);
    const turnContext = makeTurnContext();
    wireDispatcher(registry, invokeTool, turnContext);

    const pipeline = makePipeline(registry, turnContext, {
      resolveSchedulingTarget: createRealTargetResolver(registry),
    });
    pipeline.addTool({ id: 'direct-1', name: 'mcp__w1__reader', input: {} });
    pipeline.addTool({ id: 'invoke-1', name: 'tool_invoke', input: { tool_id: 'mcp__w1__stale-id', arguments: {} } });
    const outcome = await drain(pipeline);

    expect(outcome.toolResults).toHaveLength(2);
    expect(outcome.toolResults.some((r) => r.content.includes('TOOL_NOT_FOUND'))).toBe(true);
    expect(readProbe.state.maxActive).toBe(1);
  });
});

describe('W1 wave parity (F17)', () => {
  it('two routed writes on the same file serialise across waves', async () => {
    const { registry, probe, turnContext, toolId } = makeWriterStack();
    const pipeline = makePipeline(registry, turnContext, {
      resolveSchedulingTarget: createRealTargetResolver(registry),
    });
    pipeline.addTool({ id: 'w1', name: 'tool_invoke', input: { tool_id: toolId, arguments: { path: '/tmp/shared.md' } } });
    pipeline.addTool({ id: 'w2', name: 'tool_invoke', input: { tool_id: toolId, arguments: { path: '/tmp/shared.md' } } });
    await drain(pipeline);
    expect(probe.state.maxActive).toBe(1);
    expect(probe.state.completed).toBe(2);
  });

  it('two routed writes on different files share a wave (concurrent)', async () => {
    const { registry, probe, turnContext, toolId } = makeWriterStack();
    const pipeline = makePipeline(registry, turnContext, {
      resolveSchedulingTarget: createRealTargetResolver(registry),
    });
    pipeline.addTool({ id: 'w1', name: 'tool_invoke', input: { tool_id: toolId, arguments: { path: '/tmp/a.md' } } });
    pipeline.addTool({ id: 'w2', name: 'tool_invoke', input: { tool_id: toolId, arguments: { path: '/tmp/b.md' } } });
    await drain(pipeline);
    expect(probe.state.maxActive).toBe(2);
    expect(probe.state.completed).toBe(2);
  });

  it('a routed write and a direct write of the same target conflict on one file', async () => {
    const { registry, probe, turnContext, toolId } = makeWriterStack();
    const pipeline = makePipeline(registry, turnContext, {
      resolveSchedulingTarget: createRealTargetResolver(registry),
    });
    pipeline.addTool({ id: 'direct-w', name: 'mcp__w1__writer', input: { path: '/tmp/shared.md' } });
    pipeline.addTool({ id: 'invoke-w', name: 'tool_invoke', input: { tool_id: toolId, arguments: { path: '/tmp/shared.md' } } });
    await drain(pipeline);
    expect(probe.state.maxActive).toBe(1);
    expect(probe.state.completed).toBe(2);
  });
});
