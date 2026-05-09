/**
 * MCP Configuration Loading Layer
 * Responsible for reading MCP configuration from settings.json and managing config state
 */

import { readFile, access } from 'fs/promises';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import type { MCPServerConfig } from '../types.js';

/**
 * MCP configuration item (frontend settings format)
 */
export interface MCPConfigItem {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

/**
 * User settings structure
 */
interface UserSettings {
  mcpServers?: MCPConfigItem[];
  [key: string]: unknown;
}

/**
 * Configuration loading result
 */
export interface MCPConfigLoadResult {
  configs: MCPServerConfig[];
  errors: Array<{ name: string; error: string }>;
}

/**
 * Load MCP configuration from settings.json
 * @param settingsPath Path to the settings file
 * @returns List of enabled MCP server configurations
 */
export async function loadMCPConfigsFromSettings(
  settingsPath: string
): Promise<MCPConfigLoadResult> {
  const result: MCPConfigLoadResult = {
    configs: [],
    errors: [],
  };

  try {
    // Check if file exists
    await access(settingsPath);

    // Read settings file
    const content = await readFile(settingsPath, 'utf-8');
    const settings: UserSettings = JSON.parse(content);

    // Extract enabled MCP server configurations
    if (!settings.mcpServers || !Array.isArray(settings.mcpServers)) {
      logger.debug('[MCP Config] No mcpServers found in settings');
      return result;
    }

    for (const item of settings.mcpServers) {
      try {
        // Validate required fields
        if (!item.name || typeof item.name !== 'string') {
          result.errors.push({
            name: item.name || 'unknown',
            error: 'Missing or invalid "name" field',
          });
          continue;
        }

        if (!item.command || typeof item.command !== 'string') {
          result.errors.push({
            name: item.name,
            error: 'Missing or invalid "command" field',
          });
          continue;
        }

        // Only load enabled configurations
        if (item.enabled === false) {
          logger.debug(`[MCP Config] Skipping disabled server: ${item.name}`);
          continue;
        }

        // Build configuration object
        const config: MCPServerConfig = {
          name: item.name,
          command: item.command,
          args: item.args || [],
          env: item.env || {},
        };

        result.configs.push(config);
        logger.debug(`[MCP Config] Loaded config for: ${item.name}`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        result.errors.push({
          name: item.name || 'unknown',
          error: `Failed to parse config: ${errorMsg}`,
        });
      }
    }

    logger.info(
      `[MCP Config] Loaded ${result.configs.length} MCP server configs, ${result.errors.length} errors`
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.warn(`[MCP Config] Failed to load settings from ${settingsPath}: ${errorMsg}`);
  }

  return result;
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

/**
 * Convenience function to load MCP configuration
 * Automatically finds settings file path and loads configuration
 */
export async function loadMCPConfigs(): Promise<MCPConfigLoadResult> {
  const settingsPath = getSettingsPath();

  if (!settingsPath) {
    logger.warn('[MCP Config] Could not determine settings path');
    return { configs: [], errors: [] };
  }

  return loadMCPConfigsFromSettings(settingsPath);
}

/**
 * Validate MCP configuration
 */
export function validateMCPConfig(config: MCPServerConfig): { valid: boolean; error?: string } {
  if (!config.name || typeof config.name !== 'string') {
    return { valid: false, error: 'Missing or invalid "name" field' };
  }

  if (!config.command || typeof config.command !== 'string') {
    return { valid: false, error: 'Missing or invalid "command" field' };
  }

  if (config.args && !Array.isArray(config.args)) {
    return { valid: false, error: '"args" must be an array' };
  }

  if (config.env && typeof config.env !== 'object') {
    return { valid: false, error: '"env" must be an object' };
  }

  return { valid: true };
}
