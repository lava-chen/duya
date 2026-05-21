/**
 * WeChat iLink Bot API client
 *
 * Low-level HTTP wrapper for the Tencent iLink Bot API.
 * Reference: https://ilinkai.weixin.qq.com
 *
 * Features:
 * 1. SSL certificate handling with certifi CA bundle (fixes ECONNRESET on some systems)
 * 2. Exponential backoff retry for network failures
 * 3. Session expired detection and handling (errcode -14)
 */

import { randomBytes } from 'node:crypto';
import https from 'https';
import { Socket } from 'net';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WxApiConfig {
  baseUrl: string;
  token: string;
  timeoutMs: number;
}

interface BaseInfo {
  channel_version: string;
}

export interface GetUpdatesResponse {
  ret: number;
  errcode?: number;
  errmsg?: string;
  msgs?: Array<Record<string, unknown>>;
  get_updates_buf: string;
  longpolling_timeout_ms?: number;
}

export interface SendMessageResponse {
  ret: number;
  errcode?: number;
  errmsg?: string;
  msg_id?: string;
}

export interface SendTypingResponse {
  ret: number;
  errcode?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHANNEL_VERSION = '1.0.2';
const ILINK_APP_ID = 'bot';
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (2 << 8) | 0;

const EP_GET_UPDATES = 'ilink/bot/getupdates';
const EP_SEND_MESSAGE = 'ilink/bot/sendmessage';
const EP_SEND_TYPING = 'ilink/bot/sendtyping';
const EP_GET_CONFIG = 'ilink/bot/getconfig';

// Retry constants
const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_DELAY_SECONDS = 2;
const BACKOFF_DELAY_SECONDS = 30;
const SESSION_EXPIRED_ERRCODE = -14;

// ---------------------------------------------------------------------------
// SSL Certificate Handling (fixes ECONNRESET on some systems)
// ---------------------------------------------------------------------------

/**
 * Create SSL context with certifi CA bundle.
 * This fixes TLS verification issues with Tencent's iLink server
 * on systems where the default CA store doesn't include the required certificates.
 */
function createSslContext(): { ca: string } | undefined {
  try {
    // Try to use certifi for better CA handling
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const certifi = require('certifi') as { where: () => string } | undefined;
    if (certifi) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('fs') as typeof import('fs');
      const ca = fs.readFileSync(certifi.where(), 'utf-8');
      return { ca };
    }
  } catch {
    // certifi not available, fall back to default
  }
  return undefined;
}

const sslOptions = createSslContext();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION };
}

function randomWechatUin(): string {
  const buf = randomBytes(4);
  return buf.toString('base64');
}

function headers(token: string, body: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'Content-Length': String(new TextEncoder().encode(body).length),
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
    'Authorization': `Bearer ${token}`,
  };
}

function jsonEncode(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

// ---------------------------------------------------------------------------
// Network Errors Classification
// ---------------------------------------------------------------------------

/**
 * Check if an error is a retryable network error
 */
function isNetworkError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('socket hang up') ||
    msg.includes('socket disconnected') ||
    msg.includes('tls') ||
    msg.includes('fetch failed') ||
    msg.includes('network socket') ||
    msg.includes('handshake')
  );
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Proxy Support
// ---------------------------------------------------------------------------

/**
 * Detect proxy URL from environment variables or system settings.
 * Mirrors the proxy detection logic from proxy-fetch.ts.
 */
function detectProxy(): string | undefined {
  // Check environment variables
  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;

  if (envProxy) {
    return envProxy;
  }

  // Try to detect Windows system proxy via registry
  if (process.platform === 'win32') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { execSync } = require('child_process') as typeof import('child_process');
      const enableOutput = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
        { encoding: 'utf-8', timeout: 3000 }
      );
      const enableMatch = enableOutput.match(/ProxyEnable\s+REG_DWORD\s+(0x1|1)/);
      if (!enableMatch) return undefined;

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
      // Registry query failed, ignore
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// HTTPS Request with SSL and Retry
// ---------------------------------------------------------------------------

/**
 * Direct HTTPS POST request with SSL context and retry logic.
 * Uses certifi CA bundle to fix TLS verification issues.
 * Supports HTTP(S) proxy via environment variables.
 */
async function httpsPost(
  url: string,
  options: {
    headers: Record<string, string>;
    body: string;
    timeoutMs: number;
    token?: string;
  },
): Promise<{ data: string; status: number }> {
  const { headers: reqHeaders, body, timeoutMs } = options;
  const urlObj = new URL(url);
  const proxyUrl = detectProxy();
  console.log(`[Weixin] httpsPost: url=${urlObj.hostname}, proxy=${proxyUrl || 'none'}`);
  let consecutiveFailures = 0;

  while (true) {
    try {
      const result = await new Promise<{ data: string; status: number }>((resolve, reject) => {
        // Use HTTP CONNECT tunneling for HTTPS through proxy
        if (proxyUrl && proxyUrl.startsWith('http://')) {
          console.log(`[Weixin] Using proxy tunnel to ${urlObj.hostname}`);
          const proxyUrlObj = new URL(proxyUrl);
          const proxyOptions: https.RequestOptions = {
            hostname: proxyUrlObj.hostname,
            port: proxyUrlObj.port ? parseInt(proxyUrlObj.port, 10) : 8080,
            path: `${urlObj.hostname}:${urlObj.port || 443}`,
            method: 'CONNECT',
            headers: {
              ...(proxyUrlObj.username && proxyUrlObj.password
                ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${proxyUrlObj.username}:${proxyUrlObj.password}`).toString('base64')}` }
                : {}),
            },
          };

          const proxyReq = https.request(proxyOptions);

          proxyReq.on('connect', (res, socket: Socket, head) => {
            if (res.statusCode === 200) {
              // Tunnel established, now make the actual request
              const tunnel = https.request({
                hostname: urlObj.hostname,
                port: urlObj.port || 443,
                socket,
                method: 'POST',
                path: urlObj.pathname + urlObj.search,
                headers: reqHeaders,
                ...(sslOptions ? { ca: sslOptions.ca } : {}),
              } as https.RequestOptions);

              tunnel.on('response', (proxyRes) => {
                let data = '';
                proxyRes.on('data', (chunk) => { data += chunk; });
                proxyRes.on('end', () => {
                  resolve({ data, status: proxyRes.statusCode || 200 });
                });
              });

              tunnel.on('error', reject);
              tunnel.write(body);
              tunnel.end();
            } else {
              reject(new Error(`Proxy connection failed: ${res.statusCode}`));
            }
          });

          proxyReq.on('error', reject);
          proxyReq.setTimeout(timeoutMs, () => {
            proxyReq.destroy();
            reject(new Error('Proxy connection timeout'));
          });
          proxyReq.end();
        } else {
          // Direct connection (no proxy or non-HTTP proxy)
          console.log(`[Weixin] Direct connection to ${urlObj.hostname}`);
          const requestOptions: https.RequestOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port || 443,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: reqHeaders,
            ...(sslOptions ? { ca: sslOptions.ca } : {}),
          };

          const req = https.request(requestOptions, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
              resolve({ data, status: res.statusCode || 200 });
            });
          });

          req.on('error', reject);
          req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
          });

          req.setTimeout(timeoutMs);
          req.write(body);
          req.end();
        }
      });

      consecutiveFailures = 0;
      console.log(`[Weixin] httpsPost success: status=${result.status}, dataLen=${result.data.length}`);
      return result;
    } catch (err) {
      console.warn(`[Weixin] httpsPost error: ${(err as Error).message}`);
      if (!isNetworkError(err as Error)) {
        throw err;
      }

      consecutiveFailures++;
      console.warn(`[Weixin] HTTPS request failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${(err as Error).message}`);

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        const waitMs = BACKOFF_DELAY_SECONDS * 1000;
        console.warn(`[Weixin] Max failures reached, backing off for ${waitMs}ms`);
        await sleep(waitMs);
        consecutiveFailures = 0;
      } else {
        await sleep(RETRY_DELAY_SECONDS * 1000 * consecutiveFailures);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

let _config: WxApiConfig = {
  baseUrl: 'https://ilinkai.weixin.qq.com',
  token: '',
  timeoutMs: 15_000,
};

export const wxApi = {
  configure(config: Partial<WxApiConfig>): void {
    _config = { ..._config, ...config };
  },

  async getUpdates(syncBuf: string, timeoutMs: number): Promise<GetUpdatesResponse> {
    const payload = {
      ...baseInfo(),
      get_updates_buf: syncBuf,
    };
    const body = jsonEncode(payload);
    const url = `${_config.baseUrl}/${EP_GET_UPDATES}`;

    const { data } = await httpsPost(url, {
      headers: headers(_config.token, body),
      body,
      timeoutMs,
    });

    const response = JSON.parse(data) as GetUpdatesResponse;

    // Handle session expired (errcode -14)
    if (response.errcode === SESSION_EXPIRED_ERRCODE || response.ret === SESSION_EXPIRED_ERRCODE) {
      console.warn('[Weixin] Session expired, need to re-authenticate');
    }

    return response;
  },

  async sendMessage(to: string, text: string): Promise<SendMessageResponse> {
    if (!text?.trim()) throw new Error('sendMessage: text must not be empty');

    const message = {
      from_user_id: '',
      to_user_id: to,
      client_id: `duya-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text } }],
    };

    const payload = { ...baseInfo(), msg: message };
    const body = jsonEncode(payload);
    const url = `${_config.baseUrl}/${EP_SEND_MESSAGE}`;

    const { data, status } = await httpsPost(url, {
      headers: headers(_config.token, body),
      body,
      timeoutMs: _config.timeoutMs,
    });

    if (status < 200 || status >= 300) {
      throw new Error(`iLink sendMessage HTTP ${status}: ${data.slice(0, 200)}`);
    }

    return JSON.parse(data) as SendMessageResponse;
  },

  async sendTyping(toUserId: string, typingStatus: number, typingTicket?: string): Promise<SendTypingResponse> {
    const payload: Record<string, unknown> = {
      ...baseInfo(),
      ilink_user_id: toUserId,
      status: typingStatus,
    };
    if (typingTicket) {
      payload.typing_ticket = typingTicket;
    }
    const body = jsonEncode(payload);
    const url = `${_config.baseUrl}/${EP_SEND_TYPING}`;

    const { data, status: responseStatus } = await httpsPost(url, {
      headers: headers(_config.token, body),
      body,
      timeoutMs: _config.timeoutMs,
    });

    if (responseStatus < 200 || responseStatus >= 300) {
      throw new Error(`iLink sendTyping HTTP ${responseStatus}`);
    }

    return JSON.parse(data) as SendTypingResponse;
  },

  async getConfig(userId: string, contextToken?: string): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      ...baseInfo(),
      ilink_user_id: userId,
    };
    if (contextToken) {
      payload.context_token = contextToken;
    }

    const body = jsonEncode(payload);
    const url = `${_config.baseUrl}/${EP_GET_CONFIG}`;

    const { data, status } = await httpsPost(url, {
      headers: headers(_config.token, body),
      body,
      timeoutMs: _config.timeoutMs,
    });

    if (status < 200 || status >= 300) {
      throw new Error(`iLink getConfig HTTP ${status}`);
    }

    return JSON.parse(data) as Record<string, unknown>;
  },
};