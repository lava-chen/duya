/**
 * Host-owned readers for MCP configuration and its separately stored secrets.
 * Configuration files remain a product data source; callers can provide a
 * config root in tests without changing the production path resolution.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseUserMcpToml, type UserMcpTomlServer } from '@duya/plugin-core/mcp/user-config';
import { resolveConfigRoot } from '../agent-profile-config.js';

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

export interface MCPConfigReadOptions {
  configRoot?: string;
}

/** Legacy settings path retained for callers that still expose this helper. */
export function getSettingsPath(): string | null {
  const appDataPath = process.env.DUYA_APP_DATA_PATH;
  if (appDataPath) return join(appDataPath, 'settings.json');

  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (!homeDir) return null;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) return join(appData, 'DUYA', 'settings.json');
  }
  if (process.platform === 'darwin') {
    return join(homeDir, 'Library', 'Application Support', 'DUYA', 'settings.json');
  }
  return join(homeDir, '.config', 'DUYA', 'settings.json');
}

/** The historical mcp.toml path is informational; reads use config.toml. */
export function getUserMcpTomlPath(): string | null {
  const settingsPath = getSettingsPath();
  return settingsPath ? join(dirname(settingsPath), 'mcp.toml') : null;
}

/**
 * Fill MCP server env entries from the flat dotted keys in secrets.json.
 * Secrets win over TOML values, matching ConfigStore's setByPath behavior.
 */
export async function mergeMcpSecrets(
  servers: UserMcpTomlServer[],
  options: MCPConfigReadOptions = {},
): Promise<UserMcpTomlServer[]> {
  const secretsPath = join(options.configRoot ?? resolveConfigRoot(), 'secrets.json');
  let raw: string;
  try {
    raw = await readFile(secretsPath, 'utf8');
  } catch {
    return servers;
  }

  let secrets: unknown;
  try {
    secrets = JSON.parse(raw);
  } catch {
    return servers;
  }
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) return servers;

  for (const [key, value] of Object.entries(secrets)) {
    if (!key.startsWith('mcp_servers.') || typeof value !== 'string') continue;
    const parts = key.slice('mcp_servers.'.length).split('.');
    if (parts.length !== 3 || parts[1] !== 'env' || !parts[2]) continue;
    const server = servers.find((entry) => entry.name === parts[0]);
    if (!server) continue;
    server.env = { ...(server.env ?? {}), [parts[2]]: value };
  }
  return servers;
}

/** Read the single user-managed MCP source: `[mcp_servers.*]` in config.toml. */
export async function readUserMcpToml(
  options: MCPConfigReadOptions = {},
): Promise<UserMcpTomlServer[]> {
  const configRoot = options.configRoot ?? resolveConfigRoot();
  try {
    const raw = await readFile(join(configRoot, 'config.toml'), 'utf8');
    return await mergeMcpSecrets(parseUserMcpToml(raw), { configRoot });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
