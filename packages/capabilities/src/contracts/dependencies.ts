/**
 * Tool dependency declarations — Plan 550 step 3a.
 *
 * The current orchestrator (tool/orchestration/{types,classify}.ts) gates
 * tool execution on three coarse batches (READ / WRITE / SYSTEM) and the
 * per-tool `isConcurrencySafe()` boolean. That model cannot express
 * "this tool writes the same path as that tool, so they must serialise"
 * or "this tool needs the result of `session_search` before it runs".
 *
 * This file introduces the typed dependency declaration that the new
 * `DependencyGraphOrchestrator` (3b) will consume. Each field is
 * additive — tools that omit the declaration keep the legacy default
 * (batch + isConcurrencySafe, fail-closed to serial).
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

/**
 * Declarative dependency description. Every field is optional; an
 * empty declaration means the tool is free to run in parallel with any
 * other tool that is not otherwise gating it.
 */
export interface ToolDependencyDeclaration {
  /**
   * Tool names whose `tool_result` MUST be available before this tool
   * runs. The orchestrator resolves this against the LLM's tool_uses
   * within the same turn and queues the dependency before the
   * dependent call. Default: `[]`.
   */
  readonly requires?: readonly string[];

  /**
   * Logical resource keys this tool produces (e.g.
   * `'git_status'`, `'session_search_results'`). Other tools that
   * declare `consumes: ['git_status']` MUST wait for this one. Default:
   * `[]`.
   */
  readonly produces?: readonly string[];

  /**
   * Logical resource keys this tool consumes. The orchestrator MUST
   * serialise this tool after every producer that declares the same
   * key. Default: `[]`.
   */
  readonly consumes?: readonly string[];

  /**
   * Filesystem paths this tool mutates. The orchestrator MUST
   * serialise every tool that touches the same path (read-only tools
   * may still run in parallel against a writer because they observe a
   * snapshot, not a lock).
   *
   * The orchestrator pulls the path set from the tool's input via the
   * per-tool `extractWritePaths(input)` helper (3c); if the tool does
   * not implement that helper the orchestrator treats the path as
   * unknown and falls back to the legacy batch behaviour. Default: `[]`.
   */
  readonly writePaths?: readonly string[];

  /**
   * Filesystem paths this tool reads. The orchestrator MAY run other
   * reads in parallel with this one; the orchestrator MUST serialise
   * this tool against any writer that touches the same path. Default:
   * `[]`.
   */
  readonly readPaths?: readonly string[];
}

/**
 * Sentinel returned by `extractWritePaths`/`extractReadPaths` when the
 * tool input does not expose a path — the orchestrator treats the path
 * set as unknown and falls back to the legacy `WRITE` batch, i.e. the
 * tool runs alone. This is the conservative default and avoids racing
 * a writer that targets an opaque input shape.
 */
export const UNKNOWN_PATHS: readonly string[] = Object.freeze(['__unknown__']);

/**
 * Helper for tool implementations that declare `writePaths` /
 * `readPaths`. Tools that know which filesystem paths they touch
 * override `extractWritePaths`/`extractReadPaths` so the orchestrator
 * can do precise serialisation. Tools that do not override the helpers
 * inherit `UNKNOWN_PATHS` from `BaseTool` and are conservatively
 * serialised.
 */
export interface PathExtractingTool {
  extractWritePaths?(input: Record<string, unknown>): readonly string[];
  extractReadPaths?(input: Record<string, unknown>): readonly string[];
}

/**
 * Empty / default declaration. Useful as a fallback for tools that do
 * not declare dependencies.
 */
export const NO_DEPENDENCIES: Readonly<ToolDependencyDeclaration> = Object.freeze(
  {} as ToolDependencyDeclaration,
);

/**
 * Normalise a raw `ToolDependencyDeclaration` (possibly undefined,
 * possibly with `undefined` members) into a fully-populated
 * declaration with defaulted arrays. Centralising this keeps the
 * orchestrator code branch-free.
 */
export function normaliseDependencies(
  raw: ToolDependencyDeclaration | undefined,
): Required<ToolDependencyDeclaration> {
  return {
    requires: raw?.requires ?? [],
    produces: raw?.produces ?? [],
    consumes: raw?.consumes ?? [],
    writePaths: raw?.writePaths ?? [],
    readPaths: raw?.readPaths ?? [],
  };
}