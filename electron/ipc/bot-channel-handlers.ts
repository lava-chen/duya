/**
 * bot-channel-handlers.ts — renderer IPC for per-bot channel bindings
 * (plan 488 grok-form: each bot owns its platform connection).
 *
 * A binding lives in `agents/<agentId>/channels/<platform>/connection.json`
 * with its token in `agents/<agentId>/connector-secrets/<platform>.json`.
 * A live inbound connector (connector-runtime) long-polls the platform with
 * that token and wakes the bot's persistent session (`bot:<agentId>`) on
 * every inbound message. Credentials are accepted from the renderer or the
 * CLI endpoint and never returned to any caller.
 */

import { ipcMain } from 'electron';
import QRCode from 'qrcode';

import { getLogger, LogComponent } from '../logging/logger';
import { getLiveConfigAgent } from '../config/agents';
import {
  disconnectChannel,
  listAgentChannels,
  storeConnectorCredential,
} from '../channels/agent-session-channels';
import { openChannelStore } from '../channels/channel-store';
import { getBotConnectorManager } from '../channels/connector-runtime';
import {
  CONNECTOR_MANIFESTS,
  manifestCredentialFields,
} from '../../packages/agent/src/channels/types';
import {
  qrRegisterBegin,
  qrRegisterPoll,
} from '../channels/gateway-adapters';
import type { QrPollInput } from '../channels/gateway-adapters';
import {
  startWeixinQrLogin,
  pollWeixinQrStatus,
  cancelWeixinQrSession,
  getWeixinQrCredentials,
} from '../services/network/wechat-qr';

function findManifest(platform: string) {
  return CONNECTOR_MANIFESTS.find((m) => m.platform === platform) ?? null;
}

/**
 * Write a bot's channel credentials + metadata and bring the live connector
 * up. Shared by the token-paste connect flow and the QR connect flow.
 * Non-empty fields are stored; empty optional fields (e.g. weixin baseUrl)
 * are skipped.
 */
function bindChannel(
  agentId: string,
  platform: string,
  fields: Record<string, string>,
  label: string,
): void {
  for (const [field, value] of Object.entries(fields)) {
    if (value) storeConnectorCredential(agentId, platform, field, value);
  }
  const manifest = findManifest(platform);
  openChannelStore(agentId).writeMetadata(platform, label || manifest?.displayName || platform);
  getBotConnectorManager().sync();
  getLogger().info('Bot channel bound', { agentId, platform }, LogComponent.Gateway);
}

// Per-bot Feishu QR sessions (begin metadata), keyed by sessionId. Weixin QR
// sessions live inside the wechat-qr service.
interface FeishuQrSession {
  agentId: string;
  label: string;
  begin: QrPollInput;
  domain: 'feishu' | 'lark';
}
const feishuQrSessions = new Map<string, FeishuQrSession>();

/**
 * Bots are registered in the config store (`config:agents:*`, plan 485's
 * `agents/<agentId>/` layout) — NOT the legacy `agent_profiles` table.
 */
function agentExists(agentId: string): boolean {
  return getLiveConfigAgent(agentId) !== undefined;
}

export function registerBotChannelHandlers(): void {
  const logger = getLogger();

  ipcMain.handle('botChannels:manifests', () => {
    return { manifests: CONNECTOR_MANIFESTS };
  });

  ipcMain.handle('botChannels:list', (_event, agentId: string) => {
    if (typeof agentId !== 'string' || !agentId.trim()) {
      return { error: 'invalid_agent' };
    }
    if (!agentExists(agentId)) {
      return { error: 'agent_not_found' };
    }
    return { channels: listAgentChannels(agentId) };
  });

  ipcMain.handle(
    'botChannels:connect',
    (
      _event,
      agentId: string,
      input: {
        platform?: unknown;
        label?: unknown;
        credential?: unknown;
        credentials?: unknown;
      },
    ) => {
      const platform = typeof input?.platform === 'string' ? input.platform : '';
      const label = typeof input?.label === 'string' ? input.label.trim() : '';

      if (typeof agentId !== 'string' || !agentId.trim()) {
        return { ok: false, error: 'invalid_agent' };
      }
      if (!agentExists(agentId)) {
        return { ok: false, error: 'agent_not_found' };
      }
      const manifest = findManifest(platform);
      if (!manifest) {
        return { ok: false, error: 'unknown_platform' };
      }
      if (manifest.availability !== 'available') {
        return { ok: false, error: 'platform_unavailable' };
      }

      // Resolve per-field credentials. Callers may pass a full `credentials`
      // map (multi-field platforms such as feishu/weixin) or a legacy single
      // `credential` string (token-only platforms, CLI path).
      const fields = manifestCredentialFields(manifest);
      const provided =
        input?.credentials &&
        typeof input.credentials === 'object' &&
        !Array.isArray(input.credentials)
          ? (input.credentials as Record<string, unknown>)
          : null;
      const legacySingular =
        typeof input?.credential === 'string' ? input.credential.trim() : '';
      const credentialMap: Record<string, string> = {};
      let anyRequiredFilled = false;
      for (const f of fields) {
        let value = '';
        if (provided && typeof provided[f.field] === 'string') {
          value = (provided[f.field] as string).trim();
        } else if (fields.length === 1) {
          // Legacy single-credential call → map onto the only required field.
          value = legacySingular;
        }
        if (value) {
          credentialMap[f.field] = value;
          if (f.required !== false) anyRequiredFilled = true;
        }
      }
      if (!anyRequiredFilled || Object.keys(credentialMap).length === 0) {
        return { ok: false, error: 'missing_credential' };
      }

      try {
        bindChannel(agentId, platform, credentialMap, label);
        logger.info('Bot channel connected', { agentId, platform }, LogComponent.Gateway);
        return { ok: true, platform };
      } catch (err) {
        logger.error(
          'Bot channel connect failed',
          err instanceof Error ? err : new Error(String(err)),
          { agentId, platform },
          LogComponent.Gateway,
        );
        return { ok: false, error: 'store_failed' };
      }
    },
  );

  ipcMain.handle('botChannels:disconnect', (_event, agentId: string, platform: string) => {
    if (typeof agentId !== 'string' || !agentId.trim()) {
      return { ok: false, error: 'invalid_agent' };
    }
    if (typeof platform !== 'string' || !findManifest(platform)) {
      return { ok: false, error: 'unknown_platform' };
    }
    if (!agentExists(agentId)) {
      return { ok: false, error: 'agent_not_found' };
    }
    try {
      disconnectChannel(agentId, platform);
      getBotConnectorManager().sync();
      logger.info('Bot channel disconnected', { agentId, platform }, LogComponent.Gateway);
      return { ok: true, platform };
    } catch (err) {
      logger.error(
        'Bot channel disconnect failed',
        err instanceof Error ? err : new Error(String(err)),
        { agentId, platform },
        LogComponent.Gateway,
      );
      return { ok: false, error: 'store_failed' };
    }
  });

  // ---- QR connect flow (feishu / weixin) ----

  // Begin: return a session id + QR image (data URL) for the renderer to show.
  ipcMain.handle(
    'botChannels:qr:begin',
    async (_event, agentId: unknown, platform: unknown, opts: { label?: unknown } = {}) => {
      if (typeof agentId !== 'string' || !agentId.trim()) {
        return { ok: false, error: 'invalid_agent' };
      }
      if (!agentExists(agentId)) {
        return { ok: false, error: 'agent_not_found' };
      }
      const label = typeof opts?.label === 'string' ? opts.label.trim() : '';
      if (platform === 'feishu') {
        try {
          const begin = await qrRegisterBegin('feishu');
          if (!begin?.qr_url) {
            return { ok: false, error: 'qr_begin_failed' };
          }
          const qrImage = await QRCode.toDataURL(begin.qr_url, { width: 256, margin: 2 });
          const sessionId = `fsqr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          feishuQrSessions.set(sessionId, {
            agentId,
            label,
            begin: { device_code: begin.device_code, interval: begin.interval, expire_in: begin.expire_in },
            domain: 'feishu',
          });
          setTimeout(() => feishuQrSessions.delete(sessionId), 60_000);
          return { ok: true, sessionId, qrImage };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : 'qr_begin_failed',
          };
        }
      }
      if (platform === 'weixin') {
        try {
          const result = await startWeixinQrLogin();
          weixinQrOwners.set(result.sessionId, { agentId, label });
          setTimeout(() => weixinQrOwners.delete(result.sessionId), 60_000);
          return { ok: true, sessionId: result.sessionId, qrImage: result.qrImage };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : 'qr_begin_failed',
          };
        }
      }
      return { ok: false, error: 'unknown_platform' };
    },
  );

  // Poll: returns the current status; on success the credential is persisted
  // and the live connector is started, then status becomes "bound".
  ipcMain.handle('botChannels:qr:poll', async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, error: 'invalid_session' };
    }
    const fsSession = feishuQrSessions.get(sessionId);
    if (fsSession) {
      try {
        const result = await qrRegisterPoll(fsSession.begin, fsSession.domain);
        if (result?.app_id && result?.app_secret) {
          bindChannel(
            fsSession.agentId,
            'feishu',
            { appId: result.app_id, appSecret: result.app_secret },
            fsSession.label,
          );
          feishuQrSessions.delete(sessionId);
          return { ok: true, status: 'bound' };
        }
        return { ok: true, status: 'waiting' };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'qr_poll_failed' };
      }
    }

    // Weixin sessions are tracked by the wechat-qr service.
    try {
      const session = await pollWeixinQrStatus(sessionId);
      switch (session.status) {
        case 'waiting':
        case 'scanned':
          return { ok: true, status: session.status };
        case 'confirmed': {
          const creds = getWeixinQrCredentials(sessionId);
          // The wechat-qr service does not carry the bot's agentId; the caller
          // here is renderer's QR flow, which started with the agent bound to
          // this session via begin() — recover it from the session key.
          const owner = weixinQrOwners.get(sessionId);
          if (creds && owner) {
            bindChannel(owner.agentId, 'weixin', {
              botToken: creds.token,
              ilinkBotId: creds.ilinkBotId,
              baseUrl: creds.baseUrl,
            }, owner.label);
            return { ok: true, status: 'bound' };
          }
          return { ok: false, error: 'confirmed_missing_credentials' };
        }
        case 'expired':
        case 'failed':
          return { ok: true, status: 'failed', error: session.error };
        default:
          return { ok: true, status: 'waiting' };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'qr_poll_failed' };
    }
  });

  // Cancel an in-flight QR session.
  ipcMain.handle('botChannels:qr:cancel', async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, error: 'invalid_session' };
    }
    feishuQrSessions.delete(sessionId);
    weixinQrOwners.delete(sessionId);
    cancelWeixinQrSession(sessionId);
    return { ok: true };
  });
}

// Map a Weixin QR session id back to the bot (agentId + label) so the poll
// handler can bind on confirm. Feishu sessions carry their own owner.
const weixinQrOwners = new Map<string, { agentId: string; label: string }>();
