/**
 * Unified tool test harness (Plan 481 §2.3).
 *
 * One fixture module that every tool unit test builds on, replacing the
 * hand-rolled registries / stub executors / ad-hoc contexts each tool test
 * previously re-invented (plan480-meta-tools.test.ts, plan477 dm tests, ...).
 *
 * Design constraints:
 *   - Pure fixtures only: no vitest imports, no Electron imports. Tests use
 *     their own `expect` against the plain values returned here.
 *   - Mirrors the real executor contract: `callTool` walks the same stages
 *     StreamingToolExecutor does (lookup → validateInput → checkPermissions
 *     → execute) so a tool exercised through the harness is exercised the
 *     way production runs it.
 *   - The permission stage returns the tool's raw `PermissionCheckResult`
 *     instead of simulating user interaction; tests that need the ask-path
 *     assert on `requiresUserConfirmation` directly.
 */

import type {
  AppState,
  Tool,
  ToolUseContext,
} from '../types.js';
import type {
  PermissionCheckResult,
  ToolContext,
  ToolResult,
  ToolValidationResult,
} from './types.js';
import { ToolRegistry, type ToolExecutor, type ToolMetaInput } from './registry.js';

// ============================================================
// Registry fixture
// ============================================================

export interface HarnessToolEntry {
  tool: Tool;
  executor?: ToolExecutor;
  /** Extra registration meta (exposeMode / riskTier / inputSchemaSummary). */
  meta?: ToolMetaInput;
}

/**
 * Build a ToolRegistry from a mixed list of tools (bare `Tool` definitions
 * self-register with themselves as executor — the common builtin pattern)
 * or explicit {tool, executor, meta} entries.
 */
export function createTestRegistry(
  entries: Array<Tool | HarnessToolEntry>,
): ToolRegistry {
  const registry = new ToolRegistry();
  for (const entry of entries) {
    const isEntry = !('toTool' in entry) && 'tool' in entry;
    if (!isEntry) {
      const tool = entry as Tool;
      const executor = entry as unknown as ToolExecutor;
      registry.register(tool, executor);
      continue;
    }
    const { tool, executor, meta } = entry as HarnessToolEntry;
    registry.register(tool, executor ?? (tool as unknown as ToolExecutor), meta);
  }
  return registry;
}

// ============================================================
// Recording executor stub
// ============================================================

export interface RecordedCall {
  input: Record<string, unknown>;
  workingDirectory?: string;
}

export interface RecordingExecutor extends ToolExecutor {
  calls: RecordedCall[];
  /** Result returned by the stub, or null to produce a default success. */
  cannedResult: Omit<ToolResult, 'id' | 'name'> | null;
}

/**
 * Stub executor that records every call and returns a canned structured
 * result. Default result is a minimal success payload.
 */
export function recordingExecutor(
  cannedResult?: Omit<ToolResult, 'id' | 'name'> | null,
): RecordingExecutor {
  return {
    calls: [],
    cannedResult: cannedResult ?? null,
    async execute(input, workingDirectory) {
      this.calls.push({ input, workingDirectory });
      const canned = this.cannedResult ?? { result: JSON.stringify({ ok: true }) };
      return {
        id: 'stub-result-id',
        name: 'stub-tool',
        ...canned,
      };
    },
  };
}

// ============================================================
// Context fixtures
// ============================================================

export interface ToolContextFixture {
  toolUseContext: ToolUseContext;
  /** ToolContext the way StreamingToolExecutor builds it for checkPermissions. */
  toolContext: ToolContext;
  /** In-memory app state shared by both contexts. */
  appState: AppState;
  /** Permission requests raised via ToolUseContext.requestPermission. */
  permissionRequests: unknown[];
}

/**
 * Full ToolUseContext + ToolContext pair backed by an in-memory app state
 * and a recording requestPermission hook.
 */
export function createToolContext(
  overrides: {
    sessionId?: string;
    workingDirectory?: string;
    tools?: Tool[];
    appState?: AppState;
    agentProfileId?: string | null;
    requestPermission?: (request: unknown) => Promise<'allow' | 'deny' | 'paused'>;
    extraOptions?: Record<string, unknown>;
  } = {},
): ToolContextFixture {
  const appState: AppState = overrides.appState ? { ...overrides.appState } : {};
  const permissionRequests: unknown[] = [];
  const sessionId = overrides.sessionId ?? 'test-session-id';
  const workingDirectory = overrides.workingDirectory ?? '/tmp/test-workspace';

  const toolUseContext: ToolUseContext = {
    toolUseId: 'test-tool-use-id',
    getAppState: () => appState,
    setAppState: (updater) => {
      const next = updater(appState);
      Object.keys(appState).forEach((k) => delete appState[k]);
      Object.assign(appState, next);
    },
    abortController: new AbortController(),
    options: {
      tools: overrides.tools ?? [],
      commands: [],
      mainLoopModel: 'test-model',
      mcpClients: [],
      sessionId,
      agentProfileId: overrides.agentProfileId ?? null,
      ...(overrides.extraOptions ?? {}),
    },
    requestPermission: async (request) => {
      permissionRequests.push(request);
      if (overrides.requestPermission) return overrides.requestPermission(request);
      return 'deny';
    },
  };

  const toolContext: ToolContext = {
    toolUseId: toolUseContext.toolUseId,
    workingDirectory,
    abortController: toolUseContext.abortController,
    sessionId,
    getAppState: toolUseContext.getAppState,
  };

  return { toolUseContext, toolContext, appState, permissionRequests };
}

// ============================================================
// Result helpers
// ============================================================

/** Parsed JSON body of a structured tool result (falls back to the raw string). */
export function resultPayload(result: ToolResult): Record<string, unknown> | string {
  try {
    return JSON.parse(result.result) as Record<string, unknown>;
  } catch {
    return result.result;
  }
}

export function isToolError(result: ToolResult): boolean {
  return result.error === true;
}

// ============================================================
// callTool — executor-contract driver
// ============================================================

export interface CallToolOutcome {
  definition: Tool | undefined;
  validation: ToolValidationResult | null;
  /** Raw checkPermissions result; null when the tool declares no check. */
  permission: PermissionCheckResult | null;
  result: ToolResult | null;
}

/**
 * Drive a registered tool through the executor contract:
 * lookup → validateInput → checkPermissions → execute.
 *
 * Stops at the first failing stage and reports everything that ran, so a
 * test can assert exactly where a call was rejected. `context` may come
 * from `createToolContext` or be supplied by hand.
 */
export async function callTool(
  registry: ToolRegistry,
  name: string,
  input: Record<string, unknown>,
  context: ToolContextFixture,
  workingDirectory?: string,
): Promise<CallToolOutcome> {
  const definition = registry.getTool(name);
  const executor = registry.getExecutor(name);
  if (!definition || !executor) {
    return { definition: undefined, validation: null, permission: null, result: null };
  }

  // Tools registered via the loose `Tool` shape (e.g. toTool() + class
  // executor) may not carry validateInput — BaseTool.call is the only
  // production caller, so the stage is optional here too.
  const looseDef = definition as unknown as {
    validateInput?: (input: unknown) => ToolValidationResult;
  };
  const validation =
    typeof looseDef.validateInput === 'function'
      ? looseDef.validateInput(input)
      : ({ success: true, data: input } as ToolValidationResult);
  if (!validation.success) {
    return { definition, validation, permission: null, result: null };
  }

  const permission =
    executor && 'checkPermissions' in executor
      ? (
          executor as {
            checkPermissions: (input: unknown, context: ToolContext) => PermissionCheckResult;
          }
        ).checkPermissions(input, context.toolContext)
      : null;

  const result = await executor.execute(input, workingDirectory ?? context.toolContext.workingDirectory, context.toolUseContext);
  return { definition, validation, permission, result };
}
