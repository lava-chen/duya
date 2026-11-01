/**
 * Real-target resolution seam (plan: 2026-10-31 tool surface & harness
 * convergence, W1).
 *
 * The scheduling layer historically classifies by the OUTER tool name only:
 * a `tool_invoke` wrapper lands in the fail-closed SYSTEM batch and carries
 * no dependency declaration, while the same target called directly is
 * classified (and wave-planned) as itself — F17/F26's mode cliff.
 *
 * This module declares the MINIMUM immutable view scheduling needs about the
 * real target behind an outer call. It is intentionally a plain data shape:
 *
 *   - produced by a read-only resolver (the discovery layer owns the lookup;
 *     see `discovery/real-target.ts`), never by execution itself;
 *   - consumed only for scheduling (batch + wave planning). It grants NO
 *     permission and performs NO side effect; the deferred dispatcher still
 *     re-resolves the live entry and re-validates arguments before every
 *     execution (plan 580 D8 / F18), so a stale view can never authorize
 *     anything.
 */
import type { ToolDependencyDeclaration } from '@duya/capabilities/contracts';
import type { ToolBatch } from './orchestration/types.js';

/** Structural subset of an outer tool call the resolver may inspect. */
export interface SchedulingCall {
  id: string;
  name: string;
  input?: unknown;
}

/** What scheduling learns about the real target behind an outer call. */
export interface SchedulingTargetView {
  /** Stable catalog ID of the resolved target. */
  toolId: string;
  /** Real target name (the name a direct call would have used). */
  targetName: string;
  /**
   * The batch the target would receive as a DIRECT call (`classifyTool`
   * over `targetName`). `undefined` means "no confident view — keep the
   * outer name's own classification", which for `tool_invoke` is the
   * fail-closed SYSTEM batch.
   */
  batch?: ToolBatch;
  /** The target executor's own dependency declaration, if it opted in. */
  dependencies?: ToolDependencyDeclaration;
  /**
   * The target's path extractors, wrapped to unwrap the routed
   * `arguments` envelope: callers pass the OUTER call input, the wrapper
   * hands the target-level arguments to the target's own extractor.
   */
  extractWritePaths?: (input: Record<string, unknown>) => readonly string[];
  extractReadPaths?: (input: Record<string, unknown>) => readonly string[];
  /** Mirrors `ToolRegistry.isToolConcurrencySafe` for the target executor. */
  isConcurrencySafe: boolean;
}

/** Read-only resolver: outer call → real-target view, or `undefined`. */
export type SchedulingTargetResolver = (
  call: SchedulingCall,
) => SchedulingTargetView | undefined;
