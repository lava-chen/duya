/**
 * Dependency-graph orchestrator — Plan 550 step 3b, extended by Plan 587
 * M5.4.
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
 * up to `maxConcurrency`; tools that share a path serialise against
 * each other; tools that declare `requires` wait for the named tools.
 *
 * Plan 587 M5.4 additions, all inside the same pure planner:
 *
 *   - **Read/write conflicts.** 3b only ever compared *write* paths, so a
 *     `ReadTool` and a `WriteTool` aimed at the same file were scheduled
 *     in the same wave and raced. Reads and writes now share one path
 *     comparison, and a conflict exists whenever *at least one* side
 *     mutates. Read/read stays parallel.
 *   - **Canonical paths.** 3b compared raw strings, so two spellings of
 *     one file (`a/../a/f.ts`, a symlinked worktree, a case difference on
 *     a case-insensitive filesystem) did not compare equal and the two
 *     writes ran concurrently. The planner now folds every path through
 *     an injected `PathCanonicaliser` before comparing. The planner
 *     itself stays pure — the filesystem lives behind the port.
 *   - **Symmetric unknown handling.** 3b only blocked a *later* tool when
 *     the *later* tool had unknown paths, so an opaque writer did not
 *     stop a subsequent concrete writer. Opaque tools now conflict in
 *     both directions.
 *   - **`produces` / `consumes`.** The declaration type documented
 *     resource-key ordering as a MUST but the planner never evaluated
 *     it. A consumer now waits for every producer of the same key.
 *
 * This file is the **single** source of truth for tool scheduling.
 * `ToolExecutionPipeline` drives it wave by wave; the batch scheduler
 * that used to live beside it has been retired (Plan 587 M5.4).
 *
 * @see docs/exec-plans/active/587-agent-harness-monorepo/06-package-and-host-migration.md
 */

import {
  normaliseDependencies,
  UNKNOWN_PATHS,
  type ToolDependencyDeclaration,
} from '../dependencies.js';
import { createLexicalCanonicaliser, type PathCanonicaliser } from './canonical-path.js';

export type { PathCanonicaliser } from './canonical-path.js';
export {
  createLexicalCanonicaliser,
  createRealpathCanonicaliser,
} from './canonical-path.js';

const UNKNOWN = UNKNOWN_PATHS[0];

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

/** Optional planner inputs that are not positional. */
export interface PlanExecutionOptions {
  /**
   * Folds a declared path into a canonical form before comparison.
   * Defaults to `createLexicalCanonicaliser()`, which normalises
   * separators and `.` / `..` segments and folds case on
   * case-insensitive platforms, but performs no filesystem access.
   * Production wiring injects `createRealpathCanonicaliser()` so that
   * symlink and junction aliases of one file serialise against each
   * other.
   */
  canonicaliser?: PathCanonicaliser;
}

/**
 * The set of paths one tool-use touches, already canonicalised, plus
 * the two "we could not work this out" flags.
 *
 * `unknownRead` / `unknownWrite` are kept separate from the path sets on
 * purpose: an opaque *writer* is far more dangerous than an opaque
 * *reader*, and treating them identically would either serialise every
 * unknown read against every other read (losing all read parallelism) or
 * let an opaque writer run beside a concrete one (the 3b bug).
 */
interface PathFootprint {
  reads: ReadonlySet<string>;
  writes: ReadonlySet<string>;
  unknownRead: boolean;
  unknownWrite: boolean;
  produces: readonly string[];
  consumes: readonly string[];
}

const EMPTY_FOOTPRINT_PATHS: ReadonlySet<string> = new Set<string>();

/**
 * Do these two footprints conflict, i.e. must they not share a wave?
 *
 * The rules, in the order they apply:
 *
 *   1. An opaque **writer** conflicts with everything. We cannot say
 *      which file it touched, so we do not let it run beside anything.
 *   2. An opaque **reader** conflicts only with a **writer**. Two
 *      readers racing is harmless; a reader racing a writer is not.
 *   3. Otherwise, a shared canonical path is a conflict when at least
 *      one of the two mutates that path.
 *
 * A tool that declares nothing at all has an empty footprint and never
 * conflicts, which preserves the pre-3b "no declaration means run free"
 * behaviour.
 */
function footprintsConflict(a: PathFootprint, b: PathFootprint): boolean {
  if (a.unknownWrite || b.unknownWrite) return true;

  const eitherMutates = a.writes.size > 0 || b.writes.size > 0;
  if (eitherMutates && (a.unknownRead || b.unknownRead)) return true;

  if (!eitherMutates) return false;

  for (const path of a.writes) {
    if (path !== UNKNOWN && b.reads.has(path)) return true;
    if (path !== UNKNOWN && b.writes.has(path)) return true;
  }
  for (const path of a.reads) {
    if (path !== UNKNOWN && b.writes.has(path)) return true;
  }
  return false;
}

/**
 * Compute the execution plan for a batch of tool-uses.
 *
 * Algorithm:
 *
 *   1. Build a name-keyed index of every tool-use in the batch (for
 *      `requires` lookups). Missing names make the tool "unresolved".
 *   2. Resolve the runtime read- and write-path sets for each tool-use
 *      via `extractReadPaths(input)` / `extractWritePaths(input)`; tools
 *      without an extractor inherit the static declaration. The
 *      `__from_input__` sentinel means "compute from input";
 *      `UNKNOWN_PATHS` means "could not". Every resolved path is folded
 *      through the injected canonicaliser.
 *   3. Greedily schedule tool-uses into waves. A tool-use is ready when:
 *        - Every name in its `requires` set has been scheduled in an
 *          earlier wave.
 *        - It does not conflict with any tool-use already scheduled in
 *          the current wave (see `footprintsConflict`).
 *   4. When no tool-use is ready but the batch is not empty, the batch
 *      has a cycle — the offending tool-uses move to `unresolved` and
 *      the planner returns.
 *
 * @param toolUses      The tool-uses the LLM returned in this turn.
 * @param maxConcurrency  Maximum tool-uses allowed per wave. Default 5.
 * @param options        Canonicaliser injection point.
 */
export function planExecution(
  toolUses: readonly OrchestrationToolUse[],
  maxConcurrency: number = DEFAULT_MAX_CONCURRENCY,
  options: PlanExecutionOptions = {},
): ExecutionPlan {
  const canonicalise = options.canonicaliser ?? createLexicalCanonicaliser();

  const byName = new Map<string, OrchestrationToolUse[]>();
  for (const toolUse of toolUses) {
    const list = byName.get(toolUse.toolName) ?? [];
    list.push(toolUse);
    byName.set(toolUse.toolName, list);
  }

  // Resource-key producers, so a consumer can be ordered after every
  // producer of a key it consumes. This is a directional edge, not a
  // conflict: two tools that both touch the same key are allowed to
  // share a wave as long as the producer lands in an EARLIER one.
  const producersByKey = new Map<string, OrchestrationToolUse[]>();
  for (const toolUse of toolUses) {
    for (const key of normaliseDependencies(toolUse.dependencies).produces) {
      const list = producersByKey.get(key) ?? [];
      list.push(toolUse);
      producersByKey.set(key, list);
    }
  }

  const unresolved: ExecutionPlan['unresolved'] = [];
  const scheduled = new Set<string>();
  const waves: ExecutionWave[] = [];

  // Resolve one declared path list. The `__from_input__` sentinel asks
  // for the per-tool extractor; a declaration that names no paths at
  // all means "this tool declares no paths of that kind" and stays
  // empty rather than degrading to unknown.
  const resolvePaths = (
    declared: readonly string[],
    extract: ((input: Record<string, unknown>) => readonly string[]) | undefined,
    input: Record<string, unknown>,
  ): Set<string> => {
    if (declared.length === 0) return new Set<string>(EMPTY_FOOTPRINT_PATHS);
    const asksForInput = declared.includes('__from_input__');
    const raw = asksForInput ? (extract?.(input) ?? UNKNOWN_PATHS) : declared;
    const out = new Set<string>();
    for (const path of raw) {
      out.add(path === UNKNOWN ? UNKNOWN : canonicalise(path));
    }
    return out;
  };

  const footprintFor = (toolUse: OrchestrationToolUse): PathFootprint => {
    const decl = normaliseDependencies(toolUse.dependencies);
    const writes = resolvePaths(decl.writePaths, toolUse.extractWritePaths, toolUse.input);
    const reads = resolvePaths(decl.readPaths, toolUse.extractReadPaths, toolUse.input);
    return {
      reads,
      writes,
      unknownRead: reads.has(UNKNOWN),
      unknownWrite: writes.has(UNKNOWN),
      produces: decl.produces,
      consumes: decl.consumes,
    };
  };

  while (scheduled.size < toolUses.length) {
    const wave: OrchestrationToolUse[] = [];
    const waveFootprints: PathFootprint[] = [];

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
      // Resource ordering: every in-batch producer of a consumed key
      // must already be scheduled. A key nobody in this batch produces
      // is simply satisfied -- unlike a missing `requires` name, a
      // missing producer is not an error, because the resource may
      // legitimately come from an earlier turn.
      for (const key of decl.consumes) {
        const producers = producersByKey.get(key);
        if (!producers || producers.length === 0) continue;
        const allScheduled = producers.every((instance) =>
          scheduled.has(instance.toolUseId),
        );
        if (!allScheduled) unmet.push(`consumes:${key}`);
      }
      if (unmet.length > 0) continue;

      // Path / resource-key conflict check against the current wave.
      const mine = footprintFor(toolUse);
      if (waveFootprints.some((other) => footprintsConflict(other, mine))) {
        continue;
      }

      wave.push(toolUse);
      waveFootprints.push(mine);
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
