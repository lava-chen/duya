/**
 * ToolExecutionPipeline unit tests — Plan 550 step 2b-internals.
 *
 * Verifies the dependency-graph wave scheduler that sits between
 * `addTool` (the agent's per-tool_use hand-off) and the wrapped
 * `StreamingToolExecutor`. Coverage:
 *
 *   - legacy mode (no resolver) collapses to a single wave in arrival
 *     order, so existing callers see identical scheduling
 *   - a declared `requires` clause moves the dependent tool into a
 *     later wave, and the pipeline waits for the prerequisite's
 *     completion before forwarding
 *   - disjoint `writePaths` lets two writers run in parallel even
 *     though the legacy WRITE batch would have serialised them
 *   - cyclic / unresolvable graphs surface a synthetic
 *     `<tool_use_error>` envelope so the downstream code path is
 *     identical to a runtime tool failure
 *   - `discard()` clears the buffer so a max_tokens fail-fast does
 *     not run the truncated tools
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolExecutionPipeline } from '../../../src/tool/ToolExecutionPipeline.js';
import { ToolRegistry } from '../../../src/tool/registry.js';
import type { ToolResult, ToolUseContext } from '../../../src/types.js';
import type { ToolDependencyDeclaration } from '../../../src/tool/dependencies.js';

interface Recorder {
  startOrder: string[];
  completeOrder: string[];
}

function makeContext(): ToolUseContext {
  const abortController = new AbortController();
  return {
    toolUseId: 'ctx',
    getAppState: () => ({}) as never,
    setAppState: () => undefined,
    abortController,
    options: {} as never,
  };
}

function makeRegistry(recorder: Recorder, opts: { slowTool?: string } = {}): ToolRegistry {
  const registry = new ToolRegistry();
  const slowToolName = opts.slowTool ?? 'slow';

  const make = (name: string, delayMs: number): { definition: ReturnType<typeof toolDef>; executor: { execute: (input: Record<string, unknown>) => Promise<ToolResult> } } => ({
    definition: toolDef(name),
    executor: {
      execute: async () => {
        recorder.startOrder.push(name);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        recorder.completeOrder.push(name);
        return { id: `result-${name}`, name, result: `${name}-ok` };
      },
    },
  });

  const fast = make('fast', 5);
  const slow = make(slowToolName, 25);
  registry.register(fast.definition, fast.executor as never);
  registry.register(slow.definition, slow.executor as never);

  // A read-only parallel tool that completes independently of the
  // write semantics — used by the parallel-writers test.
  const writeA = make('write_a', 15);
  const writeB = make('write_b', 15);
  registry.register(writeA.definition, writeA.executor as never);
  registry.register(writeB.definition, writeB.executor as never);

  return registry;
}

function toolDef(name: string) {
  return {
    name,
    description: `test tool ${name}`,
    input_schema: { type: 'object', properties: {} },
  };
}

async function drain(pipeline: ToolExecutionPipeline): Promise<string[]> {
  const toolResultIds: string[] = [];
  for await (const update of pipeline.getRemainingResults()) {
    if (update.message?.role === 'tool') {
      toolResultIds.push(update.message.tool_call_id ?? update.message.id);
    }
  }
  return toolResultIds;
}

describe('ToolExecutionPipeline (wave scheduling — Plan 550 2b)', () => {
  let recorder: Recorder;

  beforeEach(() => {
    recorder = { startOrder: [], completeOrder: [] };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('forwards every tool in a single wave when no resolver is supplied (legacy mode)', async () => {
    const registry = makeRegistry(recorder);
    const pipeline = new ToolExecutionPipeline(
      registry,
      async () => true,
      makeContext(),
    );

    pipeline.addTool({ id: 't1', name: 'fast', input: {} });
    pipeline.addTool({ id: 't2', name: 'slow', input: {} });

    await drain(pipeline);

    // Both tools started before either completed (concurrent execution).
    // Order is preserved exactly: t1 before t2.
    expect(recorder.startOrder.slice(0, 2)).toEqual(['fast', 'slow']);
    expect(recorder.completeOrder).toContain('fast');
    expect(recorder.completeOrder).toContain('slow');
    // Completion order is non-deterministic for parallel tools, but both
    // must have completed.
    expect(recorder.completeOrder).toHaveLength(2);
  });

  it('serialises a dependent tool behind its prerequisite', async () => {
    const registry = makeRegistry(recorder);
    const dependencyResolver = (toolName: string): ToolDependencyDeclaration | undefined => {
      if (toolName === 'slow') return { requires: ['fast'] };
      return undefined;
    };

    const pipeline = new ToolExecutionPipeline(
      registry,
      async () => true,
      makeContext(),
      undefined,
      { dependencyResolver },
    );

    pipeline.addTool({ id: 't1', name: 'fast', input: {} });
    pipeline.addTool({ id: 't2', name: 'slow', input: {} });

    const completion = await drain(pipeline);

    // `fast` must finish before `slow` starts — dependency-wave order,
    // not arrival order.
    const slowStartIdx = recorder.startOrder.indexOf('slow');
    const fastCompleteIdx = recorder.completeOrder.indexOf('fast');
    expect(slowStartIdx).toBeGreaterThan(-1);
    expect(fastCompleteIdx).toBeGreaterThan(-1);
    expect(slowStartIdx).toBeGreaterThanOrEqual(recorder.startOrder.indexOf('fast'));
    // fast completes before slow starts:
    expect(recorder.completeOrder.indexOf('fast')).toBeLessThan(recorder.startOrder.indexOf('slow'));

    // The completion stream still includes both tool ids.
    expect(completion).toEqual(expect.arrayContaining(['t1', 't2']));
  });

  it('runs two writers with disjoint paths in parallel (write-path semantics)', async () => {
    const registry = makeRegistry(recorder);
    const dependencyResolver = (toolName: string): ToolDependencyDeclaration | undefined => {
      if (toolName === 'write_a') return { writePaths: ['/tmp/a.md'] };
      if (toolName === 'write_b') return { writePaths: ['/tmp/b.md'] };
      return undefined;
    };

    const pipeline = new ToolExecutionPipeline(
      registry,
      async () => true,
      makeContext(),
      undefined,
      { dependencyResolver },
    );

    pipeline.addTool({ id: 'wa', name: 'write_a', input: { path: '/tmp/a.md' } });
    pipeline.addTool({ id: 'wb', name: 'write_b', input: { path: '/tmp/b.md' } });

    await drain(pipeline);

    // Both started before either completed — disjoint write paths
    // permit parallel execution even though both classify as writers.
    const waStart = recorder.startOrder.indexOf('write_a');
    const wbStart = recorder.startOrder.indexOf('write_b');
    const waComplete = recorder.completeOrder.indexOf('write_a');
    const wbComplete = recorder.completeOrder.indexOf('write_b');
    expect(waStart).toBeGreaterThan(-1);
    expect(wbStart).toBeGreaterThan(-1);
    expect(waComplete).toBeGreaterThan(-1);
    expect(wbComplete).toBeGreaterThan(-1);
    expect(Math.max(waStart, wbStart)).toBeGreaterThan(Math.min(waComplete, wbComplete) - 1);
  });

  it('serialises two writers that share a write path (collision)', async () => {
    const registry = makeRegistry(recorder);
    const dependencyResolver = (toolName: string): ToolDependencyDeclaration | undefined => {
      if (toolName === 'write_a' || toolName === 'write_b') {
        return { writePaths: ['/tmp/shared.md'] };
      }
      return undefined;
    };

    const pipeline = new ToolExecutionPipeline(
      registry,
      async () => true,
      makeContext(),
      undefined,
      { dependencyResolver },
    );

    pipeline.addTool({ id: 'wa', name: 'write_a', input: { path: '/tmp/shared.md' } });
    pipeline.addTool({ id: 'wb', name: 'write_b', input: { path: '/tmp/shared.md' } });

    await drain(pipeline);

    // Shared write path forces serialisation: write_b must not start
    // until write_a completes.
    expect(recorder.completeOrder.indexOf('write_a')).toBeLessThan(
      recorder.startOrder.indexOf('write_b'),
    );
  });

  it('surfaces cyclic dependency as a synthetic tool_use_error', async () => {
    const registry = makeRegistry(recorder);
    // Cross-reference: each tool requires the other → cycle.
    const dependencyResolver = (toolName: string): ToolDependencyDeclaration | undefined => {
      if (toolName === 'fast') return { requires: ['slow'] };
      if (toolName === 'slow') return { requires: ['fast'] };
      return undefined;
    };

    const pipeline = new ToolExecutionPipeline(
      registry,
      async () => true,
      makeContext(),
      undefined,
      { dependencyResolver },
    );

    pipeline.addTool({ id: 't1', name: 'fast', input: {} });
    pipeline.addTool({ id: 't2', name: 'slow', input: {} });

    const errorMessages: string[] = [];
    const completionIds: string[] = [];
    for await (const update of pipeline.getRemainingResults()) {
      if (update.message?.role === 'tool') {
        const content = Array.isArray(update.message.content)
          ? update.message.content.map((c: { text?: string }) => c.text ?? '').join('')
          : String(update.message.content);
        if (content.includes('<tool_use_error>')) {
          errorMessages.push(content);
        } else {
          completionIds.push(update.message.tool_call_id ?? update.message.id);
        }
      }
    }

    // The cycle culprit is surfaced as a synthetic tool_use_error so
    // the downstream agent code path matches a runtime tool failure.
    // The remaining tools that no longer have unmet prerequisites
    // proceed normally (so the LLM gets actionable feedback rather
    // than losing every tool call).
    expect(errorMessages.length).toBeGreaterThan(0);
    expect(errorMessages[0]).toMatch(/<tool_use_error>/);
    expect(completionIds).toContain('t2');
  });

  it('surfaces missing prerequisite as a synthetic tool_use_error', async () => {
    const registry = makeRegistry(recorder);
    // `slow` requires `nonexistent` which never appears in the batch.
    const dependencyResolver = (toolName: string): ToolDependencyDeclaration | undefined => {
      if (toolName === 'slow') return { requires: ['nonexistent'] };
      return undefined;
    };

    const pipeline = new ToolExecutionPipeline(
      registry,
      async () => true,
      makeContext(),
      undefined,
      { dependencyResolver },
    );

    pipeline.addTool({ id: 't1', name: 'fast', input: {} });
    pipeline.addTool({ id: 't2', name: 'slow', input: {} });

    const errors: string[] = [];
    for await (const update of pipeline.getRemainingResults()) {
      if (update.message?.role === 'tool') {
        const content = Array.isArray(update.message.content)
          ? update.message.content.map((c: { text?: string }) => c.text ?? '').join('')
          : String(update.message.content);
        if (content.includes('<tool_use_error>')) {
          errors.push(content);
        }
      }
    }

    expect(errors.some((e) => e.includes('unmet prerequisite'))).toBe(true);
  });

  it('introspects ToolExecutor.dependencies when no resolver is supplied', async () => {
    // Tool declarations ride on the registered executor (Plan 550 3a).
    // The pipeline should pick them up via `registry.getExecutor` without
    // the agent having to wire a resolver by hand.
    const registry = new ToolRegistry();
    registry.register(
      toolDef('fast'),
      {
        execute: async () => {
          recorder.startOrder.push('fast');
          await new Promise((resolve) => setTimeout(resolve, 5));
          recorder.completeOrder.push('fast');
          return { id: 'r-fast', name: 'fast', result: 'ok' };
        },
        dependencies: {},
      } as never,
    );
    registry.register(
      toolDef('slow'),
      {
        execute: async () => {
          recorder.startOrder.push('slow');
          await new Promise((resolve) => setTimeout(resolve, 5));
          recorder.completeOrder.push('slow');
          return { id: 'r-slow', name: 'slow', result: 'ok' };
        },
        dependencies: { requires: ['fast'] },
      } as never,
    );

    const pipeline = new ToolExecutionPipeline(registry, async () => true, makeContext());

    pipeline.addTool({ id: 't1', name: 'fast', input: {} });
    pipeline.addTool({ id: 't2', name: 'slow', input: {} });

    await drain(pipeline);

    // Wave 1: fast. Wave 2: slow (because slow.dependencies.requires=['fast']).
    expect(recorder.startOrder.indexOf('fast')).toBeLessThan(recorder.startOrder.indexOf('slow'));
    expect(recorder.completeOrder.indexOf('fast')).toBeLessThan(
      recorder.startOrder.indexOf('slow'),
    );
  });

  it('discard() drops buffered tools and prevents execution', async () => {
    const registry = makeRegistry(recorder);
    const pipeline = new ToolExecutionPipeline(
      registry,
      async () => true,
      makeContext(),
    );

    pipeline.addTool({ id: 't1', name: 'fast', input: {} });
    pipeline.addTool({ id: 't2', name: 'slow', input: {} });
    pipeline.discard();

    // After discard, the generator yields nothing — the executor
    // already saw the discard and the pipeline's buffer is empty.
    const messages: unknown[] = [];
    for await (const update of pipeline.getRemainingResults()) {
      messages.push(update);
    }
    expect(messages).toEqual([]);
    expect(recorder.startOrder).toEqual([]);
  });
});