export interface PlatformConfig {
  type?: string;
  token?: string;
  appId?: string;
  appSecret?: string;
  accountId?: string;
  userId?: string;
  baseUrl?: string;
  cdnUrl?: string;
  weixinAccountId?: string;
  weixinUserId?: string;
  weixinToken?: string;
  weixinRefreshToken?: string;
  weixinBaseUrl?: string;
  weixinCdnBaseUrl?: string;
  platform?: string;
  tokenFromSettings?: string;
  appIdFromSettings?: string;
  appSecretFromSettings?: string;
}

export interface WorkerSpawnConfig {
  scriptPath: string;
  agentProcessEntry?: string;
  betterSqlite3Path?: string;
  envVars?: Record<string, string>;
}

export interface GatewayProxyConfig {
  globalEnabled: boolean;
  channels: Record<string, boolean>;
}

export interface GatewayInitConfig {
  platforms: Array<{
    platform: string;
    enabled: boolean;
    credentials: Record<string, string>;
    options?: Record<string, unknown>;
  }>;
  autoStart: boolean;
  proxyUrl?: string;
  proxyConfig?: GatewayProxyConfig;
  // Legacy fields (for backward compatibility with lifecycle.ts)
  tempDir?: string;
  gatewayWorkerTempDir?: string;
  agentServerPort?: number;
  platformConfig?: PlatformConfig;
  workerSpawnConfig?: WorkerSpawnConfig;
  workingDirectory?: string;
}

export interface GatewayMessage {
  type: 'request' | 'response' | 'event' | 'error' | 'db:request' | 'db:response';
  id?: string;
  sessionId: string;
  action?: string;
  payload?: string;
  result?: string;
  event?: string;
  data?: string;
  error?: string;
}

export interface GatewayDbAction {
  type?: string;
  id?: string;
  sessionId?: string;
  action?: string;
  payload?: Record<string, unknown>;
}

export interface GatewaySessionState {
  sessionId: string;
  state: 'starting' | 'running' | 'idle' | 'paused' | 'terminating' | 'error';
  workerId?: string;
  createdAt: number;
  lastActivityAt: number;
  error?: string;
  bridgeChannel?: string;
  /**
   * Whether a meaningful title has already been generated from the first
   * inbound message. Sessions start with the fallback "{platform} {timestamp}"
   * title and are upgraded once the user sends the first message.
   */
  titleGenerated?: boolean;
}