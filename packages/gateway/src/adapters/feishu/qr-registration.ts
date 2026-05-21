// @ts-nocheck
/**
 * Feishu QR Code Registration (Device Code Flow)
 *
 * Implements the Feishu/Lark QR scan-to-create onboarding flow:
 * 1. User scans QR code with Feishu mobile app
 * 2. Platform creates a bot application automatically
 * 3. Returns app_id, app_secret for configuration
 *
 * Based on Feishu Open Platform device-code flow:
 * https://open.feishu.cn/document/uAjLw4COM/quickstart/create-app
 */

import { randomBytes } from 'crypto';

export interface QrRegistrationResult {
  app_id: string;
  app_secret: string;
  domain: 'feishu' | 'lark';
  open_id?: string;
}

export interface QrRegistrationBegin {
  device_code: string;
  qr_url: string;
  user_code: string;
  interval: number;
  expire_in: number;
}

const ACCOUNTS_URLS = {
  feishu: 'https://accounts.feishu.cn',
  lark: 'https://accounts.larksuite.com',
};

const OPEN_URLS = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};

const REQUEST_TIMEOUT_MS = 15_000;

const REGISTRATION_PATH = '/oauth/v1/app/registration';

interface LarkError {
  code?: number;
  msg?: string;
  error?: string;
}

/** Initialize registration - check if client_secret auth is supported */
export async function qrRegisterInit(domain: 'feishu' | 'lark' = 'feishu'): Promise<{ supported: boolean; methods?: string[] }> {
  const baseUrl = ACCOUNTS_URLS[domain] ?? ACCOUNTS_URLS.feishu;

  try {
    const body = new URLSearchParams({ action: 'init' }).toString();
    const response = await fetchWithTimeout(`${baseUrl}${REGISTRATION_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      timeout: REQUEST_TIMEOUT_MS,
    });

    const data = await response.json() as Record<string, unknown>;
    const methods = (data.supported_auth_methods as string[]) ?? [];
    return { supported: methods.includes('client_secret'), methods };
  } catch (err) {
    console.error('[Feishu QR] Init error:', err);
    return { supported: false };
  }
}

/** Start the device-code registration flow */
export async function qrRegisterBegin(domain: 'feishu' | 'lark' = 'feishu'): Promise<QrRegistrationBegin | null> {
  const baseUrl = ACCOUNTS_URLS[domain] ?? ACCOUNTS_URLS.feishu;

  try {
    // Feishu requires form-encoded body, not JSON
    const body = new URLSearchParams({
      action: 'begin',
      archetype: 'PersonalAgent',
      auth_method: 'client_secret',
      request_user_info: 'open_id',
    }).toString();

    const response = await fetchWithTimeout(`${baseUrl}${REGISTRATION_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      timeout: REQUEST_TIMEOUT_MS,
    });

    // Feishu returns non-200 even for pending status
    const data = await response.json() as Record<string, unknown>;

    const deviceCode = data.device_code as string | undefined;
    if (!deviceCode) {
      console.error('[Feishu QR] No device_code in response:', data);
      return null;
    }

    let qrUrl = (data.verification_uri_complete as string) ?? '';
    if (qrUrl) {
      // Add tracking params
      qrUrl += qrUrl.includes('?') ? '&from=duya&tp=duya' : '?from=duya&tp=duya';
    }

    return {
      device_code: deviceCode,
      qr_url: qrUrl,
      user_code: (data.user_code as string) ?? '',
      interval: (data.interval as number) ?? 5,
      expire_in: (data.expire_in as number) ?? 600,
    };
  } catch (err) {
    console.error('[Feishu QR] Begin registration error:', err);
    return null;
  }
}

/** Poll until user scans QR code */
export async function qrRegisterPoll(
  begin: QrRegistrationBegin,
  domain: 'feishu' | 'lark' = 'feishu',
  onProgress?: (status: string) => void
): Promise<QrRegistrationResult | null> {
  const baseUrl = ACCOUNTS_URLS[domain] ?? ACCOUNTS_URLS.feishu;
  const deadline = Date.now() + begin.expire_in * 1000;
  let pollCount = 0;
  let currentDomain = domain;

  while (Date.now() < deadline) {
    try {
      // Feishu requires form-encoded body, not JSON
      const body = new URLSearchParams({
        action: 'poll',
        device_code: begin.device_code,
        tp: 'ob_app',
      }).toString();

      const response = await fetchWithTimeout(`${baseUrl}${REGISTRATION_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        timeout: REQUEST_TIMEOUT_MS,
      });

      // Feishu returns non-200 for pending/error states
      const data = await response.json() as Record<string, unknown> & LarkError;

      pollCount++;

      // Status update
      if (pollCount === 1) {
        onProgress?.('fetchWithTimeouting');
      } else if (pollCount % 12 === 0) {
        onProgress?.('polling');
      }

      // Domain auto-detection from user info
      const userInfo = (data.user_info as Record<string, unknown>) ?? {};
      const tenantBrand = userInfo.tenant_brand as string | undefined;
      if (tenantBrand === 'lark' && currentDomain === 'feishu') {
        currentDomain = 'lark';
      }

      // Success - got credentials
      if (data.client_id && data.client_secret) {
        onProgress?.('success');
        return {
          app_id: data.client_id as string,
          app_secret: data.client_secret as string,
          domain: currentDomain,
          open_id: userInfo.open_id as string | undefined,
        };
      }

      // Terminal errors
      const error = data.error ?? data.msg;
      if (error === 'access_denied' || error === 'expired_token') {
        onProgress?.('denied');
        return null;
      }

      // authorization_pending or unknown - keep polling
      await sleep(begin.interval * 1000);
    } catch (err) {
      console.error('[Feishu QR] Poll error:', err);
      await sleep(begin.interval * 1000);
    }
  }

  onProgress?.('timeout');
  return null;
}

/** Full QR registration flow with progress callbacks */
export async function qrRegister(
  domain: 'feishu' | 'lark' = 'feishu',
  onProgress?: (status: 'begin' | 'scanning' | 'fetchWithTimeouting' | 'polling' | 'success' | 'denied' | 'timeout' | 'error', details?: string) => void
): Promise<QrRegistrationResult | null> {
  try {
    onProgress?.('begin');

    // Step 1: Get QR code URL
    const begin = await qrRegisterBegin(domain);
    if (!begin) {
      onProgress?.('error', 'Failed to start registration');
      return null;
    }

    onProgress?.('scanning');

    // Step 2: Poll until scan completes
    const result = await qrRegisterPoll(begin, domain, (status) => {
      if (status === 'fetchWithTimeouting') onProgress?.('fetchWithTimeouting');
      else if (status === 'polling') onProgress?.('polling');
    });

    if (result) {
      onProgress?.('success');
      return result;
    } else {
      // Check if it was denied or timeout
      onProgress?.('timeout');
      return null;
    }
  } catch (err) {
    console.error('[Feishu QR] Registration error:', err);
    onProgress?.('error', String(err));
    return null;
  }
}

/** Generate a local QR code image (returns base64 PNG) */
export async function generateQrImage(qrUrl: string): Promise<string | null> {
  try {
    // Try to use a QR code library if available
    const QRCode = await import('qrcode').catch(() => null);
    if (QRCode) {
      return QRCode.toDataURL(qrUrl, {
        width: 300,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
      });
    }
  } catch {
    // QRCode library not available
  }

  // Fallback: return the URL (frontend can render it)
  return null;
}

/** Render QR code in terminal (ASCII art) */
export function renderQrTerminal(qrUrl: string): boolean {
  try {
    const QRCode = require('qrcode') as typeof import('qrcode') | undefined;
    if (QRCode) {
      QRCode.toString(qrUrl, { type: 'terminal' }, (err: Error | null | undefined, ascii: string) => {
        if (!err && ascii) {
          console.log('\n' + ascii + '\n');
        }
      });
      return true;
    }
  } catch {
    // qrcode not available
  }
  return false;
}

/** Probe bot info using credentials */
export async function probeBot(
  appId: string,
  appSecret: string,
  domain: 'feishu' | 'lark' = 'feishu'
): Promise<{ bot_name: string; bot_open_id: string } | null> {
  const baseUrl = OPEN_URLS[domain] ?? OPEN_URLS.feishu;

  try {
    // Get access token
    const tokenRes = await fetchWithTimeout(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      timeout: REQUEST_TIMEOUT_MS,
    });

    if (!tokenRes.ok) return null;

    const tokenData = await tokenRes.json() as { tenant_access_token?: string };
    const accessToken = tokenData.tenant_access_token;
    if (!accessToken) return null;

    // Get bot info
    const botRes = await fetchWithTimeout(`${baseUrl}/open-apis/bot/v3/info`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: REQUEST_TIMEOUT_MS,
    });

    if (!botRes.ok) return null;

    const botData = await botRes.json() as { code?: number; bot?: { app_name?: string; open_id?: string } };
    if (botData.code !== 0) return null;

    const bot = botData.bot;
    if (!bot) return null;

    return {
      bot_name: bot.app_name ?? 'Unknown',
      bot_open_id: bot.open_id ?? '',
    };
  } catch (err) {
    console.error('[Feishu QR] Probe bot error:', err);
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Fetch with timeout support */
async function fetchWithTimeout(
  url: string,
  init?: RequestInit & { timeout?: number }
): Promise<Response> {
  const timeout = init?.timeout;
  if (!timeout) {
    return fetch(url, init);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}