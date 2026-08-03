/**
 * MCP Configuration Loading Layer
 * Responsible for reading MCP configuration from settings.json and managing config state
 */

import { join } from 'path';
import { readFile } from 'fs/promises';
import { parseUserMcpToml, type UserMcpTomlServer } from '@duya/plugin-core/src/mcp/user-config.js';

/**
 * MCP configuration item (frontend settings format)
 */
export interface MCPConfigItem {
  name: string;
  transport?: 'stdio' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  allowedAgentIds?: string[];
}

/**
 * Get settings path from Electron main process
 * In Agent process, retrieve via environment variables
 */
export function getSettingsPath(): string | null {
  // Try to get from environment variable
  const appDataPath = process.env.DUYA_APP_DATA_PATH;
  if (appDataPath) {
    return join(appDataPath, 'settings.json');
  }

  // Try common configuration paths
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (homeDir) {
    // Windows
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA;
      if (appData) {
        return join(appData, 'DUYA', 'settings.json');
      }
    }
    // macOS
    if (process.platform === 'darwin') {
      return join(homeDir, 'Library', 'Application Support', 'DUYA', 'settings.json');
    }
    // Linux
    return join(homeDir, '.config', 'DUYA', 'settings.json');
  }

  return null;
}

/** The sole user-managed MCP source. Plugin MCPs do not read this file. */
export function getUserMcpTomlPath(): string | null {
  const settingsPath = getSettingsPath();
  return settingsPath ? join(settingsPath, '..', 'mcp.toml') : null;
}

export async function readUserMcpToml(): Promise<UserMcpTomlServer[]> {
  const filePath = getUserMcpTomlPath();
  if (!filePath) return [];
  try {
    return parseUserMcpToml(await readFile(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
