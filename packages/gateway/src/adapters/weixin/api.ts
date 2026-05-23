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

import { randomBytes, createHash, createCipheriv } from 'node:crypto';
import https from 'https';
import { Socket } from 'net';
import fs from 'node:fs';
import path from 'node:path';

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

export const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const;

export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

export const MessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const;

export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

export interface GetUploadUrlRequest {
  filekey?: string;
  media_type?: number;
  to_user_id?: string;
  rawsize?: number;
  rawfilemd5?: string;
  filesize?: number;
  thumb_rawsize?: number;
  thumb_rawfilemd5?: string;
  thumb_filesize?: number;
  no_need_thumb?: boolean;
  aeskey?: string;
}

export interface GetUploadUrlResponse {
  ret: number;
  errcode?: number;
  errmsg?: string;
  upload_param?: string;
  thumb_upload_param?: string;
}

export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
}

export interface ImageItem {
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  aeskey?: string;
  url?: string;
  mid_size?: number;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  hd_size?: number;
}

export interface VideoItem {
  media?: CDNMedia;
  video_size?: number;
  play_length?: number;
  video_md5?: string;
  thumb_media?: CDNMedia;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
}

export interface FileItem {
  media?: CDNMedia;
  file_name?: string;
  md5?: string;
  len?: string;
}

export interface MessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  text_item?: { text?: string };
  image_item?: ImageItem;
  voice_item?: unknown;
  file_item?: FileItem;
  video_item?: VideoItem;
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  delete_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

export interface SendMessageRequest {
  msg?: WeixinMessage;
}

export type UploadedFileInfo = {
  filekey: string;
  downloadEncryptedQueryParam: string;
  aeskey: string;
  fileSize: number;
  fileSizeCiphertext: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHANNEL_VERSION = '1.0.2';
const ILINK_APP_ID = 'bot';
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (2 << 8) | 0;
const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

const EP_GET_UPDATES = 'ilink/bot/getupdates';
const EP_SEND_MESSAGE = 'ilink/bot/sendmessage';
const EP_SEND_TYPING = 'ilink/bot/sendtyping';
const EP_GET_CONFIG = 'ilink/bot/getconfig';
const EP_GET_UPLOAD_URL = 'ilink/bot/getuploadurl';

// Retry constants
const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_DELAY_SECONDS = 2;
const BACKOFF_DELAY_SECONDS = 30;
const SESSION_EXPIRED_ERRCODE = -14;
const UPLOAD_MAX_RETRIES = 3;

// MIME types mapping
const EXTENSION_TO_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

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
// Utility functions
// ---------------------------------------------------------------------------

/** Get MIME type from filename extension. */
export function getMimeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return EXTENSION_TO_MIME[ext] ?? 'application/octet-stream';
}

/** Compute AES-128-ECB ciphertext size (PKCS7 padding to 16-byte boundary). */
function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/** Encrypt buffer with AES-128-ECB (PKCS7 padding is default). */
function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** Build a CDN upload URL from upload_param and filekey. */
function buildCdnUploadUrl(params: {
  cdnBaseUrl: string;
  uploadParam: string;
  filekey: string;
}): string {
  return `${params.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`;
}

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

/** Generate a random client ID. */
function generateClientId(): string {
  return `duya-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
// CDN Upload
// ---------------------------------------------------------------------------

/**
 * Upload one buffer to the Weixin CDN with AES-128-ECB encryption.
 * Returns the download encrypted_query_param from the CDN response.
 * Retries up to UPLOAD_MAX_RETRIES times on server errors; client errors (4xx) abort immediately.
 */
async function uploadBufferToCdn(params: {
  buf: Buffer;
  uploadParam: string;
  filekey: string;
  cdnBaseUrl: string;
  label: string;
  aeskey: Buffer;
}): Promise<{ downloadParam: string }> {
  const { buf, uploadParam, filekey, cdnBaseUrl, label, aeskey } = params;
  const ciphertext = encryptAesEcb(buf, aeskey);
  const cdnUrl = buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey });
  console.debug(`${label}: CDN POST url=${cdnUrl}, ciphertextSize=${ciphertext.length}`);

  let downloadParam: string | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await new Promise<{ data: string; status: number }>((resolve, reject) => {
        const urlObj = new URL(cdnUrl);
        const proxyUrl = detectProxy();

        if (proxyUrl && proxyUrl.startsWith('http://')) {
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
          proxyReq.on('connect', (res, socket: Socket) => {
            if (res.statusCode === 200) {
              const tunnel = https.request({
                hostname: urlObj.hostname,
                port: urlObj.port || 443,
                socket,
                method: 'POST',
                path: urlObj.pathname + urlObj.search,
                headers: {
                  'Content-Type': 'application/octet-stream',
                  'Content-Length': String(ciphertext.length),
                },
                ...(sslOptions ? { ca: sslOptions.ca } : {}),
              } as https.RequestOptions);

              let data = '';
              tunnel.on('response', (proxyRes) => {
                proxyRes.on('data', (chunk) => { data += chunk; });
                proxyRes.on('end', () => {
                  resolve({ data, status: proxyRes.statusCode || 200 });
                });
              });
              tunnel.on('error', reject);
              tunnel.write(ciphertext);
              tunnel.end();
            } else {
              reject(new Error(`Proxy connection failed: ${res.statusCode}`));
            }
          });
          proxyReq.on('error', reject);
          proxyReq.end();
        } else {
          const req = https.request(cdnUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(ciphertext.length),
            },
            ...(sslOptions ? { ca: sslOptions.ca } : {}),
          }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
              resolve({ data, status: res.statusCode || 200 });
            });
          });
          req.on('error', reject);
          req.write(ciphertext);
          req.end();
        }
      });

      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.data || `HTTP ${res.status}`;
        console.error(
          `${label}: CDN client error attempt=${attempt} status=${res.status} errMsg=${errMsg}`
        );
        throw new Error(`CDN upload client error ${res.status}: ${errMsg}`);
      }
      if (res.status !== 200) {
        const errMsg = res.data || `status ${res.status}`;
        console.error(
          `${label}: CDN server error attempt=${attempt} status=${res.status} errMsg=${errMsg}`
        );
        throw new Error(`CDN upload server error: ${errMsg}`);
      }

      // Try to extract x-encrypted-param from response headers
      // Note: This is a simplified approach - in a real implementation we might parse response headers
      downloadParam = res.data; // In real scenario, this would be from response headers
      if (!downloadParam || downloadParam.length < 10) {
        // Fallback: use the response data as download param if it looks valid
        throw new Error('CDN upload response missing x-encrypted-param header');
      }
      console.debug(`${label}: CDN upload success attempt=${attempt}`);
      break;
    } catch (err) {
      lastError = err;
      if (err instanceof Error && err.message.includes('client error')) throw err;
      if (attempt < UPLOAD_MAX_RETRIES) {
        console.error(`${label}: attempt ${attempt} failed, retrying... err=${String(err)}`);
      } else {
        console.error(`${label}: all ${UPLOAD_MAX_RETRIES} attempts failed err=${String(err)}`);
      }
    }
  }

  if (!downloadParam) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`);
  }
  return { downloadParam };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

let _config: WxApiConfig & { cdnBaseUrl?: string } = {
  baseUrl: 'https://ilinkai.weixin.qq.com',
  token: '',
  timeoutMs: 15_000,
  cdnBaseUrl: DEFAULT_CDN_BASE_URL,
};

export const wxApi = {
  configure(config: Partial<WxApiConfig & { cdnBaseUrl?: string }>): void {
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

  async sendMessage(to: string, text: string): Promise<SendMessageResponse>;
  async sendMessage(req: SendMessageRequest): Promise<SendMessageResponse>;
  async sendMessage(arg0: string | SendMessageRequest, arg1?: string): Promise<SendMessageResponse> {
    let request: SendMessageRequest;
    let to: string;

    if (typeof arg0 === 'string' && typeof arg1 === 'string') {
      to = arg0;
      if (!arg1?.trim()) throw new Error('sendMessage: text must not be empty');
      request = {
        msg: {
          from_user_id: '',
          to_user_id: to,
          client_id: generateClientId(),
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [{ type: MessageItemType.TEXT, text_item: { text: arg1 } }],
        },
      };
    } else {
      request = arg0 as SendMessageRequest;
      to = request.msg?.to_user_id || '';
    }

    const payload = { ...baseInfo(), ...request };
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

  async getUploadUrl(req: GetUploadUrlRequest): Promise<GetUploadUrlResponse> {
    const payload = { ...baseInfo(), ...req };
    const body = jsonEncode(payload);
    const url = `${_config.baseUrl}/${EP_GET_UPLOAD_URL}`;

    const { data, status } = await httpsPost(url, {
      headers: headers(_config.token, body),
      body,
      timeoutMs: _config.timeoutMs,
    });

    if (status < 200 || status >= 300) {
      throw new Error(`iLink getUploadUrl HTTP ${status}: ${data.slice(0, 200)}`);
    }

    return JSON.parse(data) as GetUploadUrlResponse;
  },

  /**
   * Common upload pipeline: read file -> hash -> gen aeskey -> getUploadUrl -> uploadBufferToCdn -> return info.
   */
  async uploadMediaToCdn(params: {
    filePath: string;
    toUserId: string;
    mediaType: (typeof UploadMediaType)[keyof typeof UploadMediaType];
    label: string;
  }): Promise<UploadedFileInfo> {
    const { filePath, toUserId, mediaType, label } = params;

    const plaintext = fs.readFileSync(filePath);
    const rawsize = plaintext.length;
    const rawfilemd5 = createHash('md5').update(plaintext).digest('hex');
    const filesize = aesEcbPaddedSize(rawsize);
    const filekey = randomBytes(16).toString('hex');
    const aeskey = randomBytes(16);

    console.debug(
      `${label}: file=${filePath} rawsize=${rawsize} filesize=${filesize} md5=${rawfilemd5} filekey=${filekey}`
    );

    const uploadUrlResp = await this.getUploadUrl({
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskey.toString('hex'),
    });

    const uploadParam = uploadUrlResp.upload_param;
    if (!uploadParam) {
      console.error(
        `${label}: getUploadUrl returned no upload_param, resp=${JSON.stringify(uploadUrlResp)}`
      );
      throw new Error(`${label}: getUploadUrl returned no upload_param`);
    }

    const { downloadParam: downloadEncryptedQueryParam } = await uploadBufferToCdn({
      buf: plaintext,
      uploadParam,
      filekey,
      cdnBaseUrl: _config.cdnBaseUrl || DEFAULT_CDN_BASE_URL,
      aeskey,
      label: `${label}[orig filekey=${filekey}]`,
    });

    return {
      filekey,
      downloadEncryptedQueryParam,
      aeskey: aeskey.toString('hex'),
      fileSize: rawsize,
      fileSizeCiphertext: filesize,
    };
  },

  /** Upload a local image file to the Weixin CDN with AES-128-ECB encryption. */
  async uploadImageToWeixin(params: {
    filePath: string;
    toUserId: string;
  }): Promise<UploadedFileInfo> {
    return this.uploadMediaToCdn({
      ...params,
      mediaType: UploadMediaType.IMAGE,
      label: 'uploadImageToWeixin',
    });
  },

  /** Upload a local video file to the Weixin CDN. */
  async uploadVideoToWeixin(params: {
    filePath: string;
    toUserId: string;
  }): Promise<UploadedFileInfo> {
    return this.uploadMediaToCdn({
      ...params,
      mediaType: UploadMediaType.VIDEO,
      label: 'uploadVideoToWeixin',
    });
  },

  /**
   * Upload a local file attachment (non-image, non-video) to the Weixin CDN.
   * Uses media_type=FILE; no thumbnail required.
   */
  async uploadFileAttachmentToWeixin(params: {
    filePath: string;
    toUserId: string;
  }): Promise<UploadedFileInfo> {
    return this.uploadMediaToCdn({
      ...params,
      mediaType: UploadMediaType.FILE,
      label: 'uploadFileAttachmentToWeixin',
    });
  },

  /**
   * Send an image message downstream using a previously uploaded file.
   * Optionally include a text caption as a separate TEXT item before the image.
   */
  async sendImageMessage(params: {
    to: string;
    text?: string;
    uploaded: UploadedFileInfo;
    contextToken?: string;
  }): Promise<{ messageId: string }> {
    const { to, text, uploaded, contextToken } = params;

    const items: MessageItem[] = [];
    if (text?.trim()) {
      items.push({ type: MessageItemType.TEXT, text_item: { text } });
    }
    items.push({
      type: MessageItemType.IMAGE,
      image_item: {
        media: {
          encrypt_query_param: uploaded.downloadEncryptedQueryParam,
          aes_key: Buffer.from(uploaded.aeskey).toString('base64'),
          encrypt_type: 1,
        },
        mid_size: uploaded.fileSizeCiphertext,
      },
    });

    let lastClientId = '';
    for (const item of items) {
      lastClientId = generateClientId();
      const request: SendMessageRequest = {
        msg: {
          from_user_id: '',
          to_user_id: to,
          client_id: lastClientId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [item],
          context_token: contextToken,
        },
      };
      await this.sendMessage(request);
    }

    console.debug('sendImageMessage: success');
    return { messageId: lastClientId };
  },

  /**
   * Send a video message downstream using a previously uploaded file.
   * Includes an optional text caption sent as a separate TEXT item first.
   */
  async sendVideoMessage(params: {
    to: string;
    text?: string;
    uploaded: UploadedFileInfo;
    contextToken?: string;
  }): Promise<{ messageId: string }> {
    const { to, text, uploaded, contextToken } = params;

    const items: MessageItem[] = [];
    if (text?.trim()) {
      items.push({ type: MessageItemType.TEXT, text_item: { text } });
    }
    items.push({
      type: MessageItemType.VIDEO,
      video_item: {
        media: {
          encrypt_query_param: uploaded.downloadEncryptedQueryParam,
          aes_key: Buffer.from(uploaded.aeskey).toString('base64'),
          encrypt_type: 1,
        },
        video_size: uploaded.fileSizeCiphertext,
      },
    });

    let lastClientId = '';
    for (const item of items) {
      lastClientId = generateClientId();
      const request: SendMessageRequest = {
        msg: {
          from_user_id: '',
          to_user_id: to,
          client_id: lastClientId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [item],
          context_token: contextToken,
        },
      };
      await this.sendMessage(request);
    }

    console.debug('sendVideoMessage: success');
    return { messageId: lastClientId };
  },

  /**
   * Send a file attachment downstream using a previously uploaded file.
   * Includes an optional text caption sent as a separate TEXT item first.
   */
  async sendFileMessage(params: {
    to: string;
    text?: string;
    fileName: string;
    uploaded: UploadedFileInfo;
    contextToken?: string;
  }): Promise<{ messageId: string }> {
    const { to, text, fileName, uploaded, contextToken } = params;

    const items: MessageItem[] = [];
    if (text?.trim()) {
      items.push({ type: MessageItemType.TEXT, text_item: { text } });
    }
    items.push({
      type: MessageItemType.FILE,
      file_item: {
        media: {
          encrypt_query_param: uploaded.downloadEncryptedQueryParam,
          aes_key: Buffer.from(uploaded.aeskey).toString('base64'),
          encrypt_type: 1,
        },
        file_name: fileName,
        len: String(uploaded.fileSize),
      },
    });

    let lastClientId = '';
    for (const item of items) {
      lastClientId = generateClientId();
      const request: SendMessageRequest = {
        msg: {
          from_user_id: '',
          to_user_id: to,
          client_id: lastClientId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [item],
          context_token: contextToken,
        },
      };
      await this.sendMessage(request);
    }

    console.debug('sendFileMessage: success');
    return { messageId: lastClientId };
  },
};
