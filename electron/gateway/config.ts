import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { GatewayInitConfig, PlatformConfig, WorkerSpawnConfig } from './types';

export interface DbSettingRow {
  value: string;
}

export function getSetting(db: unknown, key: string): string | undefined {
  const db_ = db as { prepare(sql: string): { get(...params: unknown[]): DbSettingRow | undefined } };
  const row = db_.prepare('SELECT value FROM settings WHERE key = ?').get(key) as DbSettingRow | undefined;
  if (row) {
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }
  return undefined;
}

/**
 * Default gateway workspace when `bridge_workspace` setting is absent.
 * Resolves to ~/.duya/workspace (user home based).
 */
export function getDefaultGatewayWorkspace(): string {
  return join(homedir(), '.duya', 'workspace');
}

/**
 * Resolve the gateway working directory:
 *   1. `bridge_workspace` setting from DB (user-configured in Bridge settings UI)
 *   2. fallback to ~/.duya/workspace
 *
 * Expands leading ~ to the user home dir. Empty string falls back to default.
 */
export function resolveGatewayWorkspace(initConfig?: GatewayInitConfig): string {
  const raw = initConfig?.workingDirectory;
  if (!raw) return getDefaultGatewayWorkspace();
  if (raw.startsWith('~/') || raw === '~') {
    return join(homedir(), raw.slice(1));
  }
  return raw;
}

/** Resolve and create the gateway workspace before a worker uses it as cwd. */
export function prepareGatewayWorkspace(initConfig?: GatewayInitConfig): string {
  const workspace = resolveGatewayWorkspace(initConfig);
  mkdirSync(workspace, { recursive: true });
  return workspace;
}

export function buildInitConfig(
  tempDirs: Record<string, string>,
  agentServerPort: number,
  getPlatformConfig: () => PlatformConfig | undefined,
  getWorkerSpawnConfig: () => WorkerSpawnConfig | undefined,
  db?: unknown,
): GatewayInitConfig {
  const platformConfig = getPlatformConfig();
  const workerConfig = getWorkerSpawnConfig();

  // Read user-configured gateway workspace from DB (bridge_workspace setting,
  // editable in Bridge settings UI). Falls back to ~/.duya/workspace when absent
  // or empty. Never use process.cwd() — that leaks the Electron app's cwd
  // (e.g. the dev repo path e:\Projects\duya) into agent sessions.
  const dbWorkspace = db ? getSetting(db, 'bridge_workspace') : undefined;
  const workingDirectory = dbWorkspace && dbWorkspace.trim()
    ? dbWorkspace
    : getDefaultGatewayWorkspace();

  return {
    tempDir: tempDirs['default'] || tempDirs.duya || '',
    gatewayWorkerTempDir: tempDirs['gateway-worker'] || tempDirs.duya || '',
    agentServerPort,
    platformConfig,
    workerSpawnConfig: workerConfig,
    workingDirectory,
  };
}
