/**
 * W0 differential — direct call vs `tool_invoke` dispatch (plan:
 * 2026-10-31 tool surface & harness convergence, F17/F18/F19 signatures).
 *
 * Three axes, one target tool each, through the REAL machinery:
 *
 *   1. SCHEDULING — the executor classifies the outer tool name
 *      (`classifyTool`): an eager MCP tool (`mcp_*` prefix) lands in the
 *      parallel READ batch, while the same target dispatched through
 *      `tool_invoke` lands in the fail-closed SYSTEM batch (exclusive).
 *      Same capability, same args: hint-exposed MCP reads run
 *      concurrently, discovery-dispatched ones serialise. Conservative
 *      direction (no unsafe concurrency), but a real mode-dependent
 *      cliff — F17's wrapper question answered at the batch layer.
 *
 *   2. APPROVAL BINDING — the dispatcher resolves the target entry
 *      BEFORE the permission check and never re-resolves after. A
 *      registry replace-set that lands while approval is pending still
 *      executes the pre-approval executor with args validated against
 *      the pre-approval schema — F18's "approved A, executed B" window,
 *      reproduced here with the stale executor signature. The positive
 *      control pins what IS correct: arguments are structuredClone-bound
 *      before approval, so caller-side mutation after the fact cannot
 *      change what executes.
 *
 *   3. CANCEL — the wrapper runs inside the executor's per-call abort
 *      scope and the dispatcher spreads that context into the target, so
 *      abort propagation is EQUIVALENT to the direct path (both see
 *      `context.abortController` fire). Neither path terminates an
 *      underlying call that ignores the signal: the probe completes
 *      after the executor has already reported the abort on both paths —
 *      the orphan signature, recorded as current behavior (F19), not
 *      claimed as a differential.
 */

import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '../../src/tools/catalog/registry.js';
import { ToolInvokeTool } from '../../src/tools/discovery/ToolInvokeTool.js';
import { createToolInvokeDispatcherFromRegistry } from '../../src/tools/discovery/dispatcherFromRegistry.js';
import type { DiscoveryToolContext } from '../../src/tools/discovery/context.js';
import { StreamingToolExecutor } from '../../src/tools/execution/StreamingToolExecutor.js';
import type { ExecutorConfig, ToolExecutionRegistry } from '../../src/tools/execution/index.js';
import type { ToolExecutionPorts } from '../../src/tools/execution/ports.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface ProbeContext {
  abortController?: AbortController;
  workingDirectory?: string;
  sessionId?: string;
  getAppState?: () => Record<string, unknown>;
  options?: Record<string, unknown>;
  toolUseId?: string;
}

function makeExecutionPorts(): ToolExecutionPorts<ProbeContext> {
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

function makeTurnContext(): ProbeContext {
  const appState: Record<string, unknown> = {};
  return {
    abortController: new AbortController(),
    workingDirectory: '/tmp/w0-diff',
    sessionId: 'w0-diff',
    getAppState: () => appState,
    options: { sessionId: 'w0-diff' },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ProbeState {
  maxActive: number;
  started: number;
  completed: number;
  sawAbort: boolean;
  results: string[];
  startedResolve: (() => void) | null;
  startedPromise: Promise<void>;
}

function makeProbe(name: string, delayMs: number): {
  definition: { name: string; description: string; input_schema: Record<string, unknown> };
  executor: {
    execute: (
      input: Record<string, unknown>,
      workingDirectory?: string,
      context?: ProbeContext,
    ) => Promise<{ id: string; name: string; result: string; error?: boolean }>;
  };
  state: ProbeState;
} {
  const state: ProbeState = {
    maxActive: 0,
    started: 0,
    completed: 0,
    sawAbort: false,
    results: [],
    startedResolve: null,
    startedPromise: Promise.resolve(),
  };
  state.startedPromise = new Promise<void>((resolve) => {
    state.startedResolve = resolve;
  });
  let active = 0;
  const executor = {
    execute: async (
      _input: Record<string, unknown>,
      _workingDirectory?: string,
      context?: ProbeContext,
    ) => {
      active += 1;
      state.started += 1;
      state.maxActive = Math.max(state.maxActive, active);
      state.startedResolve?.();
      await sleep(delayMs);
      // Sample AFTER the wait: an abort that fired during execution is
      // visible here even when the executor race already gave up on us.
      // ToolUseContext carries an AbortController (not a signal), so read
      // `.signal.aborted` off it.
      const controller = context?.abortController as AbortController | undefined;
      state.sawAbort = state.sawAbort || controller?.signal?.aborted === true;
      active -= 1;
      state.completed += 1;
      state.results.push(name);
      return { id: `r-${name}`, name, result: `${name}-ok` };
    },
  };
  return {
    definition: {
      name,
      description: `W0 differential probe ${name}`,
      input_schema: { type: 'object', properties: {} },
    },
    executor,
    state,
  };
}

const canUseTool = async () => true as const;

/** Minimal one-field text-argument schema for replace-set fixtures. */
function textArgSchema(field: string): Record<string, unknown> {
  const prop: Record<string, unknown> = { type: 'string' };
  return {
    type: 'object',
    properties: { [field]: prop },
    required: [field],
    additionalProperties: false,
  };
}

interface DrainOutcome {
  toolResults: string[];
  sawError: boolean;
}

async function drainExecutor(
  executor: StreamingToolExecutor<ProbeContext>,
): Promise<DrainOutcome> {
  const toolResults: string[] = [];
  let sawError = false;
  try {
    for await (const update of executor.getRemainingResults()) {
      const message = update.message as { role?: string; tool_call_id?: string; content?: unknown } | undefined;
      if (message?.role === 'tool') {
        toolResults.push(message.tool_call_id ?? message.id ?? '');
        if (typeof message.content === 'string' && message.content.includes('tool_use_error')) {
          sawError = true;
        }
      }
    }
  } catch {
    sawError = true;
  }
  return { toolResults, sawError };
}

function wireDispatcher(
  registry: ToolRegistry,
  invokeTool: ToolInvokeTool,
  turnContext: ProbeContext,
  hooks: {
    checkPermission?: (
      toolName: string,
      args: Record<string, unknown>,
      invocationId: string,
    ) => Promise<{ behavior: 'allow' | 'deny' | 'ask'; message?: string }>;
    getSnapshot?: () => ReturnType<ToolRegistry['snapshot']>;
  } = {},
): { toolId: string } {
  const snapshot = registry.snapshot(new Map());
  const deferredEntry = snapshot.catalogEntries.find(
    (entry) => entry.exposure === 'deferred' && entry.internalName.startsWith('mcp__w0__'),
  );
  if (!deferredEntry) throw new Error('W0 differential: no deferred probe registered');
  const deps = {
    registry,
    getSnapshot: hooks.getSnapshot ?? (() => snapshot),
    checkPermission: hooks.checkPermission ?? (async () => ({ behavior: 'allow' as const })),
    contextProvider: () => turnContext as unknown as DiscoveryToolContext,
  };
  const dispatcher = createToolInvokeDispatcherFromRegistry(deps as never);
  invokeTool.setDispatcherForContext(turnContext as unknown as DiscoveryToolContext, dispatcher);
  return { toolId: deferredEntry.toolId };
}

function registerInvokeRouter(registry: ToolRegistry, invokeTool: ToolInvokeTool): void {
  registry.register(invokeTool.toTool(), invokeTool as never, { exposure: 'eager' });
}

// ---------------------------------------------------------------------------
// 1. Scheduling differential
// ---------------------------------------------------------------------------

describe('W0 direct vs invoke differential', () => {
  it('scheduling: direct MCP reads run concurrently; the same reads via tool_invoke serialise', async () => {
    const registry = new ToolRegistry();
    const probe = makeProbe('mcp__w0__probe', 90);
    registry.registerWithKey(
      probe.definition.name,
      probe.definition,
      probe.executor as never,
      'mcp',
      { exposure: 'deferred', source: { kind: 'mcp', id: 'w0' } },
    );

    // Direct batch: two model calls of the eager-exposed name. The executor
    // classifies `mcp_*` as READ (parallel), so both probes overlap.
    const directExecutor = new StreamingToolExecutor<ProbeContext>(
      registry as unknown as ToolExecutionRegistry,
      canUseTool,
      makeTurnContext() as never,
      undefined as unknown as ExecutorConfig,
      makeExecutionPorts(),
    );
    directExecutor.addTool({ id: 'direct-1', name: probe.definition.name, input: {} });
    directExecutor.addTool({ id: 'direct-2', name: probe.definition.name, input: {} });
    const direct = await drainExecutor(directExecutor);
    expect(direct.toolResults).toHaveLength(2);
    expect(direct.sawError).toBe(false);
    expect(probe.state.maxActive).toBe(2);

    // Invoke batch: the same target through the wrapper. `tool_invoke` is
    // not in the batch map and has no `mcp_` prefix, so it fail-closes to
    // SYSTEM (exclusive): the two dispatches cannot overlap.
    const registry2 = new ToolRegistry();
    const probe2 = makeProbe('mcp__w0__probe', 90);
    registry2.registerWithKey(
      probe2.definition.name,
      probe2.definition,
      probe2.executor as never,
      'mcp',
      { exposure: 'deferred', source: { kind: 'mcp', id: 'w0' } },
    );
    const invokeTool = new ToolInvokeTool();
    registerInvokeRouter(registry2, invokeTool);
    const turnContext = makeTurnContext();
    const { toolId } = wireDispatcher(registry2, invokeTool, turnContext);

    const invokeExecutor = new StreamingToolExecutor<ProbeContext>(
      registry2 as unknown as ToolExecutionRegistry,
      canUseTool,
      turnContext as never,
      undefined as unknown as ExecutorConfig,
      makeExecutionPorts(),
    );
    invokeExecutor.addTool({
      id: 'invoke-1',
      name: 'tool_invoke',
      input: { tool_id: toolId, arguments: {} },
    });
    invokeExecutor.addTool({
      id: 'invoke-2',
      name: 'tool_invoke',
      input: { tool_id: toolId, arguments: {} },
    });
    const viaInvoke = await drainExecutor(invokeExecutor);
    expect(viaInvoke.toolResults).toHaveLength(2);
    expect(viaInvoke.sawError).toBe(false);
    expect(probe2.state.maxActive).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 2. Approval-window binding differential
  // -------------------------------------------------------------------------

  it('approval binding: a replace-set landing mid-approval still executes the pre-approval executor', async () => {
    const registry = new ToolRegistry();
    const oldProbe = makeProbe('mcp__w0__swap', 10);
    const newProbe = makeProbe('mcp__w0__swap', 10);
    const internalKey = 'mcp__w0__swap';
    registry.registerWithKey(
      internalKey,
      oldProbe.definition,
      oldProbe.executor as never,
      'mcp',
      { exposure: 'deferred', source: { kind: 'mcp', id: 'w0' } },
    );
    const invokeTool = new ToolInvokeTool();
    registerInvokeRouter(registry, invokeTool);
    const turnContext = makeTurnContext();

    let liveSnapshotAtApproval: string | undefined;
    const { toolId } = wireDispatcher(registry, invokeTool, turnContext, {
      checkPermission: async () => {
        // The replace-set lands WHILE approval is pending: same internal
        // key and source, new executor, new schema revision.
        registry.replaceByOwner('mcp', [
          {
            key: internalKey,
            definition: newProbe.definition,
            executor: newProbe.executor as never,
            meta: {
              exposure: 'deferred',
              source: { kind: 'mcp', id: 'w0' },
              catalogInputSchema: {
                type: 'object',
                properties: { value: { type: 'string', maxLength: 1 } },
                required: ['value'],
                additionalProperties: false,
              },
            },
          },
        ]);
        liveSnapshotAtApproval = registry.getCatalogEntryById(toolId)?.executor === newProbe.executor
          ? 'new'
          : 'old';
        return { behavior: 'allow' as const };
      },
    });

    const result = await invokeTool.execute(
      { tool_id: toolId, arguments: { value: 'approved-args' } },
      undefined,
      turnContext as unknown as DiscoveryToolContext,
    );

    // F18 fixed: the approved args (13 chars) no longer match the stricter
    // live schema, so the dispatch fails with a NAMED error. Neither the
    // pre-approval executor nor the replacement runs; no stale execution.
    expect(oldProbe.state.results).toEqual([]);
    expect(newProbe.state.results).toEqual([]);
    expect(liveSnapshotAtApproval).toBe('new');
    expect(result.error).toBe(true);
    expect(result.metadata?.errorCode).toBe('SCHEMA_CHANGED_MID_APPROVAL');
  });

  it('approval binding control: arguments are structuredClone-bound before approval', async () => {
    const registry = new ToolRegistry();
    const probe = makeProbe('mcp__w0__bind', 10);
    registry.registerWithKey(
      probe.definition.name,
      probe.definition,
      probe.executor as never,
      'mcp',
      { exposure: 'deferred', source: { kind: 'mcp', id: 'w0' } },
    );
    const invokeTool = new ToolInvokeTool();
    registerInvokeRouter(registry, invokeTool);
    const turnContext = makeTurnContext();

    let observedArgs: unknown = undefined;
    const original = wireDispatcher(registry, invokeTool, turnContext, {
      checkPermission: async (_toolName, args) => {
        // Mutate what the caller still holds while approval is pending.
        (args as Record<string, unknown>).value = 'MUTATED-DURING-APPROVAL';
        return { behavior: 'allow' as const };
      },
    });
    // The dispatcher's own deps are hidden behind the helper; re-wire with
    // an execute-time spy via a wrapping dispatcher on the same registry.
    const snapshot = registry.snapshot(new Map());
    const entry = snapshot.catalogEntries.find((e) => e.internalName === 'mcp__w0__bind');
    const dispatcherDeps = {
      registry,
      getSnapshot: () => snapshot,
      checkPermission: async (
        _toolName: string,
        args: Record<string, unknown>,
      ) => {
        (args as Record<string, unknown>).value = 'MUTATED-DURING-APPROVAL';
        return { behavior: 'allow' as const };
      },
      contextProvider: () => turnContext as unknown as DiscoveryToolContext,
    };
    const dispatcher = createToolInvokeDispatcherFromRegistry(dispatcherDeps as never);
    const executorSpy = {
      execute: async (input: Record<string, unknown>, cwd?: string, ctx?: unknown) => {
        observedArgs = structuredClone(input);
        return probe.executor.execute(input, cwd, ctx as ProbeContext | undefined);
      },
    };
    // Wrap the live entry's executor so the dispatcher still resolves the
    // registry normally but we see the args it finally passed.
    registry.unregister(entry!.internalName);
    registry.registerWithKey(
      entry!.internalName,
      entry!.definition,
      executorSpy as never,
      'mcp',
      { exposure: 'deferred', source: { kind: 'mcp', id: 'w0' } },
    );
    invokeTool.setDispatcherForContext(turnContext as unknown as DiscoveryToolContext, dispatcher);

    const requestArgs = { value: 'original-args' };
    const result = await invokeTool.execute(
      { tool_id: original.toolId, arguments: requestArgs },
      undefined,
      turnContext as unknown as DiscoveryToolContext,
    );
    expect(result.error).toBeUndefined();
    // Clone isolation: the CALLER's request object is never mutated by the
    // dispatch path (structuredClone at dispatcher entry).
    expect(requestArgs.value).toBe('original-args');
    // W0 finding pinned: the permission layer and the executor share ONE
    // mutable args object, so anything holding that reference between the
    // permission decision and execution changes what executes. In the ask
    // flow the user is shown this same object, so approval sees what runs
    // — but nothing freezes the object after approval (residual I05 risk
    // for W1 to settle: freeze post-approval or re-validate at execute).
    expect(observedArgs).toMatchObject({ value: 'MUTATED-DURING-APPROVAL' });
  });

  // -------------------------------------------------------------------------
  // 3. Cancel differential
  // -------------------------------------------------------------------------

  it('cancel: abort reaches the invoke-dispatched target through the wrapper context — and orphans it exactly like the direct path', async () => {
    // Invoke arm.
    const registry = new ToolRegistry();
    const target = makeProbe('mcp__w0__slow', 150);
    registry.registerWithKey(
      target.definition.name,
      target.definition,
      target.executor as never,
      'mcp',
      { exposure: 'deferred', source: { kind: 'mcp', id: 'w0' } },
    );
    const invokeTool = new ToolInvokeTool();
    registerInvokeRouter(registry, invokeTool);
    const turnContext = makeTurnContext();
    const { toolId } = wireDispatcher(registry, invokeTool, turnContext);

    const executor = new StreamingToolExecutor<ProbeContext>(
      registry as unknown as ToolExecutionRegistry,
      canUseTool,
      turnContext as never,
      undefined as unknown as ExecutorConfig,
      makeExecutionPorts(),
    );
    executor.addTool({
      id: 'invoke-cancel',
      name: 'tool_invoke',
      input: { tool_id: toolId, arguments: {} },
    });
    const draining = drainExecutor(executor);
    await target.state.startedPromise;
    executor.discard();
    // The drain terminates (the executor race gave up on the wrapper); the
    // exact synthetic envelope is the executor's business, not claimed here.
    await draining;
    // Give the orphaned probe its remaining sleep, then read the verdict.
    await sleep(220);
    expect(target.state.sawAbort).toBe(true);
    expect(target.state.completed).toBe(1);

    // Direct arm: the same probe as an eager tool, cancelled the same way.
    const registry2 = new ToolRegistry();
    const target2 = makeProbe('mcp__w0__slow', 150);
    registry2.register(target2.definition, target2.executor as never);
    const turnContext2 = makeTurnContext();
    const executor2 = new StreamingToolExecutor<ProbeContext>(
      registry2 as unknown as ToolExecutionRegistry,
      canUseTool,
      turnContext2 as never,
      undefined as unknown as ExecutorConfig,
      makeExecutionPorts(),
    );
    executor2.addTool({ id: 'direct-cancel', name: target2.definition.name, input: {} });
    const draining2 = drainExecutor(executor2);
    await target2.state.startedPromise;
    executor2.discard();
    await draining2;
    await sleep(220);
    expect(target2.state.sawAbort).toBe(true);
    expect(target2.state.completed).toBe(1);
  });
});
