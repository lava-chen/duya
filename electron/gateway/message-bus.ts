import { ipcMain } from 'electron';
import * as http from 'http';
import { getLogger, LogComponent } from '../logging/logger';
import { getDatabase } from '../ipc/db-handlers';
import { GatewayInitConfig } from './types';
import { startGatewayProcess, stopGatewayProcess, waitForGatewayReady, isGatewayRunning, getGatewayProcess } from './lifecycle';
import { GatewaySessionState } from './types';
import { dispatchGatewayDbAction } from './db-bridge';
import { execSync } from 'child_process';
import { testBridgeChannel } from '../services/network/bridge-tester';
import { getPairingStore } from './pairing';
import { getAgentServerPort } from '../agents/agent-server-lifecycle';

const GATEWAY_SESSION_KEY = '__gateway_session_states__';

export function getSessionStates(): Map<string, GatewaySessionState> {
  const g = globalThis as Record<string, unknown>;
  if (!g[GATEWAY_SESSION_KEY]) {
    g[GATEWAY_SESSION_KEY] = new Map<string, GatewaySessionState>();
  }
  return g[GATEWAY_SESSION_KEY] as Map<string, GatewaySessionState>;
}

export function getSessionState(sessionId: string): GatewaySessionState | undefined {
  return getSessionStates().get(sessionId);
}

export function createOrResetGatewaySession(sessionId: string, channel: string): void {
  const states = getSessionStates();

  if (states.has(sessionId)) {
    const existing = states.get(sessionId)!;
    if (existing.state !== 'terminating') {
      getLogger().debug('Gateway session already exists, forwarding reset', { sessionId }, LogComponent.Gateway);
      sendToGatewayProcess({ type: 'reset', sessionId });
    }
  }

  states.set(sessionId, {
    sessionId,
    state: 'starting',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    bridgeChannel: channel,
  });

  getLogger().info('Gateway session created', { sessionId, channel }, LogComponent.Gateway);
}

export function resetGatewaySession(sessionId: string): void {
  const states = getSessionStates();
  const state = states.get(sessionId);
  if (state) {
    state.state = 'terminating';
  }
  states.delete(sessionId);

  sendToGatewayProcess({ type: 'reset', sessionId });

  try {
    const db = getDatabase();
    if (db) {
      const now = Date.now();
      db.prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`).run(now, sessionId);
      db.prepare(`DELETE FROM messages WHERE thread_id = ?`).run(sessionId);
    }
  } catch {
    // best effort
  }

  getLogger().info('Gateway session reset', { sessionId }, LogComponent.Gateway);
}

function handleInboundMessage(msg: Record<string, unknown>): void {
  const sessionId = msg.sessionId as string;
  const payload = msg.data as Record<string, unknown> | undefined;

  if (payload?.action === 'create_session') {
    createOrResetGatewaySession(sessionId, (msg.platform as string) || 'unknown');
    return;
  }

  if (payload?.action === 'reset_session') {
    resetGatewaySession(sessionId);
    return;
  }
}

export function handleGatewayMessage(
  msg: Record<string, unknown>,
  onAuthFailure: () => void,
): void {
  const type = msg.type as string | undefined;
  const sessionId = msg.sessionId as string | undefined;

  switch (type) {
    case 'log': {
      const level = (msg.level as string) || 'info';
      const message = msg.message as string || '';
      if (level === 'error') {
        getLogger().error(`[gateway] ${message}`, undefined, undefined, LogComponent.Gateway);
      } else {
        getLogger().debug(`[gateway] ${message}`, undefined, LogComponent.Gateway);
      }
      break;
    }

    case 'gateway:ready':
      getLogger().info('Gateway bridge ready', undefined, LogComponent.Gateway);
      console.log('[STARTUP] gateway:ready received');
      break;

    case 'gateway:init:complete':
      getLogger().info('Gateway init complete', { success: msg.success }, LogComponent.Gateway);
      console.log('[STARTUP] gateway:init:complete', msg.success ? 'success' : 'failed', msg.error || '');
      break;

    case 'gateway:error':
      getLogger().error('Gateway error', new Error(`${msg.error}`), undefined, LogComponent.Gateway);
      console.error('[STARTUP] gateway:error', msg.error);
      break;

    case 'db:request': {
      const action = (msg.action || msg) as { type?: string; action?: string; payload?: Record<string, unknown>; id?: string };
      const result = dispatchGatewayDbAction(action);
      if (result) {
        sendToGatewayProcess({
          type: 'db:response',
          id: msg.id || (action as { id?: string }).id || '',
          sessionId: sessionId || '',
          ...result,
        });
      }
      break;
    }

    case 'bridge:session_created':
      if (sessionId) {
        createOrResetGatewaySession(sessionId, (msg.platform as string) || (msg.channel as string) || 'unknown');
      }
      break;

    case 'bridge:session_closed':
      if (sessionId) {
        getSessionStates().delete(sessionId);
      }
      break;

    case 'bridge:message':
    case 'bridge:inbound': {
      if (sessionId) {
        const state = getSessionStates().get(sessionId);
        if (state) {
          state.lastActivityAt = Date.now();
          if (type === 'bridge:inbound') {
            state.state = 'running';
          }
        }
      }
      handleInboundMessage(msg);
      break;
    }

    case 'gateway:inbound': {
      // Forward inbound message from Gateway to Agent Server and receive SSE stream
      const inboundMsg = msg as {
        sessionId: string;
        prompt: string;
        platform: string;
        platformMsgId: string;
        platformChatId: string;
        options?: Record<string, unknown>;
      };

      const port = getAgentServerPort();
      if (!port) {
        getLogger().error('Agent Server not running, cannot forward gateway:inbound', undefined, { sessionId: inboundMsg.sessionId }, LogComponent.Gateway);
        break;
      }

      const sessionId = inboundMsg.sessionId;
      const platform = inboundMsg.platform;
      const platformChatId = inboundMsg.platformChatId;

      // Accumulate text from chat:text events
      let accumulatedText = '';
      let sseBuffer = '';

      const body = JSON.stringify({
        prompt: inboundMsg.prompt,
        options: {
          ...inboundMsg.options,
          platform,
          platformMsgId: inboundMsg.platformMsgId,
          platformChatId,
        },
      });

      const req = require('http').request(
        {
          method: 'POST',
          hostname: '127.0.0.1',
          port,
          path: `/sessions/${sessionId}/chat`,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'Accept': 'text/event-stream',
          },
        },
        (res: http.IncomingMessage) => {
          res.on('data', (chunk: Buffer) => {
            sseBuffer += chunk.toString();
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6);
              try {
                const event = JSON.parse(data);

                // Handle different event types
                if (event.type === 'text') {
                  const content = event.data?.content || '';
                  accumulatedText += content;
                  // Forward text event to Gateway immediately
                  sendToGatewayProcess({
                    type: 'gateway:outbound',
                    sessionId,
                    platform,
                    platformChatId,
                    event: { type: 'chat:text', content },
                  });
                } else if (event.type === 'thinking') {
                  const content = event.data?.content || '';
                  sendToGatewayProcess({
                    type: 'gateway:outbound',
                    sessionId,
                    platform,
                    platformChatId,
                    event: { type: 'chat:thinking', content },
                  });
                } else if (event.type === 'done') {
                  getLogger().debug('[gateway:inbound] done event received', {
                    sessionId,
                    accumulatedLength: accumulatedText.length,
                  }, LogComponent.Gateway);

                  // Send final content with accumulated text
                  sendToGatewayProcess({
                    type: 'gateway:outbound',
                    sessionId,
                    platform,
                    platformChatId,
                    event: {
                      type: 'chat:done',
                      finalContent: accumulatedText,
                    },
                  });
                } else if (event.type === 'error') {
                  const message = event.data?.message || 'Agent error';
                  getLogger().error('[gateway:inbound] Agent error', new Error(message), { sessionId }, LogComponent.Gateway);
                  sendToGatewayProcess({
                    type: 'gateway:outbound',
                    sessionId,
                    platform,
                    platformChatId,
                    event: { type: 'chat:error', message },
                  });
                }
              } catch (e) {
                // Ignore parse errors for partial SSE data
              }
            }
          });

          res.on('end', () => {
            getLogger().debug('[gateway:inbound] SSE stream ended', { sessionId }, LogComponent.Gateway);
          });
        }
      );

      req.on('error', (err: Error) => {
        getLogger().error('Failed to forward gateway:inbound to Agent Server', err, { sessionId }, LogComponent.Gateway);
      });

      req.write(body);
      req.end();

      getLogger().debug('Forwarded gateway:inbound to Agent Server', { sessionId, promptLength: inboundMsg.prompt.length }, LogComponent.Gateway);
      break;
    }

    case 'bridge:permission':
    case 'bridge:platform_state':
    case 'bridge:status':
      break;

    case 'gateway:getStatus:response': {
      const request = _gatewayStatusRequests.get(msg.id as string);
      if (request) {
        clearTimeout(request.timeout);
        _gatewayStatusRequests.delete(msg.id as string);
        request.resolve(msg.status);
      }
      break;
    }

    case 'bridge:error': {
      const message = msg.message as string || 'Unknown gateway error';
      getLogger().error(`Gateway bridge error: ${message}`, undefined, { sessionId, error: msg.error }, LogComponent.Gateway);

      if (message.includes('authentication') || message.includes('token expired') || message.includes('Invalid token')) {
        getLogger().warn('Gateway platform authentication failure, will restart gateway', undefined, LogComponent.Gateway);
        onAuthFailure();
      }
      break;
    }

    default:
      getLogger().debug('Unknown gateway message type', { type, sessionId }, LogComponent.Gateway);
      console.log('[STARTUP] Unknown gateway msg:', type, 'sessionId:', sessionId);
      break;
  }
}

function requestGatewayStatus(): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const proc = getGatewayProcess();
      if (!proc || proc.killed) {
        reject(new Error('Gateway not running'));
        return;
      }

      const id = `status-${Date.now()}`;
      const timeout = setTimeout(() => {
        _gatewayStatusRequests.delete(id);
        reject(new Error('Gateway status request timeout'));
      }, 5000);

      _gatewayStatusRequests.set(id, { resolve, reject, timeout });
      proc.send({ type: 'gateway:getStatus', id });
    });
  }

// Outbound functions
export function sendToGatewayProcess(data: Record<string, unknown>): void {
  const proc = getGatewayProcess();
  if (proc && !proc.killed) {
    proc.send(data);
  }
}

export function forwardToGateway(sessionId: string, event: Record<string, unknown>): void {
  const proc = getGatewayProcess();
  if (!proc || proc.killed) {
    getLogger().warn('Cannot forward: gateway not running', { sessionId }, LogComponent.Gateway);
    return;
  }

  const states = getSessionStates();
  const sessionInfo = states.get(sessionId);

  proc.send({
    type: 'gateway:outbound',
    sessionId,
    platform: sessionInfo?.bridgeChannel,
    platformChatId: undefined,
    event,
  });
}

export function forwardPermissionToGateway(
  sessionId: string,
  permission: { id: string; toolName: string; toolInput: Record<string, unknown> },
): void {
  const proc = getGatewayProcess();
  if (!proc || proc.killed) return;

  proc.send({
    type: 'gateway:permission_request',
    sessionId,
    permission,
  });
}

export function isGatewaySession(sessionId: string): boolean {
  return getSessionStates().has(sessionId);
}

// IPC handlers
const _gatewayStatusRequests = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void; timeout: ReturnType<typeof setTimeout> }>();

let _initConfig: GatewayInitConfig | undefined;

function getOrBuildInitConfig(): GatewayInitConfig {
  if (_initConfig) return _initConfig;

  const db = getDatabase();
  const platforms: Array<{ platform: string; enabled: boolean; credentials: Record<string, string>; options?: Record<string, unknown> }> = [];

  if (db) {
    // Load WeChat/iLink accounts from weixin_accounts table
    const weixinAccounts = db.prepare(
      'SELECT account_id, user_id, token, base_url, cdn_base_url FROM weixin_accounts WHERE enabled = 1'
    ).all() as Array<{ account_id: string; user_id: string; token: string; base_url: string; cdn_base_url: string }>;

    for (const account of weixinAccounts) {
      platforms.push({
        platform: 'weixin',
        enabled: true,
        credentials: {
          botToken: account.token,
          ilinkBotId: account.account_id,
          baseUrl: account.base_url || 'https://ilinkai.weixin.qq.com',
          cdnBaseUrl: account.cdn_base_url || 'https://novac2c.cdn.weixin.qq.com/c2c',
        },
      });
    }

    // Load legacy settings-based WeChat config if no accounts exist
    if (weixinAccounts.length === 0) {
      const weixinEnabled = db.prepare("SELECT value FROM settings WHERE key = 'bridge_weixin_enabled'").get() as { value: string } | undefined;
      const weixinToken = db.prepare("SELECT value FROM settings WHERE key = 'weixin_bot_token'").get() as { value: string } | undefined;
      const weixinAccountId = db.prepare("SELECT value FROM settings WHERE key = 'weixin_account_id'").get() as { value: string } | undefined;
      const weixinBaseUrl = db.prepare("SELECT value FROM settings WHERE key = 'weixin_base_url'").get() as { value: string } | undefined;

      if (weixinEnabled?.value === 'true' && weixinToken?.value) {
        platforms.push({
          platform: 'weixin',
          enabled: true,
          credentials: {
            botToken: weixinToken.value,
            ilinkBotId: weixinAccountId?.value || '',
            baseUrl: weixinBaseUrl?.value || 'https://ilinkai.weixin.qq.com',
            cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
          },
        });
      }
    }

    // Load Telegram config
    const telegramEnabled = db.prepare("SELECT value FROM settings WHERE key = 'bridge_telegram_enabled'").get() as { value: string } | undefined;
    const telegramToken = db.prepare("SELECT value FROM settings WHERE key = 'telegram_bot_token'").get() as { value: string } | undefined;

    if (telegramEnabled?.value === 'true' && telegramToken?.value) {
      platforms.push({
        platform: 'telegram',
        enabled: true,
        credentials: { token: telegramToken.value },
      });
    }

    // Load QQ config
    const qqEnabled = db.prepare("SELECT value FROM settings WHERE key = 'bridge_qq_enabled'").get() as { value: string } | undefined;
    const qqAppId = db.prepare("SELECT value FROM settings WHERE key = 'bridge_qq_app_id'").get() as { value: string } | undefined;
    const qqAppSecret = db.prepare("SELECT value FROM settings WHERE key = 'bridge_qq_app_secret'").get() as { value: string } | undefined;

    if (qqEnabled?.value === 'true' && qqAppId?.value && qqAppSecret?.value) {
      platforms.push({
        platform: 'qq',
        enabled: true,
        credentials: {
          appId: qqAppId.value,
          appSecret: qqAppSecret.value,
        },
      });
    }

    // Load Feishu config
    const feishuEnabled = db.prepare("SELECT value FROM settings WHERE key = 'bridge_feishu_enabled'").get() as { value: string } | undefined;
    const feishuAppId = db.prepare("SELECT value FROM settings WHERE key = 'bridge_feishu_app_id'").get() as { value: string } | undefined;
    const feishuAppSecret = db.prepare("SELECT value FROM settings WHERE key = 'bridge_feishu_app_secret'").get() as { value: string } | undefined;

    if (feishuEnabled?.value === 'true' && feishuAppId?.value && feishuAppSecret?.value) {
      platforms.push({
        platform: 'feishu',
        enabled: true,
        credentials: {
          appId: feishuAppId.value,
          appSecret: feishuAppSecret.value,
        },
      });
    }
  }

  // Check auto-start setting
  let autoStart = false;
  if (db) {
    const autoStartRow = db.prepare("SELECT value FROM settings WHERE key = 'bridge_auto_start'").get() as { value: string } | undefined;
    autoStart = autoStartRow?.value === 'true';
  }

  _initConfig = {
    platforms,
    autoStart,
  };

  console.log('[STARTUP] getOrBuildInitConfig:', JSON.stringify({ platforms: platforms.map(p => ({ platform: p.platform, enabled: p.enabled, hasCredentials: !!Object.keys(p.credentials).length })), autoStart }));
  return _initConfig;
}

export function registerGatewayIpcHandlers(): void {
  ipcMain.handle('gateway:start', async () => {
    try {
      const config = getOrBuildInitConfig();
      console.log('[STARTUP] gateway:start called, platforms count:', config.platforms.length);
      const child = startGatewayProcess(config);

      child.on('message', (msg: Record<string, unknown>) => {
        handleGatewayMessage(msg, () => {
          if (_initConfig) {
            startGatewayProcess(_initConfig);
          }
        });
      });

      try {
        await waitForGatewayReady(config, child, 30_000);
        child.send({ type: 'init', config });
        console.log('[STARTUP] UI gateway:start sent init');
        return { success: true };
      } catch (err) {
        getLogger().error('Gateway startup timeout', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Gateway);
        return { success: false, error: 'Gateway startup timeout' };
      }
    } catch (err) {
      getLogger().error('Failed to start gateway', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Gateway);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('gateway:stop', async () => {
    stopGatewayProcess();
    const states = getSessionStates();
    states.clear();
    _initConfig = undefined;
    return { success: true };
  });

  ipcMain.handle('gateway:reload', async () => {
    try {
      stopGatewayProcess();
      const states = getSessionStates();
      states.clear();
      _initConfig = undefined;
      const config = getOrBuildInitConfig();
      const child = startGatewayProcess(config);
      child.on('message', (msg: Record<string, unknown>) => {
        handleGatewayMessage(msg, () => {
          if (_initConfig) {
            startGatewayProcess(_initConfig);
          }
        });
      });
      await waitForGatewayReady(config, child, 30_000);
      return { success: true };
    } catch (err) {
      getLogger().error('Gateway reload failed', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Gateway);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('gateway:testChannel', async (_event, channel: string) => {
    return await testBridgeChannel(channel);
  });

  ipcMain.handle('gateway:status', async () => {
    return {
      running: isGatewayRunning(),
      sessions: Array.from(getSessionStates().values()),
    };
  });

  ipcMain.handle('gateway:pairing:list', async () => {
    try {
      const store = getPairingStore();
      const pending = store.listAllPending();
      const approved = store.listApproved();
      return { pending, approved };
    } catch (err) {
      getLogger().error('Failed to list pairings', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Gateway);
      return { pending: [], approved: [] };
    }
  });

  ipcMain.handle('gateway:getStatus', async () => {
    let autoStart = false;
    try {
      const db = getDatabase();
      if (db) {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'bridge_auto_start'").get() as { value: string } | undefined;
        autoStart = row?.value === 'true';
      }
    } catch { /* best effort */ }

    const running = isGatewayRunning();
    let adapters: Array<Record<string, unknown>> = [];

    if (running) {
      try {
        const status = await requestGatewayStatus();
        adapters = (status.adapters as Array<Record<string, unknown>>) || [];
      } catch { /* best effort */ }
    }

    return {
      running,
      adapters,
      autoStart,
      _orphaned: false,
    };
  });

  ipcMain.handle('gateway:send', (_event, sessionId: string, data: string) => {
    try {
      const parsed = typeof data === 'string' ? JSON.parse(data) : data;
      forwardToGateway(sessionId, parsed);
    } catch {
      forwardToGateway(sessionId, data as unknown as Record<string, unknown>);
    }
    return { success: true };
  });

  ipcMain.handle('gateway:permission', (_event, sessionId: string, permission: { id: string; toolName: string; toolInput: Record<string, unknown> }) => {
    forwardPermissionToGateway(sessionId, permission);
    return { success: true };
  });

  ipcMain.handle('gateway:create_session', (_event, sessionId: string, channel: string) => {
    createOrResetGatewaySession(sessionId, channel);
    return { success: true };
  });

  ipcMain.handle('gateway:reset_session', (_event, sessionId: string) => {
    resetGatewaySession(sessionId);
    return { success: true };
  });

  ipcMain.handle('gateway:is_gateway_session', (_event, sessionId: string) => {
    return isGatewaySession(sessionId);
  });

  ipcMain.handle('gateway:listSessions', () => {
    const db = getDatabase();

    // Get all gateway sessions from database
    // Gateway sessions have 'gw-' prefix in their id
    const sessions: Array<{
      id: string;
      title: string;
      platform: string;
      platformUserId: string;
      platformChatId: string;
      createdAt: number;
      updatedAt: number;
    }> = [];

    if (db) {
      try {
        // Query all gateway sessions (id starts with 'gw-')
        const rows = db.prepare(`
          SELECT id, title, created_at, updated_at
          FROM threads
          WHERE id LIKE 'gw-%'
          ORDER BY updated_at DESC
        `).all() as Array<{
          id: string;
          title: string;
          created_at: number;
          updated_at: number;
        }>;

        for (const row of rows) {
          // Try to get platform info from gateway_user_map
          const mapping = db.prepare(`
            SELECT platform, platform_user_id, platform_chat_id
            FROM gateway_user_map
            WHERE session_id = ?
          `).get(row.id) as {
            platform?: string;
            platform_user_id?: string;
            platform_chat_id?: string;
          } | undefined;

          // Extract platform from title if no mapping exists
          // Title format: "{platform} {timestamp}" or "{platform} Reset {timestamp}"
          let platform = mapping?.platform || 'unknown';
          if (platform === 'unknown' && row.title) {
            const titleParts = row.title.split(' ');
            if (titleParts.length > 0 && titleParts[0]) {
              platform = titleParts[0].toLowerCase();
            }
          }

          sessions.push({
            id: row.id,
            title: row.title || '',
            platform,
            platformUserId: mapping?.platform_user_id || '',
            platformChatId: mapping?.platform_chat_id || '',
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          });
        }
      } catch (err) {
        getLogger().error('Failed to list gateway sessions', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Gateway);
      }
    }

    return sessions;
  });

  ipcMain.handle('gateway:getSession', (_event, sessionId: string) => {
    const state = getSessionState(sessionId);
    if (!state) return null;

    const db = getDatabase();
    let title = '';

    if (db) {
      try {
        const row = db.prepare('SELECT title FROM threads WHERE id = ?').get(sessionId) as { title: string } | undefined;
        title = row?.title || '';
      } catch { /* best effort */ }
    }

    return {
      id: state.sessionId,
      title,
      platform: state.bridgeChannel || 'unknown',
      platformUserId: '',
      platformChatId: state.sessionId,
      createdAt: state.createdAt,
      updatedAt: state.lastActivityAt,
    };
  });

  ipcMain.handle('gateway:getProxyStatus', async () => {
    function detectWindowsSystemProxy(): string | undefined {
      if (process.platform !== 'win32') return undefined;
      try {
        const enableOutput = execSync(
          'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
          { encoding: 'utf-8', timeout: 3000 }
        );
        if (!enableOutput.match(/ProxyEnable\s+REG_DWORD\s+(0x1|1)/)) return undefined;

        const serverOutput = execSync(
          'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
          { encoding: 'utf-8', timeout: 3000 }
        );
        const serverMatch = serverOutput.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
        if (!serverMatch) return undefined;

        const proxyServer = serverMatch[1];
        const httpsMatch = proxyServer.match(/https=([^;]+)/);
        if (httpsMatch) return `http://${httpsMatch[1]}`;
        const httpMatch = proxyServer.match(/http=([^;]+)/);
        if (httpMatch) return `http://${httpMatch[1]}`;
        if (proxyServer.includes(':')) return `http://${proxyServer}`;
      } catch { /* ignore */ }
      return undefined;
    }

    const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy
      || process.env.HTTP_PROXY || process.env.http_proxy
      || process.env.ALL_PROXY || process.env.all_proxy;
    const systemProxy = detectWindowsSystemProxy();

    return {
      success: true,
      status: {
        configured: undefined,
        env: envProxy,
        system: systemProxy,
        effective: envProxy || systemProxy || undefined,
      },
    };
  });

  ipcMain.handle('gateway:get_config', () => {
    const db = getDatabase();
    if (!db) return {};

    const getSetting = (key: string): string | undefined => {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
      if (row) {
        try { return JSON.parse(row.value); } catch { return row.value; }
      }
      return undefined;
    };

    return {
      telegramToken: getSetting('telegram_bot_token'),
      qqAppId: getSetting('bridge_qq_app_id'),
      qqAppSecret: getSetting('bridge_qq_app_secret'),
      feishuAppId: getSetting('bridge_feishu_app_id'),
      feishuAppSecret: getSetting('bridge_feishu_app_secret'),
      weixinToken: getSetting('weixin_bot_token'),
      weixinAccountId: getSetting('weixin_account_id'),
      weixinBaseUrl: getSetting('weixin_base_url'),
    };
  });

  getLogger().info('Registered gateway IPC handlers', undefined, LogComponent.Gateway);
}

export async function startGateway(): Promise<void> {
  console.log('[STARTUP] startGateway() called');
  const config = getOrBuildInitConfig();
  const child = startGatewayProcess(config);

  child.on('message', (msg: Record<string, unknown>) => {
    handleGatewayMessage(msg, () => {
      if (_initConfig) {
        startGatewayProcess(_initConfig);
      }
    });
  });

  try {
    await waitForGatewayReady(config, child, 30000);
    console.log('[STARTUP] Gateway ready, sending init...');
    child.send({ type: 'init', config });
  } catch (err) {
    getLogger().error('Gateway auto-start timeout', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Gateway);
    console.error('[STARTUP] Gateway auto-start failed:', err);
  }
}
