/**
 * Dependency-graph orchestrator — Plan 550 step 3b.
 *
 * The legacy orchestrator (`tool/orchestration/{types,classify}.ts`) maps
 * every tool to one of three coarse batches (READ / WRITE / SYSTEM) and
 * serialises writes by default. That model cannot express "two writes
 * against disjoint paths run in parallel" or "tool X must wait for the
 * `git_status` producer before it runs".
 *
 * `DependencyGraphOrchestrator` consumes the per-tool
 * `ToolDependencyDeclaration` from 3a and computes a topologically
 * ordered execution plan. Tools with no dependencies run in parallel
 * up to `maxConcurrency`; tools that share a `writePaths` set
 * serialise against each other; a tool's `readPaths` serialise it
 * against any writer touching the same path (reads stay parallel with
 * each other); tools that declare `requires` wait for the named tools.
 *
 * This file is the **minimum viable** implementation: pure scheduling
 * logic over an in-memory graph. StreamingToolExecutor wiring (3c)
 * and live test-coverage against an LLM-emitted batch (3d) come next.
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import {
  normaliseDependencies,
  UNKNOWN_PATHS,
  type ToolDependencyDeclaration,
} from '../dependencies.js';

/**
 * A single tool_use emitted by the LLM in one turn.
 *
 * `input` is captured so per-tool `extractWritePaths(input)` can resolve
 * the runtime path set; `dependencies` is the static declaration carried
 * over from the registry entry.
 */
export interface OrchestrationToolUse {
  /** Unique tool-use id from the LLM response. */
  toolUseId: string;
  /** Tool name (matches `ToolDefinition.name`). */
  toolName: string;
  /** Input object passed to the tool's `execute`. */
  input: Record<string, unknown>;
  /** Per-tool dependency declaration (from 3a). */
  dependencies?: ToolDependencyDeclaration;
  /**
   * Optional per-tool hooks to resolve the runtime path set from the
   * input. Tools that override these get precise path-level serialisation;
   * tools that omit them inherit `UNKNOWN_PATHS` from the static
   * declaration.
   */
  extractWritePaths?: (input: Record<string, unknown>) => readonly string[];
  extractReadPaths?: (input: Record<string, unknown>) => readonly string[];
}

/**
 * One scheduled slot in the execution plan. All tools in the same
 * `wave` index can run in parallel (subject to per-wave concurrency);
 * `wave`s themselves run sequentially.
 */
export interface ExecutionWave {
  /** Zero-based wave index. Waves run in ascending order. */
  index: number;
  /** Tool-uses that belong to this wave. */
  toolUses: OrchestrationToolUse[];
}

/**
 * Result of `planExecution` — the complete wave schedule plus the
 * residual tool-uses that could not be scheduled (cyclic dependencies,
 * unknown-prerequisite tools, etc.). Callers must surface the
 * `unresolved` list so the user sees why a tool never ran.
 */
export interface ExecutionPlan {
  waves: ExecutionWave[];
  unresolved: Array<{ toolUseId: string; reason: string }>;
}

/**
 * Default per-wave concurrency. Matches the legacy READ batch limit
 * (Plan 429 §2.2) so migrations do not regress wall-clock latency.
 */
export const DEFAULT_MAX_CONCURRENCY = 5;

/**
 * Compute the execution plan for a batch of tool-uses.
 *
 * Algorithm:
 *
 *   1. Build a name-keyed index of every tool-use in the batch (for
 *      `requires` lookups). Missing names make the tool "unresolved".
 *   2. Resolve the runtime write-path and read-path sets for each tool-use
 *      via `extractWritePaths(input)` / `extractReadPaths(input)`; tools
 *      without an extractor inherit the static array. The `__from_input__`
 *      sentinel means "compute from input"; `UNKNOWN_PATHS` means "could
 *      not", and acts as a wildcard against every other path.
 *   3. Greedily schedule tool-uses into waves. A tool-use is ready when:
 *        - Every name in its `requires` set has been scheduled in an
 *          earlier wave.
 *        - It does not share a write-path with any tool-use already
 *          scheduled in the current wave.
 *        - It does not read a path that a writer in the current wave
 *          touches, and does not write a path that a reader in the
 *          current wave touches. Reads never conflict with reads, so
 *          read-only batches pack exactly as before.
 *   4. When no tool-use is ready but the batch is not empty, the batch
 *      has a cycle — the offending tool-uses move to `unresolved` and
 *      the planner returns.
 *
 * @param toolUses      The tool-uses the LLM returned in this turn.
 * @param maxConcurrency  Maximum tool-uses allowed per wave. Default 5.
 */
export function planExecution(
  toolUses: readonly OrchestrationToolUse[],
  maxConcurrency: number = DEFAULT_MAX_CONCURRENCY,
): ExecutionPlan {
  const byName = new Map<string, OrchestrationToolUse[]>();
  for (const toolUse of toolUses) {
    const list = byName.get(toolUse.toolName) ?? [];
    list.push(toolUse);
    byName.set(toolUse.toolName, list);
  }

  const unresolved: ExecutionPlan['unresolved'] = [];
  const scheduled = new Set<string>();
  const waves: ExecutionWave[] = [];

  // Pre-resolve the write-path set for every tool-use; tools whose
  // declaration points at the `__from_input__` sentinel need their
  // extractor; tools with no declaration are treated as no-write.
  const writePathsFor = (toolUse: OrchestrationToolUse): readonly string[] => {
    const decl = normaliseDependencies(toolUse.dependencies);
    if (decl.writePaths.length === 0) return [];
    const hasFromInput = decl.writePaths.includes('__from_input__');
    if (!hasFromInput) return decl.writePaths;
    const extracted = toolUse.extractWritePaths?.(toolUse.input);
    return extracted ?? UNKNOWN_PATHS;
  };

  // Same resolution on the read side. This used to be plumbed all the way
  // from ToolExecutionPipeline and then never read, which made the
  // documented read/write serialisation a silent no-op.
  const readPathsFor = (toolUse: OrchestrationToolUse): readonly string[] => {
    const decl = normaliseDependencies(toolUse.dependencies);
    if (decl.readPaths.length === 0) return [];
    const hasFromInput = decl.readPaths.includes('__from_input__');
    if (!hasFromInput) return decl.readPaths;
    const extracted = toolUse.extractReadPaths?.(toolUse.input);
    return extracted ?? UNKNOWN_PATHS;
  };

  /**
   * True when `paths` touches anything already claimed by `claimed`, with
   * `UNKNOWN_PATHS` acting as a wildcard on either side: a path we could not
   * resolve conflicts with everything, exactly like the write-side rule.
   */
  const conflictsWith = (paths: readonly string[], claimed: ReadonlySet<string>): boolean => {
    if (paths.length === 0 || claimed.size === 0) return false;
    if (paths.includes(UNKNOWN_PATHS[0])) return true;
    for (const path of claimed) {
      if (path === UNKNOWN_PATHS[0] || paths.includes(path)) return true;
    }
    return false;
  };

  while (scheduled.size < toolUses.length) {
    const wave: OrchestrationToolUse[] = [];
    const waveWritePaths = new Set<string>();
    const waveReadPaths = new Set<string>();

    for (const toolUse of toolUses) {
      if (scheduled.has(toolUse.toolUseId)) continue;
      if (wave.length >= maxConcurrency) break;

      // Prerequisite check: every name in `requires` must already be
      // scheduled. A name we have not seen in this batch is treated as
      // missing — the tool will be flagged `unresolved` below.
      const decl = normaliseDependencies(toolUse.dependencies);
      const unmet: string[] = [];
      for (const requiredName of decl.requires) {
        const requiredInstances = byName.get(requiredName);
        if (!requiredInstances || requiredInstances.length === 0) {
          unmet.push(requiredName);
          continue;
        }
        const allScheduled = requiredInstances.every((instance) =>
          scheduled.has(instance.toolUseId),
        );
        if (!allScheduled) unmet.push(requiredName);
      }
      if (unmet.length > 0) continue;

      // Write-path serialisation: this tool-use may not share a write
      // path with anything already in the current wave.
      const myWrites = writePathsFor(toolUse);
      if (conflictsWith(myWrites, waveWritePaths)) {
        continue;
      }

      // Read/write serialisation: a read may not share a path with a
      // writer already in the wave, and a writer may not clobber a path a
      // reader in this wave is about to observe. Reads never block other
      // reads — two reads of the same file are safe in parallel — so the
      // existing read-only batching is untouched.
      const myReads = readPathsFor(toolUse);
      if (conflictsWith(myReads, waveWritePaths)) {
        continue;
      }
      if (conflictsWith(myWrites, waveReadPaths)) {
        continue;
      }

      wave.push(toolUse);
      for (const path of myWrites) waveWritePaths.add(path);
      for (const path of myReads) waveReadPaths.add(path);
    }

    if (wave.length === 0) {
      // Nothing made progress — the remaining tool-uses are stuck.
      // Pick the first unscheduled one and flag it; the caller decides
      // whether to retry, surface to the user, or fail the turn.
      for (const toolUse of toolUses) {
        if (scheduled.has(toolUse.toolUseId)) continue;
        const decl = normaliseDependencies(toolUse.dependencies);
        const unmet = decl.requires.filter(
          (name) => !byName.has(name),
        );
        unresolved.push({
          toolUseId: toolUse.toolUseId,
          reason:
            unmet.length > 0
              ? `unmet prerequisite: ${unmet.join(', ')}`
              : 'cyclic or contended dependency',
        });
        scheduled.add(toolUse.toolUseId);
        break;
      }
      continue;
    }

    for (const toolUse of wave) scheduled.add(toolUse.toolUseId);
    waves.push({ index: waves.length, toolUses: wave });
  }

  return { waves, unresolved };
}