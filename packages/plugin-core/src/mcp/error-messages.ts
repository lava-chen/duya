// packages/plugin-core/src/mcp/error-messages.ts
// Human-readable messages and severity suggestions for MCP issues.
// Pure functions over MCPError values; no I/O, no logger.

import type { MCPError } from './errors';

/**
 * Map an MCPError to a human-readable string suitable for display in the
 * MCP settings page. Pure; deterministic. The function covers every
 * shape currently in MCPDiscoveryError | MCPConnectionError |
 * MCPRegistrationError.
 */
export function getMCPErrorMessage(err: MCPError): string {
  switch (err.type) {
    case 'mcp-script-not-found':
      return `Script not found at "${err.expectedPath}". The plugin's MCP server entry points to a file that does not exist on disk.`;
    case 'mcp-command-missing':
      return `Command "${err.command}" could not be resolved. Check that the executable is on PATH or use an absolute path.`;
    case 'mcp-empty-command':
      return `The MCP server entry has an empty command. Edit the plugin manifest or settings entry.`;
    case 'mcp-manifest-invalid':
      return `The manifest could not be parsed: ${err.reason}`;
    case 'mcp-settings-invalid':
      return `The settings entry is invalid: ${err.reason}`;
    case 'mcp-bundled-missing':
      return `Bundled MCP server bundle not found at "${err.bundlePath}". The desktop build may be incomplete; reinstall DUYA.`;
    case 'mcp-env-var-missing':
      return `Missing environment variable(s): ${err.missingVars.join(', ')}. Set them in your shell or plugin config.`;
    case 'mcp-user-config-missing':
      return `Missing user config key(s): ${err.missingKeys.join(', ')}. Configure the plugin via Settings → Plugins.`;
    case 'mcp-allowed-paths-violation':
      return `Resolved path "${err.path}" escapes the plugin's install directory.`;
    case 'mcp-server-shadowed':
      return `Overridden by another entry (${err.shadowedByInventoryId}). Only the higher-priority entry is connected.`;
    case 'mcp-override-target-not-supported':
      return `overrideTarget "${err.declaredTarget}" is ignored this round; cross-source override will be redesigned in a follow-up plan.`;
    case 'mcp-spawn-failed':
      return `Failed to start MCP server: ${err.reason}`;
    case 'mcp-connection-timeout':
      return `Connection to MCP server timed out after ${err.timeoutMs} ms.`;
    case 'mcp-protocol-error':
      return `MCP protocol error: ${err.reason}`;
    case 'mcp-tool-name-collision':
      return `The same server's tools/list returned two tools named "${err.toolName}". The second was dropped.`;
    case 'mcp-provider-name-collision':
      return `Another tool sanitizes to the same provider name "${err.providerName}". A unique suffix was applied.`;
    case 'mcp-provider-name-unknown':
      return `The model invoked tool "${err.providerName}" which is not registered. The tool may have been removed by a recent reload.`;
    default: {
      // Exhaustiveness fallback. The cast is safe because MCPError is a
      // discriminated union and we have handled every type.
      const _exhaustive: never = err;
      return String(_exhaustive);
    }
  }
}

/**
 * Map an MCPError to a severity level. The UI uses this to pick a
 * status icon and banner color.
 */
export function getMCPErrorSeverity(
  err: MCPError,
): 'critical' | 'warning' | 'info' {
  switch (err.type) {
    case 'mcp-script-not-found':
    case 'mcp-command-missing':
    case 'mcp-bundled-missing':
    case 'mcp-spawn-failed':
    case 'mcp-connection-timeout':
    case 'mcp-protocol-error':
    case 'mcp-tool-name-collision':
    case 'mcp-provider-name-unknown':
      return 'critical';
    case 'mcp-empty-command':
    case 'mcp-manifest-invalid':
    case 'mcp-settings-invalid':
    case 'mcp-env-var-missing':
    case 'mcp-user-config-missing':
    case 'mcp-allowed-paths-violation':
    case 'mcp-provider-name-collision':
      return 'warning';
    case 'mcp-server-shadowed':
    case 'mcp-override-target-not-supported':
      return 'info';
    default: {
      const _exhaustive: never = err;
      return String(_exhaustive) as 'info';
    }
  }
}

/**
 * Map an MCPError to a user-actionable hint. Returns undefined when
 * there is no specific action the user can take.
 */
export function getMCPSuggestedAction(
  err: MCPError,
): string | undefined {
  switch (err.type) {
    case 'mcp-script-not-found':
      return 'Verify the plugin install is complete and the file exists on disk. Reinstall the plugin if needed.';
    case 'mcp-command-missing':
      return 'Use an absolute path, or set the executable in the plugin manifest and re-enable the plugin.';
    case 'mcp-empty-command':
      return 'Edit the manifest or settings entry to specify a command.';
    case 'mcp-manifest-invalid':
    case 'mcp-settings-invalid':
      return 'Fix the manifest/settings JSON. See the validator output for field-level details.';
    case 'mcp-bundled-missing':
      return 'Reinstall DUYA or run `npm run bundle:agent` to rebuild the agent bundle.';
    case 'mcp-env-var-missing':
      return `Set the missing variable(s) in your shell environment, or edit the plugin config.`;
    case 'mcp-user-config-missing':
      return 'Open Settings → Plugins and configure the missing keys.';
    case 'mcp-allowed-paths-violation':
      return 'Use a path inside the plugin install directory.';
    case 'mcp-server-shadowed':
      return 'Edit or remove the higher-priority entry to reactivate this one.';
    case 'mcp-override-target-not-supported':
      return 'Remove the overrideTarget field; cross-source override is not yet supported.';
    case 'mcp-spawn-failed':
      return 'Check the system error message; the executable may be missing or not executable.';
    case 'mcp-connection-timeout':
      return 'Increase the timeout, or check for hung subprocesses (kill leftover node processes).';
    case 'mcp-protocol-error':
      return 'Check the MCP server logs; the server may have crashed or sent invalid JSON.';
    case 'mcp-tool-name-collision':
      return 'File a bug against the plugin: tools/list should not contain duplicate tool names.';
    case 'mcp-provider-name-collision':
      return 'A suffix was added automatically. No action required unless the model cannot invoke the tool.';
    case 'mcp-provider-name-unknown':
      return 'Run a manual reload to refresh the tool registry.';
    default: {
      const _exhaustive: never = err;
      return undefined;
    }
  }
}
