/**
 * ToolExecutionPipeline — Plan 550 step 2b.
 *
 * Thin facade over `StreamingToolExecutor`. The pipeline's only
 * responsibility today is to hold the executor handle and forward the
 * public surface (`addTool` / `getRemainingResults` / `discard` /
 * `setCallbacks` / etc.) so callers (`duyaAgent.streamChat`) never
 * `new StreamingToolExecutor(...)` directly.
 *
 * Why a facade and not a direct import: the eventual step 2b body —
 * `tool batch → dependency-graph orchestrator → streaming executor` —
 * will live here. `DependencyGraphOrchestrator.planExecution()`
 * decides the wave-by-wave execution order between `addTool` and the
 * `getRemainingResults` drain. Right now the orchestrator is wired but
 * unused; this commit adds the seam so the follow-up commits can swap
 * the scheduling strategy without `duyaAgent` changing at all.
 *
 * The facade never buffers, never transforms events, and never inspects
 * tool_use blocks. Behaviour is identical to the wrapped executor —
 * verified by pinning the test surface to the same hooks /
 * permissions / streaming callbacks the legacy `new StreamingToolExecutor`
 * path already covered.
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import {
  StreamingToolExecutor,
  type CanUseToolFn,
  type ExecutorConfig,
  type MessageUpdate,
  type ProgressCallback,
  type ToolCompleteCallback,
  type ToolErrorCallback,
  type ToolStartCallback,
} from './StreamingToolExecutor.js';
import type { ToolRegistry } from './registry.js';
import type { ToolUse, ToolUseContext } from '../types.js';

export type {
  CanUseToolFn,
  ExecutorConfig,
  MessageUpdate,
  ProgressCallback,
  ToolCompleteCallback,
  ToolErrorCallback,
  ToolStartCallback,
} from './StreamingToolExecutor.js';

/**
 * Identical to `StreamingToolExecutor`'s public surface. Kept as a
 * type so callers can be migrated to `ToolExecutionPipeline` without
 * picking apart which methods are delegated vs. proxied.
 */
export interface IToolExecutionPipeline {
  addTool(block: ToolUse): void;
  getRemainingResults(): AsyncGenerator<MessageUpdate, void, unknown>;
  setCallbacks(callbacks: {
    onProgress?: ProgressCallback;
    onToolStart?: ToolStartCallback;
    onToolComplete?: ToolCompleteCallback;
    onToolError?: ToolErrorCallback;
  }): void;
  setMemoryWarningCallback(callback: (currentMB: number, thresholdMB: number) => void): void;
  getMemoryUsageMB(): number;
  discard(): void;
  dispose(): void;
}

/**
 * Thin facade. All calls are forwarded to the wrapped executor so the
 * scheduling / concurrency / abort / permission semantics stay exactly
 * the same; the follow-up commits wire `DependencyGraphOrchestrator`
 * between `addTool` and `getRemainingResults` without changing the
 * caller's expectations.
 */
export class ToolExecutionPipeline implements IToolExecutionPipeline {
  private readonly executor: StreamingToolExecutor;

  constructor(
    toolRegistry: ToolRegistry,
    canUseTool: CanUseToolFn,
    toolUseContext: ToolUseContext,
    config?: ExecutorConfig,
  ) {
    this.executor = new StreamingToolExecutor(toolRegistry, canUseTool, toolUseContext, config);
  }

  addTool(block: ToolUse): void {
    this.executor.addTool(block);
  }

  async *getRemainingResults(): AsyncGenerator<MessageUpdate, void, unknown> {
    for await (const update of this.executor.getRemainingResults()) {
      yield update;
    }
  }

  setCallbacks(callbacks: {
    onProgress?: ProgressCallback;
    onToolStart?: ToolStartCallback;
    onToolComplete?: ToolCompleteCallback;
    onToolError?: ToolErrorCallback;
  }): void {
    this.executor.setCallbacks(callbacks);
  }

  setMemoryWarningCallback(callback: (currentMB: number, thresholdMB: number) => void): void {
    this.executor.setMemoryWarningCallback(callback);
  }

  getMemoryUsageMB(): number {
    return this.executor.getMemoryUsageMB();
  }

  discard(): void {
    this.executor.discard();
  }

  dispose(): void {
    this.executor.dispose();
  }
}