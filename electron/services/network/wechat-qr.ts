import QRCode from 'qrcode';
import { getDatabase } from '../../ipc/db-handlers';
import { getLogger, LogComponent } from '../../logging/logger';

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
  error?: string;
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

          getLogger().info(
            '[WeixinQrLogin] Login confirmed by WeChat server',
            { accountId, userId, hasToken: true, baseUrl: resp.baseurl || 'default' },
            LogComponent.NetHandlers
          );

          const db = getDatabase();
          if (db) {
            const now = Date.now();

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

            getLogger().info('[WeixinQrLogin] Saved to settings table', { accountId }, LogComponent.NetHandlers);

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
              1,
              now,
              now
            );

            getLogger().info('[WeixinQrLogin] Saved to weixin_accounts table', { accountId, enabled: true }, LogComponent.NetHandlers);
          } else {
            getLogger().warn('[WeixinQrLogin] Database not available, cannot persist account', { accountId }, LogComponent.NetHandlers);
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