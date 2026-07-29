/**
 * MCP Configuration Loading Layer
 * Responsible for reading MCP configuration from settings.json and managing config state
 */

import { join } from 'path';

/**
 * MCP configuration item (frontend settings format)
 */
export interface MCPConfigItem {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
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
