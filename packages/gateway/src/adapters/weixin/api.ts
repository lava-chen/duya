/**
 * WeChat iLink Bot API client
 *
 * Low-level HTTP wrapper for the Tencent iLink Bot API.
 * Reference: https://ilinkai.weixin.qq.com
 */

import { proxyFetch } from '../../proxy-fetch.js';

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

const CHANNEL_VERSION = '2.2.0';
const ILINK_APP_ID = 'bot';
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (2 << 8) | 0;

const EP_GET_UPDATES = 'ilink/bot/getupdates';
const EP_SEND_MESSAGE = 'ilink/bot/sendmessage';
const EP_SEND_TYPING = 'ilink/bot/sendtyping';
const EP_GET_CONFIG = 'ilink/bot/getconfig';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION };
}

function randomWechatUin(): string {
  const buf = crypto.getRandomValues(new Uint32Array(1));
  return btoa(String(buf[0]));
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await proxyFetch(url, {
        method: 'POST',
        headers: headers(_config.token, body),
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`iLink getUpdates HTTP ${response.status}`);
      }

      return (await response.json()) as GetUpdatesResponse;
    } finally {
      clearTimeout(timer);
    }
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), _config.timeoutMs);

    try {
      const response = await proxyFetch(url, {
        method: 'POST',
        headers: headers(_config.token, body),
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`iLink sendMessage HTTP ${response.status}`);
      }

      return (await response.json()) as SendMessageResponse;
    } finally {
      clearTimeout(timer);
    }
  },

  async sendTyping(toUserId: string, status: number, typingTicket?: string): Promise<SendTypingResponse> {
    const payload: Record<string, unknown> = {
      ...baseInfo(),
      ilink_user_id: toUserId,
      status,
    };
    if (typingTicket) {
      payload.typing_ticket = typingTicket;
    }
    const body = jsonEncode(payload);
    const url = `${_config.baseUrl}/${EP_SEND_TYPING}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), _config.timeoutMs);

    try {
      const response = await proxyFetch(url, {
        method: 'POST',
        headers: headers(_config.token, body),
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`iLink sendTyping HTTP ${response.status}`);
      }

      return (await response.json()) as SendTypingResponse;
    } finally {
      clearTimeout(timer);
    }
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), _config.timeoutMs);

    try {
      const response = await proxyFetch(url, {
        method: 'POST',
        headers: headers(_config.token, body),
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`iLink getConfig HTTP ${response.status}`);
      }

      return (await response.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
    }
  },
};