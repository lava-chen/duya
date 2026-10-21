/** Agent compatibility adapter for the capability-owned MCP client. */

import {
  MCPClient as CapabilityMCPClient,
  MCPManager as CapabilityMCPManager,
} from '@duya/capabilities/MCP/MCPManager';
import type { MCPManagerOptions, MCPServerConfig, MCPLogger } from '@duya/capabilities/MCP/ports';
import { logger } from '@duya/host/worker-logger';

const agentMcpLogger: MCPLogger = {
  debug: (message) => logger.debug(message),
  info: (message) => logger.info(message),
  warn: (message) => logger.warn(message),
  error: (message) => logger.error(message),
};

/** Preserve the legacy no-argument worker construction and its logger. */
export class MCPManager extends CapabilityMCPManager {
  constructor() {
    const options: MCPManagerOptions = { logger: agentMcpLogger };
    super(options);
  }
}

/** Preserve direct Agent imports while keeping the implementation capability-owned. */
export class MCPClient extends CapabilityMCPClient {
  constructor(config: MCPServerConfig) {
    super(config, { logger: agentMcpLogger });
  }
}

export { McpError } from '@duya/plugin-core/mcp/core/index';
