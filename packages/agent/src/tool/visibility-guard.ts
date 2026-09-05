import { logger } from '../utils/logger.js';
import type { MCPExposureMode, CatalogGuardMode } from '../config/tool-exposure.js';

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

/**
 * Plan 480 §8.3 — pure visibility-guard decision, extracted from
 * DuyaAgent.guardedCanUseTool so the policy is unit-testable and the
 * grayscale harness can replay it without spinning the agent loop.
 *
 * Under `exposure = 'catalog'` the request's tools array deliberately omits
 * MCP tools. A model that calls a real tool name directly (name seen in the
 * catalog directory) is "undeclared":
 *   - `reject: true`  (enforce) → caller returns a structured denial.
 *   - `reject: false` (warn)    → caller still executes but records the call
 *                                (the warn-only telemetry sink above).
 * In `full`/`search` exposure the guard is disabled (no undeclared concept).
 *
 * The exact denial message is exported as a constant so DuyaAgent and any
 * test assert on a single source of truth (the harness verifies the loop
 * returns this verbatim under enforce).
 */
export interface CatalogVisibilityGuardInput {
  exposure: MCPExposureMode;
  catalogGuard: CatalogGuardMode;
  /** Tool names present in the current request's tools array. */
  declaredTools: ReadonlySet<string>;
  /** The tool name the model is trying to call. */
  toolName: string;
}

export interface CatalogVisibilityGuardResult {
  undeclared: boolean;
  reject: boolean;
  message?: string;
}

export const CATALOG_VISIBILITY_DENIAL_MESSAGE = (toolName: string): string =>
  `Tool \`${toolName}\` is not in this request's tool list (catalog exposure). ` +
  `Read its schema with \`tool_schema\` first, then invoke it via \`tool_invoke\`. ` +
  `Direct calls to undeclared tools are rejected.`;

export function evaluateCatalogVisibilityGuard(
  input: CatalogVisibilityGuardInput,
): CatalogVisibilityGuardResult {
  const guardEnabled = input.exposure === 'catalog';
  if (!guardEnabled) return { undeclared: false, reject: false };
  if (input.declaredTools.has(input.toolName)) {
    return { undeclared: false, reject: false };
  }
  return {
    undeclared: true,
    reject: input.catalogGuard === 'enforce',
    message: CATALOG_VISIBILITY_DENIAL_MESSAGE(input.toolName),
  };
}
