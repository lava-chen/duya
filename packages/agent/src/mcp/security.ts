/** Agent compatibility adapter for MCP security primitives. */

import {
  scanMcpDescription as scanCapabilityDescription,
} from '@duya/capabilities/MCP/security';
import type { MCPLogger } from '@duya/capabilities/MCP/ports';
import { logger } from '../utils/logger.js';

export {
  SAFE_ENV_KEYS,
  SAFE_ENV_KEYS_CASE_INSENSITIVE,
  buildSafeEnv,
  CREDENTIAL_PATTERN,
  sanitizeSecrets,
  MCP_INJECTION_PATTERNS,
} from '@duya/capabilities/MCP/security';
export type { SamplingRateLimitConfig } from '@duya/capabilities/MCP/security';

const agentLogger: MCPLogger = {
  debug: (message) => logger.debug(message),
  info: (message) => logger.info(message),
  warn: (message) => logger.warn(message),
  error: (message) => logger.error(message),
};

export function scanMcpDescription(
  serverName: string,
  toolName: string,
  description: string,
): string[] {
  return scanCapabilityDescription(serverName, toolName, description, agentLogger);
}
