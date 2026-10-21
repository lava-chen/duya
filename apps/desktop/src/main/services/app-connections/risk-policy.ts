/**
 * Annotation-driven risk policy for Remote MCP tools (Plan 449 Phase A).
 *
 * Codex parity: `AppToolPolicyEvaluator` reads tool annotations
 * (`readOnlyHint` / `destructiveHint` / `openWorldHint`) published by the
 * hosted MCP server in `tools/list` and derives a risk tier, instead of
 * pinning every remote tool to `modify` and prompting on every call.
 *
 * Mapping (conservative by design — the MCP spec defaults both hints to the
 * dangerous side when absent):
 *
 * | annotations                              | tier      | gate behavior        |
 * |------------------------------------------|-----------|----------------------|
 * | missing / empty                          | `modify`  | ask (fail closed)    |
 * | `readOnlyHint === true`                  | `read`    | auto-execute         |
 * | `destructiveHint === true`               | `modify`  | ask                  |
 * | anything else                            | `modify`  | ask                  |
 *
 * The evaluator NEVER returns `write` or `destructive`: annotation hints are
 * server-authored metadata and must not unlock silent writes or bypass the
 * destructive strong-confirm. `openWorldHint` is informational only — it does
 * not change the tier.
 */

import type { RiskTier } from './types.js';

/**
 * Subset of the MCP SDK `ToolAnnotations` we consume. Kept structural so the
 * electron package does not import from `@modelcontextprotocol/sdk`.
 */
export interface RemoteToolAnnotations {
  /** Human-readable display title (used for approval templates). */
  title?: string;
  /** If true, the tool does not modify its environment. */
  readOnlyHint?: boolean;
  /**
   * If true, the tool may perform destructive updates (spec default: true
   * when readOnlyHint is false). Only meaningful when it is explicitly true.
   */
  destructiveHint?: boolean;
  /** If true, repeated calls with the same args have no additional effect. */
  idempotentHint?: boolean;
  /** If true, the tool may interact with an open world of external entities. */
  openWorldHint?: boolean;
}

/** Tier provenance surfaced alongside the descriptor for auditability. */
export type RiskTierSource = 'annotations' | 'fallback';

export interface EvaluatedRiskTier {
  tier: RiskTier;
  source: RiskTierSource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalize an unknown `tools/list` entry into typed annotations (or undefined). */
export function parseRemoteToolAnnotations(value: unknown): RemoteToolAnnotations | undefined {
  if (!isRecord(value)) return undefined;
  const out: RemoteToolAnnotations = {};
  let hasAny = false;
  for (const key of ['title', 'readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
    const raw = value[key];
    if (raw === undefined || raw === null) continue;
    if (key === 'title') {
      if (typeof raw === 'string' && raw.trim()) {
        out.title = raw.trim();
        hasAny = true;
      }
    } else if (typeof raw === 'boolean') {
      out[key] = raw;
      hasAny = true;
    }
  }
  return hasAny ? out : undefined;
}

/**
 * Derive the risk tier for a remote tool from its annotations.
 *
 * Fail-closed rule: absent or uninformative annotations keep the historical
 * `'modify'` tier (confirm every call). Only an explicit `readOnlyHint: true`
 * earns silent execution.
 */
export function evaluateRemoteToolRiskTier(
  annotations: RemoteToolAnnotations | undefined,
): EvaluatedRiskTier {
  if (!annotations) return { tier: 'modify', source: 'fallback' };
  if (annotations.readOnlyHint === true && annotations.destructiveHint !== true) {
    return { tier: 'read', source: 'annotations' };
  }
  return { tier: 'modify', source: 'fallback' };
}
