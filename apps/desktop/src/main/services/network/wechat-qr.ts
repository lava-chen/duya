import QRCode from 'qrcode';
import { getLogger, LogComponent } from '../../logging/logger';
import { upsertWeixinAccount } from '../weixin-account-store';

const QR_LOGIN_BASE_URL = 'https://ilinkai.weixin.qq.com';
const QR_API_TIMEOUT_MS = 15_000;
const QR_POLL_TIMEOUT_MS = 40_000;
const QR_TTL_MS = 5 * 60_000;
const MAX_REFRESHES = 3;

export interface QrLoginSession {
  qrcode: string;
  qrImage: string;
  startedAt: number;
  refreshCount: number;
  status: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'failed';
  accountId?: string;
  /** Captured on confirm — the per-bot connector needs these to bind this
   * WeChat account to a bot (written to the connector-secret store). */
  token?: string;
  ilinkBotId?: string;
  baseUrl?: string;
  error?: string;
}

/**
 * Return the confirmed credentials (token / ilink bot id / base URL) for a QR
 * login session, or null if it has not been confirmed (or does not exist).
 * Used by the per-bot channel binding flow so a confirmed scan can be written
 * into the bot's connector-secret store — the global `upsertWeixinAccount`
 * side effect stays untouched.
 */
export function getWeixinQrCredentials(
  sessionId: string,
): { token: string; ilinkBotId: string; baseUrl: string } | null {
  const session = getLoginSessions().get(sessionId);
  if (!session || session.status !== 'confirmed' || !session.token) return null;
  return {
    token: session.token,
    ilinkBotId: session.ilinkBotId ?? '',
    baseUrl: session.baseUrl ?? '',
  };
}

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

  if (Date.now() - session.startedAt > QR_TTL_MS) {
    if (session.refreshCount >= MAX_REFRESHES) {
      session.status = 'failed';
      session.error = 'QR code expired after maximum refreshes';
      return session;
    }

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
          // Capture the raw credentials so per-bot binding can persist them.
          session.token = resp.bot_token;
          session.ilinkBotId = resp.ilink_bot_id;
          session.baseUrl = resp.baseurl || '';

          getLogger().info(
            '[WeixinQrLogin] Login confirmed by WeChat server',
            { accountId, userId, hasToken: true, baseUrl: resp.baseurl || 'default' },
            LogComponent.NetHandlers
          );

          upsertWeixinAccount({
            accountId,
            userId,
            name: accountId,
            baseUrl: resp.baseurl || '',
            cdnBaseUrl: '',
            token: resp.bot_token,
            enabled: true,
          });

          getLogger().info('[WeixinQrLogin] Saved to ConfigStore', { accountId, enabled: true }, LogComponent.NetHandlers);
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
        session.startedAt = 0;
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