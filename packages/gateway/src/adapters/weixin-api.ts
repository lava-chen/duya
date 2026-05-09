/**
 * WeChat iLink Bot API - HTTP protocol client
 *
 * Pure protocol layer — no business logic or state management.
 * Derived from OpenClaw weixin plugin reference (protocol only).
 *
 * Disguise notes (for WeChat server-side compatibility):
 * - channel_version: MUST match the real OpenClaw weixin plugin version.
 *   The real @tencent-weixin/openclaw-weixin v1.0.2 reads its own package.json
 *   and sends channel_version: "1.0.2". We replicate that exact value.
 * - X-WECHAT-UIN: MUST use the same generation algorithm as OpenClaw:
 *   random uint32 → decimal string → base64.
 * - Content-Length: included to match real OpenClaw request pattern.
 */

import * as crypto from 'crypto';
import type {
  WeixinCredentials,
  GetUpdatesResponse,
  GetConfigResponse,
  WeixinMessageItem,
  QrCodeStartResponse,
  QrCodeStatusResponse,
} from './weixin-types.js';
import {
  WeixinMessageType,
  WeixinMessageState,
  WeixinMessageItemType,
  DEFAULT_BASE_URL,
  CHANNEL_VERSION,
} from './weixin-types.js';

const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const CONFIG_TIMEOUT_MS = 10_000;
const QR_LOGIN_TIMEOUT_MS = 40_000;

// ============================================================================
// Auth headers — MUST match real OpenClaw weixin plugin pattern
// ============================================================================

function generateWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function buildHeaders(
  creds: WeixinCredentials,
  body: string,
  routeTag?: string,
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body, 'utf-8')),
    'AuthorizationType': 'ilink_bot_token',
    'Authorization': `Bearer ${creds.botToken}`,
    'X-WECHAT-UIN': generateWechatUin(),
    ...(routeTag ? { 'SKRouteTag': routeTag } : {}),
  };
}

// ============================================================================
// Core HTTP client
// ============================================================================

async function weixinRequest<T>(
  creds: WeixinCredentials,
  endpoint: string,
  body: unknown,
  timeoutMs: number = API_TIMEOUT_MS,
  routeTag?: string,
): Promise<T> {
  const url = `${creds.baseUrl || DEFAULT_BASE_URL}/ilink/bot/${endpoint}`;
  const bodyStr = JSON.stringify(body);

  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(creds, bodyStr, routeTag),
    body: bodyStr,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    throw new Error(`WeChat API error: ${res.status} ${res.statusText}`);
  }

  const rawText = await res.text();
  if (!rawText.trim()) return {} as T;

  try {
    return JSON.parse(rawText) as T;
  } catch (err) {
    throw new Error(
      `WeChat API returned non-JSON for ${endpoint}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ============================================================================
// Long polling
// ============================================================================

export async function getUpdates(
  creds: WeixinCredentials,
  getUpdatesBuf: string,
  timeoutMs: number = LONG_POLL_TIMEOUT_MS,
): Promise<GetUpdatesResponse> {
  try {
    return await weixinRequest<GetUpdatesResponse>(
      creds,
      'getupdates',
      {
        get_updates_buf: getUpdatesBuf ?? '',
        base_info: { channel_version: CHANNEL_VERSION },
      },
      timeoutMs + 5_000,
    );
  } catch (err) {
    // Timeout is normal for long-polling
    if (err instanceof Error && err.name === 'TimeoutError') {
      return { msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

// ============================================================================
// Outbound
// ============================================================================

function generateClientId(): string {
  return `duya-wx-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

export async function sendMessage(
  creds: WeixinCredentials,
  toUserId: string,
  items: WeixinMessageItem[],
  contextToken: string,
): Promise<{ clientId: string }> {
  const clientId = generateClientId();
  await weixinRequest<Record<string, unknown>>(creds, 'sendmessage', {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: clientId,
      message_type: WeixinMessageType.BOT,
      message_state: WeixinMessageState.FINISH,
      item_list: items.length > 0 ? items : undefined,
      context_token: contextToken || undefined,
    },
    base_info: { channel_version: CHANNEL_VERSION },
  });
  return { clientId };
}

export async function sendTextMessage(
  creds: WeixinCredentials,
  toUserId: string,
  text: string,
  contextToken: string,
): Promise<{ clientId: string }> {
  return sendMessage(creds, toUserId, [
    { type: WeixinMessageItemType.TEXT, text_item: { text } },
  ], contextToken);
}

// ============================================================================
// Config & typing
// ============================================================================

export async function getConfig(
  creds: WeixinCredentials,
  ilinkUserId?: string,
  contextToken?: string,
): Promise<GetConfigResponse> {
  return weixinRequest<GetConfigResponse>(
    creds,
    'getconfig',
    {
      ilink_user_id: ilinkUserId,
      context_token: contextToken,
      base_info: { channel_version: CHANNEL_VERSION },
    },
    CONFIG_TIMEOUT_MS,
  );
}

export async function sendTyping(
  creds: WeixinCredentials,
  ilinkUserId: string,
  typingTicket: string,
  status: number,
): Promise<void> {
  try {
    await weixinRequest<Record<string, unknown>>(
      creds,
      'sendtyping',
      {
        ilink_user_id: ilinkUserId,
        typing_ticket: typingTicket,
        status,
        base_info: { channel_version: CHANNEL_VERSION },
      },
      CONFIG_TIMEOUT_MS,
    );
  } catch {
    // Typing indicator is best-effort
  }
}

// ============================================================================
// QR Login
// ============================================================================

export async function startLoginQr(): Promise<QrCodeStartResponse> {
  const url = `${DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`;
  const res = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`QR login start failed: ${res.status}`);
  return res.json() as Promise<QrCodeStartResponse>;
}

export async function pollLoginQrStatus(qrcode: string): Promise<QrCodeStatusResponse> {
  const url = `${DEFAULT_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const res = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(QR_LOGIN_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`QR status poll failed: ${res.status}`);
  return res.json() as Promise<QrCodeStatusResponse>;
}
