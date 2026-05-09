/**
 * net-handlers.ts - IPC handlers for external network requests
 *
 * These handlers run in the Electron main process and make HTTP requests
 * to external services (AI providers, bridge integrations, etc.)
 * This allows the renderer to use IPC instead of direct fetch for external calls.
 */

import { ipcMain } from 'electron';
import { getDatabase } from './db-handlers';
import https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import QRCode from 'qrcode';
import { getLogger, LogComponent } from './logger';

/**
 * Detect Windows system proxy via registry query
 */
function detectWindowsSystemProxy(): string | undefined {
  if (process.platform !== 'win32') {
    return undefined;
  }
  try {
    const { execSync } = require('child_process');
    // Query ProxyEnable
    const enableOutput = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
      { encoding: 'utf-8', timeout: 3000 }
    );
    const enableMatch = enableOutput.match(/ProxyEnable\s+REG_DWORD\s+(0x1|1)/);
    if (!enableMatch) return undefined;

    // Query ProxyServer
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
  } catch {
    // Ignore registry query errors
  }
  return undefined;
}

/**
 * Detect system proxy from environment variables, database settings, or Windows registry
 */
function detectProxy(): string | undefined {
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy;
  if (envProxy) return envProxy;

  try {
    const db = getDatabase();
    if (db) {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'bridge_proxy_url'").get() as { value: string } | undefined;
      if (row?.value) return row.value;
    }
  } catch {
    // Database not available, ignore
  }

  return detectWindowsSystemProxy();
}

let proxyAgent: HttpsProxyAgent<string> | undefined;

/**
 * Make an HTTPS request with optional proxy support
 */
function proxyRequest(
  url: string,
  options: https.RequestOptions & { body?: string }
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const proxyUrl = detectProxy();
    const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

    const req = https.request(url, { ...options, agent }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode || 0, data }));
    });

    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

export interface TestProviderBody {
  provider_type?: string;
  base_url?: string;
  api_key?: string;
  model?: string;
  auth_style?: 'api_key' | 'auth_token' | 'env_only';
}

export interface ConnectionTestResult {
  success: boolean;
  message?: string;
  error?: {
    code: string;
    message: string;
    suggestion?: string;
  };
}

interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
  digest: string;
  details?: {
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
}

interface OllamaModelsResult {
  success: boolean;
  models?: Array<{ id: string; name: string; size?: number; modified_at?: string }>;
  error?: string;
}

/**
 * Classify error for user-friendly messages
 */
function classifyError(error: unknown, baseUrl?: string): ConnectionTestResult['error'] {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes('ECONNREFUSED') || message.includes('ENOTFOUND') || message.includes('fetch failed')) {
    return {
      code: 'CONNECTION_FAILED',
      message: '无法连接到服务器',
      suggestion: '请检查 Base URL 是否正确，以及网络连接是否正常',
    };
  }

  if (message.includes('401') || message.includes('Unauthorized')) {
    return {
      code: 'AUTH_FAILED',
      message: '认证失败',
      suggestion: '请检查 API Key 是否正确',
    };
  }

  if (message.includes('403') || message.includes('Forbidden')) {
    return {
      code: 'ACCESS_DENIED',
      message: '访问被拒绝',
      suggestion: '您的 API Key 可能没有权限访问此资源',
    };
  }

  if (message.includes('429') || message.includes('Rate limit')) {
    return {
      code: 'RATE_LIMITED',
      message: '请求过于频繁',
      suggestion: '请稍后再试',
    };
  }

  if (message.includes('404') || message.includes('Not Found')) {
    return {
      code: 'ENDPOINT_NOT_FOUND',
      message: 'API 端点未找到 (404)',
      suggestion: `请检查 Base URL 是否正确。当前 URL: ${baseUrl || '未设置'}`,
    };
  }

  if (message.includes('timeout') || message.includes('aborted')) {
    return {
      code: 'TIMEOUT',
      message: '连接超时',
      suggestion: '服务器响应时间过长，请检查网络或稍后重试',
    };
  }

  return {
    code: 'UNKNOWN_ERROR',
    message: message.slice(0, 200),
    suggestion: '请检查配置是否正确',
  };
}

/**
 * Fetch available models from Ollama
 */
async function fetchOllamaModels(baseUrl: string): Promise<OllamaModelsResult> {
  try {
    // Normalize URL to point to the Ollama API endpoint
    let apiUrl = baseUrl || 'http://localhost:11434';
    apiUrl = apiUrl.replace(/\/$/, '');
    
    // Remove /v1 suffix if present (Ollama native API doesn't use /v1)
    apiUrl = apiUrl.replace(/\/v1$/, '');
    
    const response = await fetch(`${apiUrl}/api/tags`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: ${await response.text()}`,
      };
    }

    const data = await response.json() as { models: OllamaModel[] };
    
    return {
      success: true,
      models: data.models.map((m) => ({
        id: m.name,
        name: m.name,
        size: m.size,
        modified_at: m.modified_at,
      })),
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Test provider connection
 * Supports both Anthropic and OpenAI-compatible APIs
 */
export async function testProviderConnection(body: TestProviderBody): Promise<ConnectionTestResult> {
  const { provider_type, base_url, api_key, model, auth_style } = body;

  if (!api_key && auth_style !== 'env_only') {
    return {
      success: false,
      error: {
        code: 'NO_CREDENTIALS',
        message: 'API Key is required',
        suggestion: 'Please enter your API Key',
      },
    };
  }

  if (provider_type === 'bedrock' || provider_type === 'vertex' || auth_style === 'env_only') {
    return {
      success: false,
      error: {
        code: 'SKIPPED',
        message: '此类提供商无法直接测试连接',
        suggestion: '请保存配置后发送消息来验证连接',
      },
    };
  }

  // Check if this is Ollama
  const isOllama = provider_type === 'ollama' ||
    (base_url && (
      base_url.includes('localhost:11434') ||
      base_url.includes('127.0.0.1:11434') ||
      base_url.includes('ollama')
    ));

  // For Ollama, test by fetching models list
  if (isOllama) {
    const result = await fetchOllamaModels(base_url || 'http://localhost:11434');
    if (result.success) {
      const modelCount = result.models?.length || 0;
      return {
        success: true,
        message: `连接成功，找到 ${modelCount} 个本地模型`,
      };
    } else {
      return {
        success: false,
        error: classifyError(result.error || '连接失败', base_url),
      };
    }
  }

  // Determine if this is an OpenAI-compatible provider
  const isOpenAICompatible = provider_type === 'openai' ||
    provider_type === 'openai-compatible' ||
    (base_url && (
      base_url.includes('openrouter') ||
      base_url.includes('openai') ||
      base_url.includes('api.deepseek') ||
      base_url.includes('api.moonshot') ||
      base_url.includes('api.groq') ||
      base_url.includes('api.together') ||
      base_url.includes('api.perplexity')
    ));

  let apiUrl = base_url || 'https://api.anthropic.com';

  // Normalize URL
  apiUrl = apiUrl.replace(/\/+$/, '');

  if (isOpenAICompatible) {
    // OpenAI-compatible endpoint
    if (!apiUrl.endsWith('/v1/chat/completions')) {
      if (!apiUrl.endsWith('/v1')) {
        apiUrl += '/v1';
      }
      apiUrl += '/chat/completions';
    }
  } else {
    // Anthropic endpoint
    if (!apiUrl.endsWith('/v1/messages')) {
      if (!apiUrl.endsWith('/v1')) {
        apiUrl += '/v1';
      }
      apiUrl += '/messages';
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (isOpenAICompatible) {
    // OpenAI-compatible auth
    headers['Authorization'] = `Bearer ${api_key}`;
  } else {
    // Anthropic auth
    headers['anthropic-version'] = '2023-06-01';
    if (auth_style === 'auth_token') {
      headers['Authorization'] = `Bearer ${api_key}`;
    } else {
      headers['x-api-key'] = api_key!;
    }
  }

  // Model is required for all provider types
  if (!model) {
    return {
      success: false,
      error: {
        code: 'NO_MODEL',
        message: 'Model is required',
        suggestion: 'Select or enter a model name before testing',
      },
    };
  }
  const testModel = model;

  // Build request body based on API type
  // Note: Both OpenAI and Anthropic use similar message format
  const requestBody = JSON.stringify({
    model: testModel,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }],
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: requestBody,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      return {
        success: true,
        message: '连接成功',
      };
    }

    let errorBody = '';
    try {
      errorBody = await response.text();
    } catch { /* ignore */ }

    const error = classifyError(
      new Error(`HTTP ${response.status}: ${errorBody.slice(0, 500)}`),
      base_url
    );

    return {
      success: false,
      error,
    };

  } catch (err) {
    clearTimeout(timeoutId);
    const error = classifyError(err, base_url);
    return {
      success: false,
      error,
    };
  }
}

/**
 * Test bridge channel connection
 */
export async function testBridgeChannel(channel: string): Promise<{ success: boolean; message: string; details?: string }> {
  const db = getDatabase();
  if (!db) {
    return { success: false, message: 'Database not available', details: 'Cannot connect to database' };
  }

  switch (channel) {
    case 'telegram': {
      const token = db.prepare("SELECT value FROM settings WHERE key = 'telegram_bot_token'").get() as { value: string } | undefined;
      if (!token?.value) {
        return { success: false, message: 'Bot token not configured', details: 'Please enter your Telegram bot token' };
      }
      try {
        const { status, data } = await proxyRequest(
          `https://api.telegram.org/bot${token.value}/getMe`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          }
        );
        if (status === 200) {
          const json = JSON.parse(data) as { ok: boolean; result?: { username?: string }; description?: string };
          if (json.ok) {
            return { success: true, message: 'Connection successful', details: `Connected to bot @${json.result?.username || 'unknown'}` };
          }
          return { success: false, message: 'Telegram API error', details: json.description || 'Invalid bot token' };
        }
        return { success: false, message: `HTTP ${status}`, details: data || 'Invalid bot token or network error' };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        getLogger().error('Telegram test error', err instanceof Error ? err : new Error(errorMessage), undefined, LogComponent.NetHandlers);
        return { success: false, message: 'Connection failed', details: errorMessage };
      }
    }

    case 'qq': {
      const appId = db.prepare("SELECT value FROM settings WHERE key = 'bridge_qq_app_id'").get() as { value: string } | undefined;
      const appSecret = db.prepare("SELECT value FROM settings WHERE key = 'bridge_qq_app_secret'").get() as { value: string } | undefined;
      if (!appId?.value || !appSecret?.value) {
        return { success: false, message: 'App ID or Secret not configured', details: 'Please enter both App ID and App Secret' };
      }
      try {
        const response = await fetch('https://api.sgroup.qq.com/oauth2/access_token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `grant_type=client_credentials&client_id=${appId.value}&client_secret=${appSecret.value}`,
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          const data = await response.json() as { access_token?: string; code?: number };
          if (data.access_token) {
            return { success: true, message: 'Connection successful', details: 'QQ Guild API access granted' };
          }
        }
        return { success: false, message: 'Authentication failed', details: 'Invalid App ID or App Secret' };
      } catch {
        return { success: false, message: 'Connection failed', details: 'Network error' };
      }
    }

    case 'feishu': {
      const appId = db.prepare("SELECT value FROM settings WHERE key = 'bridge_feishu_app_id'").get() as { value: string } | undefined;
      const appSecret = db.prepare("SELECT value FROM settings WHERE key = 'bridge_feishu_app_secret'").get() as { value: string } | undefined;
      if (!appId?.value || !appSecret?.value) {
        return { success: false, message: 'App ID or Secret not configured', details: 'Please enter both App ID and App Secret' };
      }
      try {
        const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app_id: appId.value, app_secret: appSecret.value }),
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          const data = await response.json() as { code: number; msg: string; tenant_access_token?: string };
          if (data.code === 0 && data.tenant_access_token) {
            return { success: true, message: 'Connection successful', details: 'Feishu API access granted' };
          }
        }
        const data = await response.json() as { msg?: string };
        return { success: false, message: 'Authentication failed', details: data.msg || 'Invalid App ID or App Secret' };
      } catch {
        return { success: false, message: 'Connection failed', details: 'Network error' };
      }
    }

    case 'weixin': {
      // Check weixin_accounts table for the latest enabled account (source of truth)
      const db = getDatabase();
      if (db) {
        const accountRow = db.prepare(
          'SELECT account_id, user_id, token, base_url FROM weixin_accounts WHERE enabled = 1 ORDER BY last_login_at DESC LIMIT 1'
        ).get() as { account_id: string; user_id: string; token: string; base_url: string } | undefined;

        if (accountRow?.token) {
          getLogger().info(
            '[WeixinTest] Testing account from weixin_accounts',
            { accountId: accountRow.account_id, userId: accountRow.user_id },
            LogComponent.NetHandlers
          );

          // Test the token by making a simple API call (POST with headers, same as Gateway)
          // Use getupdates with short timeout - if we get a timeout or ret=0, the token is valid
          // This matches the official openclaw-weixin behavior
          try {
            const baseUrl = accountRow.base_url || 'https://ilinkai.weixin.qq.com';
            const randomUin = Buffer.from(String(Math.floor(Math.random() * 4294967295)), 'utf-8').toString('base64');

            const response = await fetch(`${baseUrl}/ilink/bot/getupdates`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'AuthorizationType': 'ilink_bot_token',
                'Authorization': `Bearer ${accountRow.token}`,
                'X-WECHAT-UIN': randomUin,
              },
              body: JSON.stringify({
                get_updates_buf: '',
                base_info: { channel_version: '1.0.2' }
              }),
              signal: AbortSignal.timeout(5_000), // Short timeout for test
            });

            if (response.ok) {
              const data = await response.json() as { ret?: number; errcode?: number; errmsg?: string };
              const apiErrcode = data.errcode ?? data.ret ?? 0;
              getLogger().info(
                '[WeixinTest] getupdates response',
                { errcode: data.errcode, ret: data.ret, apiErrcode, errmsg: data.errmsg },
                LogComponent.NetHandlers
              );
              if (apiErrcode === 0) {
                return {
                  success: true,
                  message: 'WeChat connection successful',
                  details: `Connected as ${accountRow.account_id}`
                };
              } else if (apiErrcode === -14) {
                // Session expired is temporary - Gateway will auto-retry after 60 minutes
                // This is normal behavior, don't disable the account
                return {
                  success: false,
                  message: 'Session paused',
                  details: 'WeChat session is temporarily paused (will auto-retry in 60 minutes). If this persists, please scan QR code again.'
                };
              } else {
                return {
                  success: false,
                  message: 'WeChat API error',
                  details: data.errmsg || `Error code: ${apiErrcode}`
                };
              }
            } else {
              return {
                success: false,
                message: 'Connection failed',
                details: `HTTP ${response.status}`
              };
            }
          } catch (err) {
            // Timeout is expected for getupdates (long-polling) - it means the token is valid
            // but there are no new messages. This is normal behavior.
            if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
              getLogger().info(
                '[WeixinTest] getupdates timeout - token is valid (no new messages)',
                { accountId: accountRow.account_id },
                LogComponent.NetHandlers
              );
              return {
                success: true,
                message: 'WeChat connection successful',
                details: `Connected as ${accountRow.account_id}`
              };
            }
            return {
              success: false,
              message: 'Connection failed',
              details: err instanceof Error ? err.message : 'Network error'
            };
          }
        } else {
          // Fallback to settings table for backward compatibility
          const tokenRow = db.prepare("SELECT value FROM settings WHERE key = 'weixin_bot_token'").get() as { value: string } | undefined;
          if (tokenRow?.value) {
            getLogger().warn(
              '[WeixinTest] No enabled account in weixin_accounts, falling back to settings',
              undefined,
              LogComponent.NetHandlers
            );
            // ... (same test logic as above with settings token)
            try {
              const baseUrl = 'https://ilinkai.weixin.qq.com';
              const response = await fetch(`${baseUrl}/ilink/bot/getupdates?bot_token=${encodeURIComponent(tokenRow.value)}&cursor=`, {
                method: 'GET',
                signal: AbortSignal.timeout(10_000),
              });

              if (response.ok) {
                const data = await response.json() as { ret?: number; errcode?: number; errmsg?: string };
                const apiErrcode = data.errcode ?? data.ret ?? 0;
                if (apiErrcode === 0) {
                  return { success: true, message: 'WeChat connection successful', details: 'Connected (legacy mode)' };
                } else if (apiErrcode === -14) {
                  return { success: false, message: 'Session expired', details: 'Please scan QR code again to re-authenticate' };
                } else {
                  return { success: false, message: 'WeChat API error', details: data.errmsg || `Error code: ${apiErrcode}` };
                }
              }
            } catch { /* ignore */ }
          }
        }
      }
      return { success: false, message: 'WeChat requires QR code login', details: 'No WeChat token found. Please scan QR code to authenticate.' };
    }

    default:
      return { success: false, message: `Unknown channel: ${channel}` };
  }
}

// ============================================================================
// WeChat QR Login
// ============================================================================

const QR_LOGIN_BASE_URL = 'https://ilinkai.weixin.qq.com';
const QR_API_TIMEOUT_MS = 15_000;
const QR_POLL_TIMEOUT_MS = 40_000;
const QR_TTL_MS = 5 * 60_000;
const MAX_REFRESHES = 3;

interface QrLoginSession {
  qrcode: string;
  qrImage: string;
  startedAt: number;
  refreshCount: number;
  status: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'failed';
  accountId?: string;
  error?: string;
}

// Use globalThis to store active login sessions, surviving HMR
const WEIXIN_GLOBAL_KEY = '__weixin_login_sessions__';

function getLoginSessions(): Map<string, QrLoginSession> {
  const g = globalThis as Record<string, unknown>;
  if (!g[WEIXIN_GLOBAL_KEY]) {
    g[WEIXIN_GLOBAL_KEY] = new Map<string, QrLoginSession>();
  }
  return g[WEIXIN_GLOBAL_KEY] as Map<string, QrLoginSession>;
}

async function startLoginQr(): Promise<{ qrcode: string; qrcode_img_content: string }> {
  const url = `${QR_LOGIN_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`;
  getLogger().info('[WeixinQrLogin] Requesting QR code from server', { url }, LogComponent.NetHandlers);
  const res = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(QR_API_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`QR login start failed: ${res.status}`);
  }
  const data = await res.json() as { qrcode: string; qrcode_img_content: string };
  getLogger().info('[WeixinQrLogin] QR code received from server', { hasQrcode: !!data.qrcode }, LogComponent.NetHandlers);
  return data;
}

async function pollLoginQrStatus(qrcode: string): Promise<{
  status: string;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
}> {
  const url = `${QR_LOGIN_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const res = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(QR_POLL_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`QR status poll failed: ${res.status}`);
  }
  const data = await res.json() as {
    status: string;
    bot_token?: string;
    ilink_bot_id?: string;
    ilink_user_id?: string;
    baseurl?: string;
  };
  getLogger().debug(
    '[WeixinQrLogin] Poll response',
    { status: data.status, hasBotToken: !!data.bot_token, hasIlinkBotId: !!data.ilink_bot_id },
    LogComponent.NetHandlers
  );
  return data;
}

export async function startWeixinQrLogin(): Promise<{ sessionId: string; qrImage: string }> {
  const resp = await startLoginQr();

  if (!resp.qrcode || !resp.qrcode_img_content) {
    throw new Error('Failed to get QR code from WeChat server');
  }

  const qrDataUrl = await QRCode.toDataURL(resp.qrcode_img_content, { width: 256, margin: 2 });

  const sessionId = `qr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session: QrLoginSession = {
    qrcode: resp.qrcode,
    qrImage: qrDataUrl,
    startedAt: Date.now(),
    refreshCount: 0,
    status: 'waiting',
  };

  getLoginSessions().set(sessionId, session);
  getLogger().info('[WeixinQrLogin] Session created', { sessionId }, LogComponent.NetHandlers);

  // Auto-cleanup after 10 minutes
  setTimeout(() => {
    getLoginSessions().delete(sessionId);
    getLogger().debug('[WeixinQrLogin] Session auto-cleaned up', { sessionId }, LogComponent.NetHandlers);
  }, 10 * 60_000);

  return { sessionId, qrImage: qrDataUrl };
}

export async function pollWeixinQrStatus(sessionId: string): Promise<QrLoginSession> {
  const sessions = getLoginSessions();
  const session = sessions.get(sessionId);
  if (!session) {
    return { qrcode: '', qrImage: '', startedAt: 0, refreshCount: 0, status: 'failed', error: 'Session not found' };
  }

  if (session.status === 'confirmed' || session.status === 'failed') {
    return session;
  }

  // Check if QR has expired (5 minutes)
  if (Date.now() - session.startedAt > QR_TTL_MS) {
    if (session.refreshCount >= MAX_REFRESHES) {
      session.status = 'failed';
      session.error = 'QR code expired after maximum refreshes';
      return session;
    }

    // Refresh QR code
    try {
      const resp = await startLoginQr();
      if (resp.qrcode && resp.qrcode_img_content) {
        session.qrcode = resp.qrcode;
        session.qrImage = await QRCode.toDataURL(resp.qrcode_img_content, { width: 256, margin: 2 });
        session.startedAt = Date.now();
        session.refreshCount++;
        session.status = 'waiting';
      }
    } catch (err) {
      session.status = 'failed';
      session.error = `QR refresh failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    return session;
  }

  // Poll WeChat server for QR status
  try {
    const resp = await pollLoginQrStatus(session.qrcode);

    switch (resp.status) {
      case 'wait':
        session.status = 'waiting';
        break;

      case 'scaned':
        session.status = 'scanned';
        getLogger().info('[WeixinQrLogin] QR code scanned by user', { sessionId }, LogComponent.NetHandlers);
        break;

      case 'confirmed': {
        session.status = 'confirmed';

        if (resp.bot_token && resp.ilink_bot_id) {
          const accountId = (resp.ilink_bot_id || '').replace(/[@.]/g, '-');
          const userId = resp.ilink_user_id || '';
          session.accountId = accountId;

          getLogger().info(
            '[WeixinQrLogin] Login confirmed by WeChat server',
            { accountId, userId, hasToken: true, baseUrl: resp.baseurl || 'default' },
            LogComponent.NetHandlers
          );

          const db = getDatabase();
          if (db) {
            const now = Date.now();

            // 1. Persist to settings table (backward compatibility for testBridgeChannel)
            db.prepare(`
              INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            `).run('weixin_bot_token', resp.bot_token, now);

            db.prepare(`
              INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            `).run('weixin_account_id', accountId, now);

            if (resp.baseurl) {
              db.prepare(`
                INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
              `).run('weixin_base_url', resp.baseurl, now);
            }

            getLogger().info(
              '[WeixinQrLogin] Saved to settings table',
              { accountId },
              LogComponent.NetHandlers
            );

            // 2. Persist to weixin_accounts table (source of truth for Gateway)
            db.prepare(`
              INSERT INTO weixin_accounts (account_id, user_id, name, base_url, cdn_base_url, token, enabled, last_login_at, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(account_id) DO UPDATE SET
                user_id = COALESCE(excluded.user_id, user_id),
                name = COALESCE(excluded.name, name),
                base_url = COALESCE(excluded.base_url, base_url),
                cdn_base_url = COALESCE(excluded.cdn_base_url, cdn_base_url),
                token = excluded.token,
                enabled = COALESCE(excluded.enabled, enabled),
                last_login_at = excluded.last_login_at,
                created_at = COALESCE(weixin_accounts.created_at, excluded.created_at)
            `).run(
              accountId,
              userId,
              accountId,
              resp.baseurl || '',
              '',
              resp.bot_token,
              1, // enabled = true
              now,
              now
            );

            getLogger().info(
              '[WeixinQrLogin] Saved to weixin_accounts table (gateway source of truth)',
              { accountId, enabled: true },
              LogComponent.NetHandlers
            );
          } else {
            getLogger().warn(
              '[WeixinQrLogin] Database not available, cannot persist account',
              { accountId },
              LogComponent.NetHandlers
            );
          }
        } else {
          getLogger().warn(
            '[WeixinQrLogin] Confirmed but missing bot_token or ilink_bot_id',
            { hasBotToken: !!resp.bot_token, hasIlinkBotId: !!resp.ilink_bot_id },
            LogComponent.NetHandlers
          );
        }
        break;
      }

      case 'expired':
        session.status = 'expired';
        session.startedAt = 0; // Force refresh on next poll
        break;

      default:
        break;
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return session;
    }
    getLogger().error('Poll error', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.NetHandlers);
  }

  return session;
}

export function cancelWeixinQrSession(sessionId: string): void {
  getLoginSessions().delete(sessionId);
}

// ============================================================================
// Register all handlers
// ============================================================================

export function registerNetHandlers(): void {
  // Provider connection test
  ipcMain.handle('net:provider:test', async (_event, body: TestProviderBody) => {
    try {
      return await testProviderConnection(body);
    } catch (error) {
      getLogger().error('Provider test error', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.NetHandlers);
      return {
        success: false,
        error: {
          code: 'TEST_FAILED',
          message: error instanceof Error ? error.message : '测试连接失败',
          suggestion: '请稍后重试',
        },
      };
    }
  });

  // Bridge channel test
  ipcMain.handle('net:bridge:test', async (_event, channel: string) => {
    try {
      return await testBridgeChannel(channel);
    } catch (error) {
      getLogger().error('Bridge test error', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.NetHandlers);
      return { success: false, message: 'Connection failed', details: String(error) };
    }
  });

  // WeChat QR login handlers
  ipcMain.handle('net:weixin:qr:start', async () => {
    try {
      const result = await startWeixinQrLogin();
      return { success: true, ...result };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to start QR login',
      };
    }
  });

  ipcMain.handle('net:weixin:qr:poll', async (_event, sessionId: string) => {
    try {
      const session = await pollWeixinQrStatus(sessionId);

      if (session.status === 'confirmed' || session.status === 'failed') {
        setTimeout(() => cancelWeixinQrSession(sessionId), 30_000);
      }

      return {
        success: true,
        status: session.status,
        qr_image: session.qrImage || undefined,
        account_id: session.accountId || undefined,
        error: session.error || undefined,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to poll QR status',
      };
    }
  });

  ipcMain.handle('net:weixin:qr:cancel', (_event, sessionId: string) => {
    cancelWeixinQrSession(sessionId);
    return { success: true };
  });

  // Ollama models fetch
  ipcMain.handle('net:ollama:models', async (_event, baseUrl: string) => {
    try {
      return await fetchOllamaModels(baseUrl);
    } catch (error) {
      getLogger().error('Ollama models fetch error', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.NetHandlers);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch Ollama models',
      };
    }
  });

  getLogger().info('Registered network IPC handlers', undefined, LogComponent.NetHandlers);
}
