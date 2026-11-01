/**
 * Real-target resolver for the scheduling seam (plan: 2026-10-31 tool
 * surface & harness convergence, W1 / F17 / F26).
 *
 * Given an outer tool call, resolve the REAL target behind a `tool_invoke`
 * wrapper into the minimal scheduling view declared by
 * `execution/real-target.ts`. This lives in discovery because the lookup
 * needs the full catalog (`ToolRegistry.getCatalogEntryById`), which the
 * execution layer's adapted registry surface deliberately does not carry;
 * the execution layer only consumes the plain view.
 *
 * Hard guarantees (W1 bullet 2):
 *
 *   - READ-ONLY: the resolver never mutates the registry, never executes,
 *     never requests permission, never touches connections. It reads one
 *     catalog entry and the target executor's declaration surface.
 *   - FAIL-CLOSED: anything it cannot resolve confidently — non-invoke
 *     outer calls, missing `tool_id`, unknown ID, or a target that is not
 *     currently invocable (eager/hidden) — returns `undefined`, and the
 *     scheduler keeps the outer name's own classification (`tool_invoke`
 *     → SYSTEM, exactly the pre-W1 behavior). The dispatcher still reports
 *     the precise named error (TOOL_NOT_FOUND / TOOL_IS_EAGER /
 *     TOOL_HIDDEN) at execution time.
 *   - PARITY, NOT RELAXATION: the batch is the one the target itself would
 *     receive as a direct call (`classifyTool(target.internalName)`). A
 *     target the direct path would run as READ schedules the invoke as
 *     READ; a SYSTEM target stays SYSTEM; a WRITE-capable executor's own
 *     write-path declarations are honored. Nothing here marks an invoke
 *     concurrent that the direct path would not run concurrently.
 */
import type { ToolRegistry } from '../catalog/registry.js';
import { classifyTool } from '../execution/orchestration/classify.js';
import type { ToolBatch } from '../execution/orchestration/types.js';
import type { SchedulingCall, SchedulingTargetView } from '../execution/real-target.js';
import type { ToolDependencyDeclaration } from '@duya/capabilities/contracts';
import { TOOL_INVOKE_NAME } from './ToolInvokeTool.js';

type InvokeExecutor = {
  dependencies?: ToolDependencyDeclaration;
  extractWritePaths?: (input: Record<string, unknown>) => readonly string[];
  extractReadPaths?: (input: Record<string, unknown>) => readonly string[];
  isConcurrencySafe?: () => boolean;
};

export function createRealTargetResolver(
  registry: Pick<ToolRegistry, 'getCatalogEntryById' | 'getExecutor'>,
): (call: SchedulingCall) => SchedulingTargetView | undefined {
  return (call: SchedulingCall): SchedulingTargetView | undefined => {
    if (call.name !== TOOL_INVOKE_NAME) return undefined;
    const input = (call.input ?? {}) as { tool_id?: unknown };
    if (typeof input.tool_id !== 'string' || input.tool_id.trim() === '') return undefined;
    const toolId = input.tool_id.trim();

    const entry = registry.getCatalogEntryById(toolId);
    // Unknown ID or not invocable through the deferred path: scheduling
    // keeps the outer name's fail-closed SYSTEM batch; dispatch reports
    // the exact error.
    if (!entry || entry.exposure !== 'deferred') return undefined;

    const executor = registry.getExecutor(entry.internalName) as InvokeExecutor | undefined;
    const view: SchedulingTargetView = {
      toolId,
      targetName: entry.internalName,
      isConcurrencySafe: typeof executor?.isConcurrencySafe === 'function'
        ? executor.isConcurrencySafe() === true
        : false,
    };
    // Target-level path extractors expect the input shape a direct call
    // delivers. A routed call carries the target arguments under the
    // wrapper's `arguments` envelope, so wrap the extractors to unwrap it;
    // a non-object envelope degrades to an empty argument object (the
    // extractor then reports unknown paths, which serialise conservatively).
    const unwrapArguments = (outer: Record<string, unknown>): Record<string, unknown> => {
      const args = outer.arguments;
      return args !== null && typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    };
    const batch: ToolBatch = classifyTool(entry.internalName);
    view.batch = batch;
    if (executor?.dependencies) view.dependencies = executor.dependencies;
    if (executor?.extractWritePaths) {
      const targetExtractor = executor.extractWritePaths;
      view.extractWritePaths = (outer) => targetExtractor(unwrapArguments(outer));
    }
    if (executor?.extractReadPaths) {
      const targetExtractor = executor.extractReadPaths;
      view.extractReadPaths = (outer) => targetExtractor(unwrapArguments(outer));
    }
    return view;
  };
}
