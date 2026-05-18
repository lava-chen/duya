import { getDatabase } from '../../ipc/db-handlers';
import { proxyRequest } from '../proxy';
import { getLogger, LogComponent } from '../../logging/logger';

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
      const db2 = getDatabase();
      if (db2) {
        const accountRow = db2.prepare(
          'SELECT account_id, user_id, token, base_url FROM weixin_accounts WHERE enabled = 1 ORDER BY last_login_at DESC LIMIT 1'
        ).get() as { account_id: string; user_id: string; token: string; base_url: string } | undefined;

        if (accountRow?.token) {
          getLogger().info(
            '[WeixinTest] Testing account from weixin_accounts',
            { accountId: accountRow.account_id, userId: accountRow.user_id },
            LogComponent.NetHandlers
          );

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
              signal: AbortSignal.timeout(5_000),
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
          const tokenRow = db2.prepare("SELECT value FROM settings WHERE key = 'weixin_bot_token'").get() as { value: string } | undefined;
          if (tokenRow?.value) {
            getLogger().warn(
              '[WeixinTest] No enabled account in weixin_accounts, falling back to settings',
              undefined,
              LogComponent.NetHandlers
            );
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