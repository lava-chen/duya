/**
 * Shared harness for the W1 differential suites (plan: 2026-10-31 tool
 * surface & harness convergence, W1). Probes, ports, pipeline factory and
 * dispatcher wiring shared by the resolver / scheduling / approval / result
 * differential files. Test-only.
 */

import { ToolRegistry } from '../../src/tools/catalog/registry.js';
import { ToolInvokeTool } from '../../src/tools/discovery/ToolInvokeTool.js';
import { createToolInvokeDispatcherFromRegistry } from '../../src/tools/discovery/dispatcherFromRegistry.js';
import type { DiscoveryToolContext } from '../../src/tools/discovery/context.js';
import { ToolExecutionPipeline } from '../../src/tools/execution/index.js';
import type { SchedulingTargetResolver } from '../../src/tools/execution/index.js';
import type { ExecutorConfig, ToolExecutionRegistry } from '../../src/tools/execution/index.js';
import type { ToolExecutionPorts } from '../../src/tools/execution/ports.js';

export interface ProbeContext {
  abortController?: AbortController;
  workingDirectory?: string;
  sessionId?: string;
  getAppState?: () => Record<string, unknown>;
  options?: Record<string, unknown>;
  toolUseId?: string;
}

export function makeExecutionPorts(): ToolExecutionPorts<ProbeContext> {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ProbeState {
  maxActive: number;
  started: number;
  completed: number;
}

export interface ProbeOptions {
  concurrencySafe?: boolean;
  extractWritePaths?: (input: Record<string, unknown>) => readonly string[];
}

export interface Probe {
  name: string;
  definition: { name: string; description: string; input_schema: Record<string, unknown> };
  executor: Record<string, unknown>;
  state: ProbeState;
}

export function makeProbe(name: string, delayMs: number, options: ProbeOptions = {}): Probe {
  const state: ProbeState = { maxActive: 0, started: 0, completed: 0 };
  let active = 0;
  const executor: Record<string, unknown> = {
    execute: async () => {
      active += 1;
      state.started += 1;
      state.maxActive = Math.max(state.maxActive, active);
      await sleep(delayMs);
      active -= 1;
      state.completed += 1;
      return { id: `r-${name}`, name, result: `${name}-ok` };
    },
  };
  if (options.concurrencySafe) executor.isConcurrencySafe = () => true;
  if (options.extractWritePaths) executor.extractWritePaths = options.extractWritePaths;
  return {
    name,
    definition: {
      name,
      description: `W1 differential probe ${name}`,
      input_schema: { type: 'object', properties: {} },
    },
    executor,
    state,
  };
}

export { sleep };

const canUseTool = async () => true as const;

export function registerDeferred(
  registry: ToolRegistry,
  probe: Probe,
  exposure: 'deferred' | 'eager' | 'hidden' = 'deferred',
): void {
  registry.registerWithKey(
    probe.definition.name,
    probe.definition,
    probe.executor as never,
    'mcp',
    { exposure, source: { kind: 'mcp', id: 'w1' } },
  );
}

export function registerInvokeRouter(registry: ToolRegistry, invokeTool: ToolInvokeTool): void {
  registry.register(invokeTool.toTool(), invokeTool as never, { exposure: 'eager' });
}

export function toolIdOf(registry: ToolRegistry, internalName: string): string {
  const entry = registry.snapshot(new Map()).catalogEntries.find((e) => e.internalName === internalName);
  if (!entry) throw new Error(`W1 differential: ${internalName} not registered`);
  return entry.toolId;
}

export function wireDispatcher(
  registry: ToolRegistry,
  invokeTool: ToolInvokeTool,
  turnContext: ProbeContext,
  hooks: {
    checkPermission?: () => Promise<{ behavior: 'allow' | 'deny' | 'ask'; message?: string }>;
  } = {},
): string {
  const dispatcher = createToolInvokeDispatcherFromRegistry({
    registry,
    getSnapshot: () => registry.snapshot(new Map()),
    checkPermission: hooks.checkPermission ?? (async () => ({ behavior: 'allow' as const })),
    contextProvider: () => turnContext as unknown as DiscoveryToolContext,
  } as never);
  invokeTool.setDispatcherForContext(turnContext as unknown as DiscoveryToolContext, dispatcher);
  const deferred = registry
    .snapshot(new Map())
    .catalogEntries.find((e) => e.exposure === 'deferred' && e.internalName.startsWith('mcp__w1__'));
  if (!deferred) throw new Error('W1 differential: no deferred mcp__w1__ probe registered');
  return deferred.toolId;
}

export interface DrainOutcome {
  toolResults: Array<{ id: string; content: string; error: boolean }>;
}

/** Minimal structural alias so drain() accepts the pipeline or the executor. */
export interface DrainSource {
  getRemainingResults(): AsyncGenerator<{ message?: unknown }, void, unknown>;
}

export async function drain(source: DrainSource): Promise<DrainOutcome> {
  const toolResults: Array<{ id: string; content: string; error: boolean }> = [];
  for await (const update of source.getRemainingResults()) {
    const message = update.message as { role?: string; tool_call_id?: string; content?: unknown } | undefined;
    if (message?.role === 'tool') {
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      toolResults.push({
        id: message.tool_call_id ?? message.id ?? '',
        content,
        error: content.includes('tool_use_error') || content.includes('tool_error'),
      });
    }
  }
  return { toolResults };
}

export function makePipeline(
  registry: ToolRegistry,
  turnContext: ProbeContext,
  options: { resolveSchedulingTarget?: SchedulingTargetResolver; config?: ExecutorConfig } = {},
): ToolExecutionPipeline<ProbeContext> {
  return new ToolExecutionPipeline<ProbeContext>(
    registry as unknown as ToolExecutionRegistry,
    canUseTool,
    turnContext as never,
    options.config,
    makeExecutionPorts(),
    options.resolveSchedulingTarget
      ? { resolveSchedulingTarget: options.resolveSchedulingTarget }
      : undefined,
  );
}
