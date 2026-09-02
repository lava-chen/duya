import { logger } from '../utils/logger.js';

/**
 * Plan 480 P2.4 — warn-only visibility guard (灰度前半，§8.3).
 *
 * Under `exposure = "catalog"` the request's tools array deliberately omits
 * MCP tools. A model that still calls a real tool name directly (because it
 * saw the name in the catalog directory) would currently execute anyway —
 * duya's execution harness resolves any registered tool, not just declared
 * ones. Before enforcing a structured rejection (P2.5) we measure how often
 * that happens: every undeclared call is counted + logged here so the
 * compliance rate can drive the enforce decision.
 *
 * Process-wide counters (this is a warn-only telemetry sink; per-session
 * isolation is unnecessary because a false positive only costs a log line).
 */

const undeclaredCallCounts = new Map<string, number>();
let enabled = false;

/** Enable/disable the warn-only guard (callers read the exposure policy). */
export function setVisibilityGuardEnabled(value: boolean): void {
  enabled = value;
}

export function isVisibilityGuardEnabled(): boolean {
  return enabled;
}

/**
 * Record an undeclared direct tool call. Returns the running count for the
 * tool name (useful for the caller if it wants to log once per N).
 */
export function recordUndeclaredCall(toolName: string): number {
  const count = (undeclaredCallCounts.get(toolName) ?? 0) + 1;
  undeclaredCallCounts.set(toolName, count);
  logger.warn(
    `[VisibilityGuard:warn-only] direct call to tool not in the request's tools array: "${toolName}" (count=${count}). ` +
      'In catalog exposure the model should read schemas via tool_schema and invoke via tool_invoke.',
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
