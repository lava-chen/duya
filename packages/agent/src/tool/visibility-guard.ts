import { logger } from '../utils/logger.js';

/**
 * Declared-tools visibility guard (four-tier exposure model).
 *
 * The request's tools array deliberately omits some registered tools:
 * `discoverable` tools are absent until found via tool_search, and
 * `hidden` tools are never exposed at all. A model call whose tool name is
 * NOT declared on the current request (not in the array) is therefore an
 * undeclared call — it is always rejected with a structured message
 * pointing the model at the sanctioned path:
 * tool_search → tool_schema → tool_invoke.
 *
 * Declared tools = `always` full entries + `hint` stub entries (+ promoted
 * discoverables merged into the array). The guard decision is pure so the
 * harness replays it without spinning the agent loop; the rejection
 * telemetry below keeps a per-name counter for debugging.
 *
 * Process-wide counters (a false positive only costs a log line, so
 * per-session isolation is unnecessary).
 */

const undeclaredCallCounts = new Map<string, number>();

/**
 * Record an undeclared (rejected) direct tool call. Returns the running
 * count for the tool name (useful for the caller if it wants to log once
 * per N).
 */
export function recordUndeclaredCall(toolName: string): number {
  const count = (undeclaredCallCounts.get(toolName) ?? 0) + 1;
  undeclaredCallCounts.set(toolName, count);
  logger.warn(
    `[VisibilityGuard] rejected direct call to tool not declared on the request's tools array: "${toolName}" (count=${count}). ` +
      'Discover via tool_search, read the schema via tool_schema, invoke via tool_invoke.',
  );
  return count;
}

/** Snapshot of the counters (tool name → call count). */
export function readUndeclaredCallStats(): Record<string, number> {
  return Object.fromEntries(undeclaredCallCounts);
}

/** Reset counters (tests / turn boundaries). */
export function resetUndeclaredCallStats(): void {
  undeclaredCallCounts.clear();
}

export interface VisibilityGuardInput {
  /** Tool names declared on the current request's tools array. */
  declaredTools: ReadonlySet<string>;
  /** The tool name the model is trying to call. */
  toolName: string;
}

export interface VisibilityGuardResult {
  undeclared: boolean;
  message?: string;
}

export const VISIBILITY_DENIAL_MESSAGE = (toolName: string): string =>
  `Tool \`${toolName}\` is not in this request's tool list. ` +
  `Find it with \`tool_search\`, read its schema with \`tool_schema\`, then invoke it via \`tool_invoke\`. ` +
  `Direct calls to undeclared tools are rejected.`;

export function evaluateVisibilityGuard(
  input: VisibilityGuardInput,
): VisibilityGuardResult {
  if (input.declaredTools.has(input.toolName)) {
    return { undeclared: false };
  }
  return {
    undeclared: true,
    message: VISIBILITY_DENIAL_MESSAGE(input.toolName),
  };
}
