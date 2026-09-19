/**
 * ToolExecutionPipeline — Plan 550 step 2b.
 *
 * Thin facade over `StreamingToolExecutor` that adds **dependency-graph
 * wave scheduling** on top of the executor's existing batch / concurrency
 * control. Two responsibilities, intentionally narrow:
 *
 *   1. Buffer every `addTool` call. Until `getRemainingResults` is
 *      consumed by the agent, no tool is forwarded to the wrapped
 *      executor. This gives the pipeline a complete batch to plan over.
 *   2. On the first `getRemainingResults` pull, compute an
 *      `ExecutionPlan` via `DependencyGraphOrchestrator.planExecution`.
 *      Then drive the executor **wave by wave**: forward every tool in
 *      the current wave via `executor.addTool`, drain the executor's
 *      own `getRemainingResults` until the wave's tools have all
 *      completed, and only then advance to the next wave.
 *
 * Why this is correct without touching `StreamingToolExecutor`:
 *
 *   - The executor already enforces the legacy batch concurrency
 *     (READ:5, WRITE:1, SYSTEM:5) on the *currently-queued* tools.
 *     We submit one wave at a time, so within-wave parallelism still
 *     falls back to the batch limit when a tool does not declare a
 *     dependency declaration.
 *   - Tools that DO declare `requires` / `writePaths` / `consumes` get
 *     precise serialisation across waves — the wave ordering is the
 *     dependency graph, not the LLM emission order.
 *   - Tools without a declaration land in the same wave and rely on
 *     the executor's existing batch concurrency. This is identical
 *     to the legacy behaviour, so the seam is opt-in per tool.
 *
 * Fail-closed: any tool the planner cannot resolve (cyclic dependency,
 * unknown prerequisite) is surfaced as a synthetic `tool_error`
 * MessageUpdate so the agent's existing error path lights up
 * identically to a runtime tool failure. The user sees the same
 * `<tool_use_error>` envelope as before.
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
import type { ToolExecutor, ToolRegistry } from './registry.js';
import type { ToolUse, ToolUseContext } from '../types.js';
import {
  planExecution,
  type ExecutionPlan,
  type OrchestrationToolUse,
} from './orchestration/DependencyGraphOrchestrator.js';
import type { ToolDependencyDeclaration } from './dependencies.js';

export type {
  CanUseToolFn,
  ExecutorConfig,
  MessageUpdate,
  ProgressCallback,
  ToolCompleteCallback,
  ToolErrorCallback,
  ToolStartCallback,
} from './StreamingToolExecutor.js';

export type DependencyResolver = (
  toolName: string,
) => ToolDependencyDeclaration | undefined;

export type PathExtractorResolver = (
  toolName: string,
) => ((input: Record<string, unknown>) => readonly string[]) | undefined;

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
 * Synthetic error message used when the dependency planner cannot
 * resolve a tool (cyclic graph, missing prerequisite, etc.). Wrapped
 * identically to the executor's own `createErrorMessage` so callers
 * downstream of `getRemainingResults` see a uniform `<tool_use_error>`
 * envelope regardless of which side produced it.
 */
function syntheticPlanError(toolUseId: string, reason: string): MessageUpdate {
  return {
    message: {
      id: toolUseId,
      role: 'tool',
      tool_call_id: toolUseId,
      content: `<tool_use_error>${reason}</tool_use_error>`,
      timestamp: Date.now(),
    },
  };
}

/**
 * Pipeline facade. Holds:
 *
 *   - the wrapped `StreamingToolExecutor` (same instance the agent
 *     used to construct directly);
 *   - a `pendingTools` queue of `addTool` calls received before the
 *     agent pulls `getRemainingResults`;
 *   - the optional dependency / path resolvers the agent supplies so
 *     the pipeline can build an `ExecutionPlan` over the batch.
 *
 * Dependency source priority:
 *   1. Explicit `dependencyResolver` / path resolvers from the agent
 *      constructor options (used by tests, plan-time overrides).
 *   2. Introspection via `toolRegistry.getExecutor(name)?.dependencies`
 *      (Plan 550 step 3a: tools that opted in by attaching a declaration
 *      to their `ToolExecutor` get the dependency-graph treatment
 *      automatically).
 *   3. No declaration → the planner still produces a single-wave
 *      batch, identical to the pre-2b behaviour. The executor's own
 *      READ/WRITE/SYSTEM batching applies within the wave.
 */
export class ToolExecutionPipeline implements IToolExecutionPipeline {
  private readonly executor: StreamingToolExecutor;
  private readonly toolRegistry: ToolRegistry;
  private readonly pendingTools: ToolUse[] = [];
  private readonly dependencyResolver: DependencyResolver | undefined;
  private readonly writePathResolver: PathExtractorResolver | undefined;
  private readonly readPathResolver: PathExtractorResolver | undefined;
  private plan: ExecutionPlan | null = null;
  private planEmittedUnresolved = false;

  constructor(
    toolRegistry: ToolRegistry,
    canUseTool: CanUseToolFn,
    toolUseContext: ToolUseContext,
    config?: ExecutorConfig,
    options?: {
      dependencyResolver?: DependencyResolver;
      extractWritePaths?: PathExtractorResolver;
      extractReadPaths?: PathExtractorResolver;
    },
  ) {
    this.toolRegistry = toolRegistry;
    this.executor = new StreamingToolExecutor(toolRegistry, canUseTool, toolUseContext, config);
    this.dependencyResolver = options?.dependencyResolver;
    this.writePathResolver = options?.extractWritePaths;
    this.readPathResolver = options?.extractReadPaths;
  }

  addTool(block: ToolUse): void {
    // Buffer until the agent pulls `getRemainingResults` and the plan
    // is computed. Forwarding eagerly would re-introduce the legacy
    // batch-ordering problem this commit exists to fix.
    this.pendingTools.push(block);
  }

  async *getRemainingResults(): AsyncGenerator<MessageUpdate, void, unknown> {
    const plan = this.ensurePlan();

    // First drain: surface every tool the planner could not schedule
    // as a synthetic error. Mirrors the executor's own error envelope
    // so the caller's downstream code is identical.
    if (!this.planEmittedUnresolved) {
      this.planEmittedUnresolved = true;
      for (const u of plan.unresolved) {
        yield syntheticPlanError(u.toolUseId, u.reason);
      }
    }

    for (const wave of plan.waves) {
      // Submit the entire wave before draining so the executor's own
      // batch concurrency applies to this wave's tools. This is the
      // same shape as the legacy "submit all tools in a batch" path,
      // just with the wave boundary imposed by the planner.
      for (const tu of wave.toolUses) {
        this.executor.addTool({ id: tu.toolUseId, name: tu.toolName, input: tu.input });
      }

      // Track which tool-use ids in this wave still need to complete.
      // The executor's drain emits every progress / completion /
      // deferred-context update for the wave's tools; we yield them
      // through untouched and break out the moment every tool in the
      // wave has produced its final tool_result.
      const pendingIds = new Set(wave.toolUses.map((t) => t.toolUseId));

      for await (const update of this.executor.getRemainingResults()) {
        yield update;
        if (update.message?.tool_call_id && pendingIds.has(update.message.tool_call_id)) {
          pendingIds.delete(update.message.tool_call_id);
          if (pendingIds.size === 0) break;
        }
      }
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
    // Drop any buffered addTool calls so a discarded executor does
    // not run tools whose plan was never consumed. The agent calls
    // `discard()` after the max_tokens fail-fast path, where every
    // truncated tool_use must be rejected before the next LLM call.
    this.pendingTools.length = 0;
    this.plan = null;
    this.planEmittedUnresolved = false;
    this.executor.discard();
  }

  dispose(): void {
    this.pendingTools.length = 0;
    this.plan = null;
    this.planEmittedUnresolved = false;
    this.executor.dispose();
  }

  /**
   * Build the execution plan lazily on first `getRemainingResults` so
   * callers can keep appending via `addTool` until they are ready to
   * drain. When no resolvers are supplied (legacy callers, unit tests
   * that do not exercise the dependency graph) the plan collapses to
   * a single wave containing every buffered tool in arrival order —
   * identical to the pre-2b batched `addTool` flow.
   */
  private ensurePlan(): ExecutionPlan {
    if (this.plan !== null) return this.plan;

    const orchestrationInputs: OrchestrationToolUse[] = this.pendingTools.map((tool) => {
      const dependencies =
        this.dependencyResolver?.(tool.name) ??
        (this.toolRegistry.getExecutor(tool.name) as
          | (ToolExecutor & { dependencies?: ToolDependencyDeclaration })
          | undefined)?.dependencies;
      const writeResolver =
        this.writePathResolver?.(tool.name) ??
        (this.toolRegistry.getExecutor(tool.name) as
          | (ToolExecutor & {
              extractWritePaths?: (input: Record<string, unknown>) => readonly string[];
            })
          | undefined)?.extractWritePaths;
      const readResolver =
        this.readPathResolver?.(tool.name) ??
        (this.toolRegistry.getExecutor(tool.name) as
          | (ToolExecutor & {
              extractReadPaths?: (input: Record<string, unknown>) => readonly string[];
            })
          | undefined)?.extractReadPaths;
      const input = (tool.input ?? {}) as Record<string, unknown>;
      return {
        toolUseId: tool.id,
        toolName: tool.name,
        input,
        dependencies,
        extractWritePaths: writeResolver,
        extractReadPaths: readResolver,
      };
    });

    this.plan = planExecution(orchestrationInputs);
    // Keep the buffer around only long enough for the planner to read
    // it; the executor's own queue owns scheduling from here on.
    this.pendingTools.length = 0;
    return this.plan;
  }
}