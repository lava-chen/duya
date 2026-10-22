/**
 * Host-owned MCP bridge for the Computer Use capability.
 *
 * Marketplace packages must never inject OS automation themselves. A host
 * MCP server can expose this tool inside the normal MCP executor pipeline;
 * the capability executor then forwards through the worker's typed IPC
 * request to Electron main, where the existing guard, approval, audit, and
 * revoke checks remain authoritative.
 */

import type { AppServerTool } from '@duya/capabilities/AppServer/in-process-app-server';
import { createInProcessAppServer } from '@duya/capabilities/AppServer/in-process-app-server';
import {
  executor as capabilityComputerCuaExecutor,
  definition as computerCuaDefinition,
} from '@duya/capabilities/OSTool/ComputerCuaTool';
import type { ToolUseContext } from '../worker-run-contracts.js';
import { toCapabilityContext } from './os-capability-adapter.js';
import type { MCPServerConfig } from '@duya/capabilities/MCP/ports';

export const COMPUTER_USE_HOST_CAPABILITY_ID = 'computer-use';

/** Stable MCP identity for the Host implementation of this capability. */
export const COMPUTER_USE_HOST_SERVER_NAME = 'duya_computer_use';

/**
 * The tool passed through the in-process MCP boundary. `context` is supplied
 * by the Host's AsyncLocalStorage context bridge; args remain untrusted JSON.
 */
export const computerUseHostCapabilityTool: AppServerTool = {
  name: computerCuaDefinition.name,
  description: computerCuaDefinition.description,
  inputSchema: computerCuaDefinition.input_schema,
  async execute(input, context) {
    // Keep validation, session binding, and IPC routing in the canonical
    // capability executor. It is the same executor used by the built-in
    // computer_cua tool and delegates to Electron main's guarded dispatcher.
    return capabilityComputerCuaExecutor.execute(
      input,
      undefined,
      toCapabilityContext(context as ToolUseContext | undefined),
    );
  },
};

/**
 * Create the Host implementation to be attached to an MCPManager in-process
 * config when an installed official capability package requests it. The
 * caller must still register it with source `plugin` so the regular MCP
 * approval gate runs before this server receives a call.
 */
export function createComputerUseHostCapabilityServer() {
  return createInProcessAppServer({
    name: COMPUTER_USE_HOST_SERVER_NAME,
    version: '1.0.0',
    tools: [computerUseHostCapabilityTool],
  });
}

/**
 * Build the runtime config a Host loader should add for an installed plugin
 * that declares `hostCapabilities: ["computer-use"]`. The plugin provides
 * discovery/instructions; the Host supplies the implementation. Keeping the
 * source as `plugin` means the standard MCP permission gate still asks before
 * the call, and the CUA executor then applies its own existing OS safeguards.
 */
export function createComputerUseHostCapabilityConfig(pluginId: string): MCPServerConfig {
  if (!pluginId.trim()) throw new Error('Computer Use Host capability requires a pluginId.');
  return {
    name: `plugin:${pluginId}:computer-use`,
    pluginId,
    source: 'plugin',
    transport: 'in-process',
    inProcessServer: createComputerUseHostCapabilityServer(),
    toolTimeoutSec: 35,
  };
}
