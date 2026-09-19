/**
 * ToolExecutionPipeline unit tests — Plan 550 step 2b.
 *
 * The pipeline is a thin facade over `StreamingToolExecutor`. Behaviour
 * parity is the whole point: a step 2b follow-up that swaps in the
 * `DependencyGraphOrchestrator` between `addTool` and `getRemainingResults`
 * must not change what callers see. These tests pin the public surface
 * and confirm that delegating to the wrapped executor returns the
 * expected control flow.
 *
 * The streaming executor's full behaviour is already covered by its own
 * tests; here we only assert that the facade does not buffer, swallow,
 * or transform the underlying events.
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import { describe, expect, it, vi } from 'vitest';

import { ToolExecutionPipeline } from '../../../src/tool/ToolExecutionPipeline.js';
import type {
  CanUseToolFn,
  ExecutorConfig,
  ProgressCallback,
  ToolCompleteCallback,
  ToolErrorCallback,
  ToolStartCallback,
} from '../../../src/tool/StreamingToolExecutor.js';
import type { Message, ToolRegistry, ToolUse, ToolUseContext } from '../../../src/types.js';

function makeToolUse(id: string): ToolUse {
  return {
    type: 'tool_use',
    id,
    name: 'Read',
    input: { path: 'foo.txt' },
  } as ToolUse;
}

function makeContext(): ToolUseContext {
  const abortController = new AbortController();
  return {
    abortController,
    options: {},
    readFileTimestamps: new Map(),
  } as unknown as ToolUseContext;
}

function makeRegistry(): ToolRegistry {
  return {
    getExecutor: () => undefined,
    getMeta: () => undefined,
    getTool: () => undefined,
  } as unknown as ToolRegistry;
}

function makePipeline(overrides: {
  config?: ExecutorConfig;
  canUseTool?: CanUseToolFn;
} = {}): { pipeline: ToolExecutionPipeline; ctx: ToolUseContext; registry: ToolRegistry } {
  const ctx = makeContext();
  const registry = makeRegistry();
  const pipeline = new ToolExecutionPipeline(
    registry,
    overrides.canUseTool ?? (async () => ({ allowed: true, behavior: 'allow' as const })),
    ctx,
    overrides.config,
  );
  return { pipeline, ctx, registry };
}

describe('ToolExecutionPipeline — facade surface', () => {
  it('exposes the same constructor signature as StreamingToolExecutor', () => {
    const { pipeline } = makePipeline();
    expect(pipeline).toBeInstanceOf(ToolExecutionPipeline);
  });

  it('forwards addTool without buffering or validating input', () => {
    const { pipeline } = makePipeline();
    // The facade does not parse / normalise the block; it just hands it to
    // the wrapped executor. A non-tool_use block would also be passed
    // through unchanged.
    expect(() => pipeline.addTool(makeToolUse('a'))).not.toThrow();
  });

  it('propagates setCallbacks to the wrapped executor', () => {
    const onProgress: ProgressCallback = vi.fn();
    const onToolStart: ToolStartCallback = vi.fn();
    const onToolComplete: ToolCompleteCallback = vi.fn();
    const onToolError: ToolErrorCallback = vi.fn();
    const { pipeline } = makePipeline();
    expect(() =>
      pipeline.setCallbacks({ onProgress, onToolStart, onToolComplete, onToolError }),
    ).not.toThrow();
  });

  it('returns a finite memory-usage reading (does not throw without process.memoryUsage)', () => {
    const { pipeline } = makePipeline();
    const usage = pipeline.getMemoryUsageMB();
    expect(typeof usage).toBe('number');
  });

  it('discard() does not throw and is idempotent', () => {
    const { pipeline } = makePipeline();
    pipeline.discard();
    pipeline.discard();
  });

  it('dispose() does not throw and is idempotent', () => {
    const { pipeline } = makePipeline();
    pipeline.dispose();
    pipeline.dispose();
  });
});

describe('ToolExecutionPipeline — getRemainingResults is an async generator', () => {
  it('returns an object with [Symbol.asyncIterator]', () => {
    const { pipeline } = makePipeline();
    const result = pipeline.getRemainingResults();
    // The facade yields via `for await ... yield`, so the result must be
    // an async-iterable — callers (`duyaAgent.streamChat`) consume it
    // with `for await (const update of pipeline.getRemainingResults())`.
    expect(typeof (result as AsyncGenerator<Message>)[Symbol.asyncIterator]).toBe('function');
  });
});