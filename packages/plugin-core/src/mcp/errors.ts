// packages/plugin-core/src/mcp/errors.ts
// MCP error unions, source context, and the unified MCPIssue type.
// Pure types only — no runtime imports.

import type { MCPSourceContext } from './discovery';

/**
 * Phases at which an MCP issue can be raised. Lets the UI bucket issues
 * and tests assert per-phase behavior.
 */
export type MCPPhase = 'discovery' | 'resolution' | 'connection' | 'registration';

/**
 * Discovery-time errors emitted by the pure resolution engine.
 * `serverName` is optional because manifest-parse failures and other
 * settings-wide failures may have no per-server name available.
 */
export type MCPDiscoveryError =
  | { type: 'mcp-script-not-found';         source: MCPSourceContext; serverName: string; expectedPath: string }
  | { type: 'mcp-command-missing';          source: MCPSourceContext; serverName: string; command: string }
  | { type: 'mcp-empty-command';            source: MCPSourceContext; serverName: string }
  | { type: 'mcp-manifest-invalid';         source: MCPSourceContext; serverName?: string; reason: string }
  | { type: 'mcp-settings-invalid';         source: MCPSourceContext; serverName?: string; reason: string }
  | { type: 'mcp-bundled-missing';          source: MCPSourceContext; bundlePath: string }
  | { type: 'mcp-env-var-missing';          source: MCPSourceContext; serverName: string; missingVars: string[] }
  | { type: 'mcp-user-config-missing';      source: MCPSourceContext; serverName: string; missingKeys: string[] }
  | { type: 'mcp-allowed-paths-violation';  source: MCPSourceContext; serverName: string; path: string }
  | { type: 'mcp-server-shadowed';          source: MCPSourceContext; serverName: string; shadowedByInventoryId: string }
  | { type: 'mcp-override-target-not-supported'; source: MCPSourceContext; serverName: string; declaredTarget: string };

/**
 * Runtime connection errors emitted by MCPClient / MCPManager.
 */
export type MCPConnectionError =
  | { type: 'mcp-spawn-failed';        serverName: string; reason: string }
  | { type: 'mcp-connection-timeout';  serverName: string; timeoutMs: number }
  | { type: 'mcp-protocol-error';      serverName: string; reason: string };

/**
 * Tool-registration errors emitted by the worker after connecting
 * and fetching the tool list. Phase: 'registration'.
 */
export type MCPRegistrationError =
  | { type: 'mcp-tool-name-collision';      serverName: string; toolName: string; internalKey: string }
  | { type: 'mcp-provider-name-collision';  serverName: string; providerName: string; internalKey: string }
  | { type: 'mcp-provider-name-unknown';    providerName: string };

export type MCPError = MCPDiscoveryError | MCPConnectionError | MCPRegistrationError;

export interface MCPIssue {
  phase: MCPPhase;
  source: MCPSourceContext;
  inventoryId?: string;
  serverName?: string;
  error: MCPError;
  humanMessage: string;
  severity: 'critical' | 'warning' | 'info';
  suggestedAction?: string;
}
