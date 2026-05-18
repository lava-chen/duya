import { GatewayInitConfig, PlatformConfig, WorkerSpawnConfig } from './types';

export interface DbSettingRow {
  value: string;
}

export function getSetting(db: unknown, key: string): string | undefined {
  const db_ = db as { prepare(sql: string): { get(): DbSettingRow | undefined } };
  const row = db_.prepare("SELECT value FROM settings WHERE key = ?").get() as DbSettingRow | undefined;
  if (row) {
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }
  return undefined;
}

export function resolveGatewayWorkspace(initConfig: GatewayInitConfig): string {
  return initConfig.workingDirectory || '';
}

export function buildInitConfig(
  tempDirs: Record<string, string>,
  agentServerPort: number,
  getPlatformConfig: () => PlatformConfig | undefined,
  getWorkerSpawnConfig: () => WorkerSpawnConfig | undefined,
): GatewayInitConfig {
  const platformConfig = getPlatformConfig();
  const workerConfig = getWorkerSpawnConfig();

  return {
    tempDir: tempDirs['default'] || tempDirs.duya || '',
    gatewayWorkerTempDir: tempDirs['gateway-worker'] || tempDirs.duya || '',
    agentServerPort,
    platformConfig,
    workerSpawnConfig: workerConfig,
    workingDirectory: process.cwd(),
  };
}