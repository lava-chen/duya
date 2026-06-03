// packages/agent/src/mcp/permission-gate.ts
// BLOCKER B (audit 2026-06-03): runtime permission gate for MCP tools.
//
// Before this gate, MCP tools registered through `applyMCPConfiguration`
// were dispatched directly to the underlying `MCPClient.callTool` with no
// permission decision. That meant a marketplace / local MCP server could
// silently run any IO the OS allowed, bypassing the per-tool
// `PermissionMode` (Bash / Edit / Write / etc.) the rest of the agent
// enforces.
//
// This module provides a single, pure predicate the executor wrapper
// calls before forwarding the call. It has NO I/O: it only inspects the
// tool's provenance (bundled / plugin / local / settings) and the active
// permission mode. The caller (apply.ts and MCPManager) is responsible
// for mapping `allow` / `deny` / `prompt` to the right ToolResult.
//
// Policy summary for v0.1.3:
//   - bundled:        allow (trusted first-party; no gate)
//   - plugin (installed from marketplace): always prompt unless mode == bypass
//   - local (manually installed from path): always prompt unless mode == bypass
//   - settings (user-configured):          always prompt unless mode == bypass
//   - any other / unknown provenance:      always prompt (defense in depth)

import type { PermissionMode } from '../permissions/types.js';

export type McpToolSource = 'bundled' | 'plugin' | 'local' | 'settings' | 'unknown';

export type McpGateDecision =
  | { kind: 'allow'; reason: string }
  | { kind: 'deny'; reason: string }
  | { kind: 'prompt'; reason: string };

/**
 * Inspect a tool's provenance and the active mode. Returns the decision.
 * Pure: no I/O. Safe to call from any executor.
 *
 * @param source     provenance bucket of the tool (see above)
 * @param mode       active PermissionMode, may be undefined
 * @param toolName   model-visible name (used for error messages / logs)
 */
export function evaluateMcpToolPermission(
  source: McpToolSource,
  mode: PermissionMode | undefined,
  toolName: string,
): McpGateDecision {
  if (source === 'bundled') {
    return { kind: 'allow', reason: 'bundled MCP tools are trusted first-party' };
  }

  // Bypass modes (bypassPermissions, dontAsk) honor user intent.
  if (mode === 'bypassPermissions' || mode === 'dontAsk') {
    return { kind: 'allow', reason: 'user-selected bypass mode' };
  }

  // Every other path is at minimum a prompt. We never silently allow
  // third-party tools regardless of `default` / `auto` / `plan`.
  switch (source) {
    case 'plugin':
      return {
        kind: 'prompt',
        reason: `third-party MCP plugin tool "${toolName}" requires explicit user approval`,
      };
    case 'local':
      return {
        kind: 'prompt',
        reason: `locally-installed MCP tool "${toolName}" requires explicit user approval`,
      };
    case 'settings':
      return {
        kind: 'prompt',
        reason: `user-configured MCP tool "${toolName}" requires explicit user approval`,
      };
    case 'unknown':
    default:
      return {
        kind: 'prompt',
        reason: `MCP tool "${toolName}" with unknown provenance requires explicit user approval`,
      };
  }
}
