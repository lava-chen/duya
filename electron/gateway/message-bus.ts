import { ipcMain } from 'electron';
import * as http from 'http';
import { getLogger, LogComponent } from '../logging/logger';
import { getDatabase } from '../ipc/db-handlers';
import { GatewayInitConfig, GatewayProxyConfig } from './types';
import { startGatewayProcess, stopGatewayProcess, waitForGatewayReady, isGatewayRunning, getGatewayProcess, reloadGatewayProcess } from './lifecycle';
import { GatewaySessionState } from './types';
import { dispatchGatewayDbAction } from './db-bridge';
import { gatewayConfigEvents } from './config-events';
import { createGatewaySessionRecord, updateGatewaySessionMeta } from './session-helpers';

/**
 * Gateway (IM 通道: 飞书/微信/Telegram 等) 创建的 session 使用 permission_profile='auto'
 * (工作区信任模型): 工作区内操作放行, 越界操作走分类器, 灾难性操作恒被拦截.
 * 不读 desktop settings.permissionMode, 避免桌面端用户切 bypass 污染 IM 通道权限.
 * Gateway 自身的权限控制走 IM 平台白名单/配对机制.
 */
const GATEWAY_PERMISSION_PROFILE = 'auto';
import { execSync } from 'child_process';
import { testBridgeChannel } from '../services/network/bridge-tester';
import { getAgentServerPort } from '../agents/agent-server-lifecycle';
import { getDefaultGatewayWorkspace, prepareGatewayWorkspace } from './config';
import { buildGatewayInboundChatRequest } from './inbound-request';
import { getProviderStore } from '../services/providers/provider-store-electron';
import { getConfigStore } from '../config/store-instance';
import { toLegacyApiProvider } from '../../src/lib/providers/legacy';
import type { ChannelAdapterEntry } from '../config/schema';
import { wakeForInbound } from '../wake/channels';
import { botAgentIdFromSession } from '../automation/provider';
import { persistInboundAttachment } from '../channels/attachment-store';
import type { ChannelAddress, ChannelInboundAttachment, ChannelInboundEnvelope } from '../../packages/agent/src/channels/types';
import { isUserAllowed, getChannelAllowlist, addChannelAllowlistEntry, removeChannelAllowlistEntry } from './channel-directory';
import { generateHelpText } from '../../packages/gateway/src/commands/help';
import { interruptCronSession } from '../automation/agent-run';

const GATEWAY_SESSION_KEY = '__gateway_session_states__';

// Cached provider config to avoid DB reads on every gateway:inbound
let _cachedProviderConfig: Record<string, unknown> | null = null;
let _cachedProviderConfigAt = 0;
const PROVIDER_CONFIG_TTL_MS = 30_000;

function getCachedProviderConfig(): Record<string, unknown> | undefined {
  const now = Date.now();
  if (_cachedProviderConfig && (now - _cachedProviderConfigAt) < PROVIDER_CONFIG_TTL_MS) {
    return _cachedProviderConfig;
  }

  const db = getDatabase();
  if (!db) {
    _cachedProviderConfig = null;
    _cachedProviderConfigAt = now;
    return undefined;
  }

  const providerStore = getProviderStore();

  // Fallback to the legacy ConfigManager read when ConfigStore has no
  // active provider (Phase 3 pre-migration transition period).
  const fallbackGetSetting = (key: string): string | undefined => {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    if (row) {
      try { return JSON.parse(row.value); } catch { return row.value; }
    }
    return undefined;
  };

  try {
    const configStore = getConfigStore();

    // Resolve the gateway model setting. It may live in several places and
    // can be either a bare model id ("MiniMax-M3") or a provider-qualified
    // one ("minimax-cn:MiniMax-M3"). Collect every source and prefer the
    // first non-empty value.
    let gatewayModelSetting = configStore.getByPath('channels.gateway_model') as string | undefined;
    if (!gatewayModelSetting) gatewayModelSetting = fallbackGetSetting('gatewayModel');
    if (!gatewayModelSetting) {
      // ModelSelectionSection persists the qualified form under the
      // `modelSelection` JSON key.
      const modelSelection = fallbackGetSetting('modelSelection');
      if (modelSelection) {
        try {
          const parsed = JSON.parse(modelSelection) as { gatewayModel?: unknown };
          if (typeof parsed.gatewayModel === 'string' && parsed.gatewayModel) {
            gatewayModelSetting = parsed.gatewayModel;
          }
        } catch { /* malformed JSON, ignore */ }
      }
    }

    // Split an optional "providerId:modelId" prefix from the bare model id.
    let explicitProviderId: string | undefined;
    let gatewayModel: string | undefined;
    if (gatewayModelSetting) {
      const sep = gatewayModelSetting.indexOf(':');
      if (sep > 0) {
        explicitProviderId = gatewayModelSetting.slice(0, sep);
        gatewayModel = gatewayModelSetting.slice(sep + 1);
      } else {
        gatewayModel = gatewayModelSetting;
      }
    }

    // Resolve the provider: explicit provider id from the qualified model
    // setting > active/default provider > first configured provider. Falling
    // back to the first configured provider keeps the gateway usable even
    // when the user never set a soft default (`model.provider` is empty).
    let provider = explicitProviderId
      ? providerStore.getLlmProvider(explicitProviderId)
      : providerStore.getActiveLlmProvider();
    if (!provider) {
      provider = providerStore.listLlmProviders()[0];
    }

    if (!provider) {
      _cachedProviderConfig = null;
      _cachedProviderConfigAt = now;
      return undefined;
    }

    const apiKey = provider.auth?.apiKey;
    const baseURL = provider.endpoints?.baseUrl;
    const modelFromProvider = (provider.options?.defaultModel as string | undefined) || (provider.options?.model as string | undefined) || '';
    const resolvedModel = gatewayModel || modelFromProvider;
    const providerType = toLegacyApiProvider(provider).providerType;

    if (!providerType || !resolvedModel) {
      _cachedProviderConfig = null;
      _cachedProviderConfigAt = now;
      return undefined;
    }

    _cachedProviderConfig = {
      apiKey,
      baseURL: baseURL || undefined,
      model: resolvedModel,
      provider: providerType,
      authStyle: 'api_key',
    };
  } catch (err) {
    console.error('[Gateway] Failed to get provider config for cache:', err);
    _cachedProviderConfig = null;
  }

  _cachedProviderConfigAt = now;
  return _cachedProviderConfig ?? undefined;
}

export function getSessionStates(): Map<string, GatewaySessionState> {
  const g = globalThis as Record<string, unknown>;
  if (!g[GATEWAY_SESSION_KEY]) {
    g[GATEWAY_SESSION_KEY] = new Map<string, GatewaySessionState>();
  }
  return g[GATEWAY_SESSION_KEY] as Map<string, GatewaySessionState>;
}

export function getSessionState(sessionId: string): GatewaySessionState | undefined {
  return getSessionStates().get(sessionId);
}

const MAX_GATEWAY_TITLE_LENGTH = 50;
const CN_STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '看', '好',
  '这', '他', '她', '它', '们', '那', '什么', '怎么', '如何', '哪个',
  '这个', '那个', '这些', '那些', '可以', '需要', '应该', '能够', '可能',
  '因为', '所以', '但是', '不过', '虽然', '如果', '的话', '而且', '或者',
  '吧', '吗', '呢', '啊', '哦', '嗯', '哈', '呀', '嘛', '呗', '请',
]);

/**
 * Generate a concise session title from the first inbound message.
 * Falls back to the original prompt if it cannot produce a meaningful title.
 */
function generateGatewaySessionTitle(prompt: string, platform: string): string {
  let text = prompt.trim();
  if (!text) return `${platform} chat`;

  // Strip gateway slash commands
  if (text.startsWith('/')) {
    const firstSpace = text.indexOf(' ');
    text = firstSpace > 0 ? text.slice(firstSpace + 1).trim() : '';
  }
  if (!text) return `${platform} chat`;

  // Strip common Chinese request prefixes
  text = text
    .replace(/^(请|帮忙|帮我|能不能|能否|可以|请帮我|能否帮我|我想|我需要|我要|我想问|我想知道|请问|想问一下|想问下)\s*/i, '')
    .replace(/^(please\s+|can\s+you\s+|could\s+you\s+|help\s+me\s+|i\s+want\s+to\s+|i\s+need\s+to\s+|how\s+do\s+i\s+|how\s+to\s+)/i, '');

  text = text.trim();
  if (!text) return `${platform} chat`;

  // Extract first sentence/phrase
  const firstBreak = text.search(/[。！？.;!?\n]/);
  if (firstBreak > 0) {
    text = text.slice(0, firstBreak).trim();
  }

  // For Chinese text, try to extract the most informative clause
  const isChinese = /[\u4e00-\u9fa5]/.test(text);
  if (isChinese && text.length > 12) {
    const segments = text
      .split(/[，、]/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 3);

    if (segments.length > 0) {
      const scored = segments.map((seg) => {
        const chars = [...seg];
        const contentChars = chars.filter((c) => !CN_STOP_WORDS.has(c));
        const ratio = chars.length > 0 ? contentChars.length / chars.length : 0;
        const startsWithContent = contentChars.length > 0 && chars[0] === contentChars[0];
        return { seg, score: ratio * seg.length + (startsWithContent ? 2 : 0) };
      });
      scored.sort((a, b) => b.score - a.score);
      const best = scored[0];
      if (best && best.score > 0) {
        text = best.seg;
      }
    }
  }

  // Truncate with ellipsis
  if (text.length > MAX_GATEWAY_TITLE_LENGTH) {
    text = text.slice(0, MAX_GATEWAY_TITLE_LENGTH);
    const lastSpace = text.lastIndexOf(' ');
    if (!isChinese && lastSpace > 10) {
      text = text.slice(0, lastSpace);
    }
    text = text + '…';
  }

  return text || `${platform} chat`;
}

/**
 * Detect whether a gateway session title is still the fallback generated at
 * session creation ("{platform} {timestamp}", "{platform} Reset {timestamp}",
 * or "{platform} chat"). This protects user-edited titles from being
 * overwritten after a restart.
 */
function isFallbackGatewayTitle(title: string, platform: string): boolean {
  if (!title) return true;
  const lower = title.toLowerCase();
  const prefix = `${platform.toLowerCase()} `;
  if (!lower.startsWith(prefix)) return false;
  const rest = title.slice(prefix.length).trim();
  // Fallback titles are either generic placeholders or contain a timestamp with digits.
  return /^(chat|reset)(\s+|$)/i.test(rest) || /\d/.test(rest);
}

/**
 * Update the thread/chat_sessions title for a gateway session once, using the
 * first inbound message. This is fire-and-forget so it never blocks reply
 * streaming.
 *
 * The function does not rely on in-memory session state: after a Main process
 * restart the state map is empty, but the DB mapping still exists and inbound
 * messages keep arriving. We derive the platform from the inbound message and
 * regenerate the title whenever the stored title is still a fallback.
 */
function maybeUpdateGatewaySessionTitle(sessionId: string, prompt: string, platform: string): void {
  const db = getDatabase();
  if (!db) return;

  try {
    const row = db.prepare('SELECT title FROM threads WHERE id = ?').get(sessionId) as { title: string } | undefined;
    if (row && !isFallbackGatewayTitle(row.title, platform)) {
      const state = getSessionState(sessionId);
      if (state) state.titleGenerated = true;
      return;
    }

    const title = generateGatewaySessionTitle(prompt, platform);
    const now = Date.now();
    // Upsert so the title is persisted even if the threads row is missing.
    db.prepare(`
      INSERT INTO threads (id, title, provider_type, model, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at
    `).run(sessionId, title, 'gateway', '', now, now);
    updateGatewaySessionMeta(sessionId, { title });

    const state = getSessionState(sessionId);
    if (state) state.titleGenerated = true;
    getLogger().debug('Gateway session title generated', { sessionId, title }, LogComponent.Gateway);
  } catch (err) {
    getLogger().warn('Failed to update gateway session title', err instanceof Error ? err.message : String(err), LogComponent.Gateway);
  }
}

export function createOrResetGatewaySession(sessionId: string, channel: string): void {
  const states = getSessionStates();

  if (states.has(sessionId)) {
    const existing = states.get(sessionId)!;
    // Only reset if the session is in an abnormal state; do not disrupt active
    // streams. 'terminating' and 'error' are the only abnormal states in the
    // GatewaySessionState.state union ('starting' | 'running' | 'idle' | 'paused'
    // | 'terminating' | 'error').
    if (existing.state === 'terminating' || existing.state === 'error') {
      getLogger().debug('Gateway session in abnormal state, sending reset', { sessionId, state: existing.state }, LogComponent.Gateway);
    } else {
      // Session already active and healthy; just refresh metadata, don't reset.
      getLogger().debug('Gateway session already active, skip reset', { sessionId, state: existing.state }, LogComponent.Gateway);
      existing.bridgeChannel = channel;
      existing.lastActivityAt = Date.now();
      return;
    }
  }

  states.set(sessionId, {
    sessionId,
    state: 'starting',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    bridgeChannel: channel,
    titleGenerated: false,
  });

  getLogger().info('Gateway session created', { sessionId, channel }, LogComponent.Gateway);
}

export function resetGatewaySession(sessionId: string): void {
  const states = getSessionStates();
  const state = states.get(sessionId);
  if (state) {
    state.state = 'terminating';
  }
  states.delete(sessionId);

  try {
    const db = getDatabase();
    if (db) {
      const now = Date.now();
      db.prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`).run(now, sessionId);
      // Intentionally do NOT delete messages. The messages table is
      // append-only; resetting a gateway session creates a fresh session
      // via the mapping update, but the previous session history must
      // remain visible when the user opens the old session in the UI.
    }
  } catch {
    // best effort
  }

  getLogger().info('Gateway session reset', { sessionId }, LogComponent.Gateway);
}

/**
 * Plan 520: resolve the gateway session for (platform, platformChatId) from
 * the DB mapping, creating the deterministic session + mapping when missing
 * (the old gateway:create_session path, now Main-side only — the gateway's
 * user-mapper is gone).
 */
export function resolveOrCreateGatewaySession(
  platform: string,
  platformChatId: string,
  platformUserId: string,
): string {
  const db = getDatabase();
  if (db) {
    const row = db.prepare(
      'SELECT session_id FROM gateway_user_map WHERE platform = ? AND platform_chat_id = ?'
    ).get(platform, platformChatId) as { session_id?: string } | undefined;
    if (row?.session_id) return row.session_id;
  }

  const sessionId = `gw-${platform}-${platformChatId}`;
  createOrResetGatewaySession(sessionId, platform);

  // Resolve workspace from init config (reads bridge_workspace setting,
  // falls back to ~/.duya/workspace).
  const workingDirectory = prepareGatewayWorkspace(getOrBuildInitConfig());

  if (db) {
    try {
      const now = Date.now();
      const title = `${platform} ${new Date().toLocaleString()}`;
      db.prepare(`
        INSERT INTO threads (id, title, provider_type, model, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
      `).run(sessionId, title, 'gateway', '', now, now);
      createGatewaySessionRecord(sessionId, title, workingDirectory, platform);

      db.prepare(`
        INSERT INTO gateway_user_map (id, platform, platform_user_id, platform_chat_id, session_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(platform, platform_chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at
      `).run(`${platform}:${platformChatId}`, platform, platformUserId, platformChatId, sessionId, now, now);
    } catch (err) {
      getLogger().error('Failed to save gateway session', err instanceof Error ? err : new Error(String(err)), { sessionId }, LogComponent.Gateway);
    }
  }

  return sessionId;
}

/**
 * Plan 520: execute a gateway-detected slash command Main-side and answer
 * through the same channel via requestChannelSend. The gateway only forwards
 * commands present in the shared registry; anything without a Main-side
 * implementation gets an honest "not enabled" reply.
 */
async function handleGatewayCommand(
  command: string,
  args: string[],
  platform: string,
  platformChatId: string,
): Promise<void> {
  const reply = (text: string): void => {
    requestChannelSend(platform, platformChatId, text).catch((err) => {
      getLogger().warn('gateway command reply failed', {
        command,
        error: err instanceof Error ? err.message : String(err),
      }, LogComponent.Gateway);
    });
  };

  try {
    switch (command) {
      case 'help':
        reply(generateHelpText('gateway'));
        return;

      case 'new':
      case 'reset':
      case 'clear': {
        const newSessionId = resetGatewaySessionForChat(platform, platformChatId);
        reply(`✨ Session reset! Starting fresh.\n\nSession: \`${newSessionId}\``);
        return;
      }

      case 'stop': {
        const db = getDatabase();
        const row = db?.prepare(
          'SELECT session_id FROM gateway_user_map WHERE platform = ? AND platform_chat_id = ?'
        ).get(platform, platformChatId) as { session_id?: string } | undefined;
        const sessionId = row?.session_id;
        if (sessionId) {
          try {
            interruptCronSession(sessionId);
          } catch {
            // Best effort: the session may not have an interruptible run.
          }
          reply(`⏹ Stopped the current run for session \`${sessionId}\`.`);
        } else {
          reply('⏹ No active session to stop.');
        }
        return;
      }

      case 'status': {
        const db = getDatabase();
        const row = db?.prepare(
          'SELECT session_id FROM gateway_user_map WHERE platform = ? AND platform_chat_id = ?'
        ).get(platform, platformChatId) as { session_id?: string } | undefined;
        const lines = [
          '*Session Status*',
          '',
          `Platform: ${platform}`,
          `Chat ID: \`${platformChatId}\``,
          `Session: \`${row?.session_id ?? '(no active session)'}\``,
          `Running: ${isGatewayRunning() ? 'Yes' : 'No'}`,
        ];
        reply(lines.join('\n'));
        return;
      }

      default:
        reply(`🚧 \`/${command}\` 尚未在此构建中启用。`);
    }
  } catch (err) {
    reply(`Command failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * /new /reset /clear: reset the mapped session and create a fresh one,
 * repointing the (platform, chatId) mapping (the old gateway:reset_session
 * handler, now Main-side only).
 */
function resetGatewaySessionForChat(platform: string, platformChatId: string): string {
  const db = getDatabase();

  // 1. Find the old session id from the mapping table (source of truth).
  let oldSessionId: string | undefined;
  if (db) {
    const row = db.prepare(
      'SELECT session_id FROM gateway_user_map WHERE platform = ? AND platform_chat_id = ?'
    ).get(platform, platformChatId) as { session_id?: string } | undefined;
    oldSessionId = row?.session_id;
  }

  // 2. Reset the old session's in-memory state. Messages are intentionally
  //    preserved so the old session remains viewable in the UI.
  if (oldSessionId) {
    resetGatewaySession(oldSessionId);
  }

  // 3. Fresh random id guarantees a clean slate (deterministic ids would
  //    reuse the same DB rows and the agent would still see old context).
  const sessionId = `gw-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  createOrResetGatewaySession(sessionId, platform);

  const workingDirectory = prepareGatewayWorkspace(getOrBuildInitConfig());

  if (db) {
    try {
      const now = Date.now();
      const title = `${platform} Reset ${new Date().toLocaleString()}`;
      db.prepare(`
        INSERT INTO threads (id, title, provider_type, model, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at
      `).run(sessionId, title, 'gateway', '', now, now);
      createGatewaySessionRecord(sessionId, title, workingDirectory, platform);
      db.prepare(`
        INSERT INTO gateway_user_map (id, platform, platform_user_id, platform_chat_id, session_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(platform, platform_chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at
      `).run(`${platform}:${platformChatId}`, platform, '', platformChatId, sessionId, now, now);
    } catch (err) {
      getLogger().error('Failed to save gateway reset session', err instanceof Error ? err : new Error(String(err)), { sessionId }, LogComponent.Gateway);
    }
  }

  return sessionId;
}

function handleInboundMessage(msg: Record<string, unknown>): void {
  const sessionId = msg.sessionId as string;
  const payload = msg.data as Record<string, unknown> | undefined;

  if (payload?.action === 'create_session') {
    createOrResetGatewaySession(sessionId, (msg.platform as string) || 'unknown');
    return;
  }

  if (payload?.action === 'reset_session') {
    resetGatewaySession(sessionId);
    return;
  }
}

/**
 * 507 P2.2: persist plain-path inbound attachment refs (gateway route path)
 * to stable storage. Refs come from `options.attachments` on gateway:inbound
 * (built by GatewayManager.forwardInbound); old senders omit the field, so a
 * non-array input yields nothing. Per-attachment failures are reported back
 * as skipped lines so the bot can see them in the wake prompt.
 */
async function persistInboundAttachmentRefs(
  sessionId: string,
  platform: string,
  rawRefs: unknown,
): Promise<{ attachments: ChannelInboundAttachment[]; skippedLines: string[] }> {
  const attachments: ChannelInboundAttachment[] = [];
  const skippedLines: string[] = [];
  if (!Array.isArray(rawRefs)) return { attachments, skippedLines };

  // Resolve the persistence owner the same way the wake path does
  // (wake-run.ts): bot sessions carry the agent id in the session id itself;
  // other sessions fall back to a sanitized session id (path-unsafe chars → '_').
  const ownerId =
    botAgentIdFromSession(sessionId) ?? sessionId.replace(/[^\w.-]+/g, '_');

  for (const raw of rawRefs) {
    const ref = raw as { name?: unknown; path?: unknown };
    if (typeof ref?.path !== 'string' || !ref.path) continue;
    const name = typeof ref.name === 'string' && ref.name ? ref.name : 'file';
    const result = await persistInboundAttachment(
      ownerId,
      platform,
      { kind: 'path', path: ref.path },
      name,
    );
    if (result.attachment) {
      attachments.push(result.attachment);
    } else {
      skippedLines.push(`[attachment skipped: ${result.skippedReason ?? 'unknown reason'}]`);
    }
  }
  return { attachments, skippedLines };
}

export function handleGatewayMessage(
  msg: Record<string, unknown>,
  onAuthFailure: () => void,
): void {
  const type = msg.type as string | undefined;
  const sessionId = msg.sessionId as string | undefined;

  switch (type) {
    case 'log': {
      const level = (msg.level as string) || 'info';
      const message = msg.message as string || '';
      if (level === 'error') {
        getLogger().error(`[gateway] ${message}`, undefined, undefined, LogComponent.Gateway);
      } else {
        getLogger().debug(`[gateway] ${message}`, undefined, LogComponent.Gateway);
      }
      break;
    }

    case 'gateway:ready':
      getLogger().info('Gateway bridge ready', undefined, LogComponent.Gateway);
      console.log('[STARTUP] gateway:ready received');
      break;

    case 'gateway:init:complete':
      getLogger().info('Gateway init complete', { success: msg.success }, LogComponent.Gateway);
      console.log('[STARTUP] gateway:init:complete', msg.success ? 'success' : 'failed', msg.error || '');
      break;

    case 'gateway:error':
      getLogger().error('Gateway error', new Error(`${msg.error}`), undefined, LogComponent.Gateway);
      console.error('[STARTUP] gateway:error', msg.error);
      break;

    case 'db:request': {
      // Handle both direct format (action, payload) and wrapped format
      const msgId = msg.id as string | undefined;
      const rawAction = msg.action;
      const rawType = msg.type as string | undefined;

      // Check if this is a wrapped message (action nested inside)
      let action: string;
      let payload: unknown;
      let actionId: string;

      if (typeof rawAction === 'string') {
        // Direct format: { type: 'db:request', id, action, payload }
        action = rawAction;
        payload = msg.payload;
        actionId = msgId || '';
      } else if (typeof rawAction === 'object' && rawAction !== null) {
        // Wrapped format: { type: 'db:request', id, action: { action, payload } }
        const wrapped = rawAction as { action?: string; type?: string; payload?: unknown; id?: string };
        action = wrapped.action || wrapped.type || '';
        payload = wrapped.payload;
        actionId = wrapped.id || msgId || '';
      } else {
        // Malformed message - try to extract from the message itself
        action = (msg as { action?: string }).action || '';
        payload = (msg as { payload?: unknown }).payload;
        actionId = msgId || '';
      }

      console.log('[Main] db:request received, id:', actionId, 'action:', action || '(none)');

      if (!action) {
        console.warn('[Main] db:request missing action, ignoring malformed message');
        sendToGatewayProcess({
          type: 'db:response',
          id: actionId,
          success: false,
          error: 'Missing action field in db:request',
        });
        break;
      }

      const actionObj = { action, payload } as { type?: string; action?: string; payload?: Record<string, unknown>; id?: string };

      console.log('[Main] db:request payload debug:', {
        action,
        payloadKeys: payload ? Object.keys(payload as object) : 'null/undefined',
        payloadStr: JSON.stringify(payload).slice(0, 200)
      });

      const result = dispatchGatewayDbAction(actionObj);

      console.log('[Main] db:request result:', result ? 'ok' : 'null');

      if (result) {
        sendToGatewayProcess({
          type: 'db:response',
          id: actionId,
          success: !result.error,
          ...result,
        });
      } else {
        sendToGatewayProcess({
          type: 'db:response',
          id: actionId,
          success: false,
          error: 'No handler for action',
        });
      }
      break;
    }

    case 'bridge:session_created':
      if (sessionId) {
        createOrResetGatewaySession(sessionId, (msg.platform as string) || (msg.channel as string) || 'unknown');
      }
      break;

    case 'bridge:session_closed':
      if (sessionId) {
        getSessionStates().delete(sessionId);
      }
      break;

    case 'bridge:message':
    case 'bridge:inbound': {
      if (sessionId) {
        const state = getSessionStates().get(sessionId);
        if (state) {
          state.lastActivityAt = Date.now();
          if (type === 'bridge:inbound') {
            state.state = 'running';
          }
        }
      }
      handleInboundMessage(msg);
      break;
    }

    case 'gateway:inbound': {
      // Plan 520: the gateway no longer resolves sessions (user-mapper
      // removed) and no longer gates senders. Main resolves/creates the
      // session from (platform, platformChatId), enforces the channel
      // allow-list, and replies `gateway:inbound:response` with the verdict
      // (the gateway awaits it and surfaces the unauthorized reply).
      // 488 Plan B behavior is unchanged otherwise: enqueue the inbound wake
      // and return immediately; the dispatcher drain handles it
      // asynchronously via reviveForInbound.
      const inboundMsg = msg as {
        id?: string;
        kind?: 'command' | 'message';
        prompt: string;
        platform: string;
        platformUserId?: string;
        platformMsgId?: string;
        platformChatId: string;
        command?: string;
        args?: string[];
        options?: Record<string, unknown>;
      };

      const platform = inboundMsg.platform;
      const platformChatId = inboundMsg.platformChatId;
      const replyAuthorized = (authorized: boolean): void => {
        if (inboundMsg.id) {
          sendToGatewayProcess({ type: 'gateway:inbound:response', id: inboundMsg.id, authorized });
        }
      };

      // Channel allow-list (channel-directory, plan 520): an empty list for
      // the platform means open — the legacy adapters did their own gating.
      if (!isUserAllowed(platform, inboundMsg.platformUserId ?? '')) {
        getLogger().info('gateway:inbound rejected by allow-list', {
          platform,
          platformChatId,
        }, LogComponent.Gateway);
        replyAuthorized(false);
        break;
      }

      // Command passthrough (plan 520): the gateway detected a known slash
      // command; execute it Main-side and answer through the same channel.
      if (inboundMsg.kind === 'command' && inboundMsg.command) {
        replyAuthorized(true);
        void handleGatewayCommand(inboundMsg.command, inboundMsg.args ?? [], platform, platformChatId);
        break;
      }

      let sessionId: string;
      try {
        sessionId = resolveOrCreateGatewaySession(platform, platformChatId, inboundMsg.platformUserId ?? '');
      } catch (err) {
        getLogger().error(
          'Failed to resolve gateway session for inbound message',
          err instanceof Error ? err : new Error(String(err)),
          { platform, platformChatId },
          LogComponent.Gateway,
        );
        replyAuthorized(false);
        break;
      }

      const port = getAgentServerPort();
      if (!port) {
        getLogger().error('Agent Server not running, cannot enqueue gateway:inbound', undefined, { sessionId }, LogComponent.Gateway);
        replyAuthorized(true);
        break;
      }

      // Generate a meaningful title from the first inbound message (fire-and-forget).
      maybeUpdateGatewaySessionTitle(sessionId, inboundMsg.prompt, platform);

      const providerConfig = getCachedProviderConfig();
      if (providerConfig) {
        console.log('[Main] gateway:inbound: enqueuing, provider:', providerConfig.provider, 'model:', providerConfig.model || '(empty)');
      } else {
        console.warn('[Main] gateway:inbound: no active provider configured');
      }

      // Update gateway session metadata (workspace + permission profile).
      const workingDirectory = prepareGatewayWorkspace(getOrBuildInitConfig());
      try {
        updateGatewaySessionMeta(sessionId, {
          working_directory: workingDirectory,
          permission_profile: GATEWAY_PERMISSION_PROFILE,
        });
      } catch (err) {
        getLogger().warn(
          'Failed to synchronize gateway session workspace',
          { sessionId, error: err instanceof Error ? err.message : String(err) },
          LogComponent.Gateway,
        );
      }

      // 488 Plan B: enqueue the connector.inbound wake via wakeForInbound.
      // wakeForInbound stores the envelope in inboundEnvelopeStore, calls
      // enqueueInboundWake, and calls notifySessionIdle to kick the dispatcher.
      //
      // 507 P2.2: before waking, persist plain-path attachment refs
      // (options.attachments) to stable storage so the wake prompt can point
      // the bot at durable files; skipped entries surface as
      // `[attachment skipped: ...]` lines appended to the envelope text.
      // handleGatewayMessage is synchronous, so the awaited persistence and
      // the wake run in an async IIFE — the message is still never lost if
      // persistence throws (the wake fires without attachments).
      const address: ChannelAddress = {
        platform,
        chat: platformChatId,
      };
      void (async () => {
        let attachments: ChannelInboundAttachment[] = [];
        const skippedLines: string[] = [];
        try {
          const persisted = await persistInboundAttachmentRefs(
            sessionId,
            platform,
            inboundMsg.options?.attachments,
          );
          attachments = persisted.attachments;
          skippedLines.push(...persisted.skippedLines);
        } catch (err) {
          getLogger().warn(
            '[gateway:inbound] attachment persistence failed — waking without attachments',
            { sessionId, error: err instanceof Error ? err.message : String(err) },
            LogComponent.Gateway,
          );
        }

        const text =
          skippedLines.length > 0
            ? [inboundMsg.prompt, ...skippedLines].join('\n')
            : inboundMsg.prompt;

        const envelope: ChannelInboundEnvelope = {
          address,
          sender: 'unknown', // gateway manager doesn't expose sender identity
          text,
          reaction: null,
          attachments: attachments.length > 0 ? attachments : undefined,
        };
        wakeForInbound(sessionId, envelope);

        // Busy broadcast (plan 520): the chat is now busy; forwardToGateway
        // clears it when the terminal chat:done/chat:error is forwarded.
        sendToGatewayProcess({ type: 'gateway:agent_busy', platform, platformChatId, busy: true });

        getLogger().debug('[gateway:inbound] enqueued via wakeForInbound', {
          sessionId,
          platform,
          platformChatId,
          promptLength: text.length,
        }, LogComponent.Gateway);
      })();

      replyAuthorized(true);
      break;
    }

    // 488 P3.2: reaction inbound — when a user reacts to a bot message in a channel
    case 'gateway:reaction': {
      const reactionMsg = msg as {
        sessionId: string;
        platform: string;
        platformChatId: string;
        platformMsgId: string;
        emoji: string;
        userId: string;
        removed?: boolean;
      };

      const logger = getLogger();
      logger.info('[gateway:reaction] enqueuing reaction wake', {
        sessionId: reactionMsg.sessionId,
        platform: reactionMsg.platform,
        platformChatId: reactionMsg.platformChatId,
        platformMsgId: reactionMsg.platformMsgId,
        emoji: reactionMsg.emoji,
        userId: reactionMsg.userId,
        removed: reactionMsg.removed ?? false,
      }, LogComponent.Gateway);

      const address: ChannelAddress = {
        platform: reactionMsg.platform as ChannelAddress['platform'],
        chat: reactionMsg.platformChatId,
      };

      const envelope: ChannelInboundEnvelope = {
        address,
        sender: reactionMsg.userId,
        text: '',
        reaction: {
          emoji: reactionMsg.emoji,
          messageQuote: reactionMsg.platformMsgId,
        },
      };

      wakeForInbound(reactionMsg.sessionId, envelope);
      break;
    }

    case 'bridge:permission':
    case 'bridge:platform_state':
    case 'bridge:status':
      break;

    case 'gateway:getStatus:response': {
      const request = _gatewayStatusRequests.get(msg.id as string);
      if (request) {
        clearTimeout(request.timeout);
        _gatewayStatusRequests.delete(msg.id as string);
        request.resolve(msg.status);
      }
      break;
    }

    case 'gateway:send:response': {
      const request = _channelSendRequests.get(msg.id as string);
      if (request) {
        clearTimeout(request.timeout);
        _channelSendRequests.delete(msg.id as string);
        request.resolve({
          ok: msg.ok === true,
          ...(msg.error !== undefined ? { error: msg.error } : {}),
          ...(msg.platformMsgId !== undefined ? { platformMsgId: msg.platformMsgId } : {}),
        });
      }
      break;
    }

    case 'gateway:feishu:qr:begin:response': {
      console.log('[Main] gateway:feishu:qr:begin:response received, id:', msg.id, 'msg:', JSON.stringify(msg));
      const request = _gatewayStatusRequests.get(msg.id as string);
      if (request) {
        clearTimeout(request.timeout);
        _gatewayStatusRequests.delete(msg.id as string);
        const result = msg.result as Record<string, unknown> | null;
        const error = msg.error as string | undefined;
        request.resolve({ result: result ?? undefined, error });
      } else {
        console.log('[Main] gateway:feishu:qr:begin:response: no pending request for id:', msg.id);
      }
      break;
    }

    case 'gateway:feishu:qr:poll:response': {
      console.log('[Main] gateway:feishu:qr:poll:response received, id:', msg.id, 'msg:', JSON.stringify(msg));
      const request = _gatewayStatusRequests.get(msg.id as string);
      if (request) {
        clearTimeout(request.timeout);
        _gatewayStatusRequests.delete(msg.id as string);
        const result = msg.result as Record<string, unknown> | null;
        const error = msg.error as string | undefined;
        request.resolve({ result: result ?? undefined, error });
      } else {
        console.log('[Main] gateway:feishu:qr:poll:response: no pending request for id:', msg.id);
      }
      break;
    }

    case 'bridge:error': {
      const message = msg.message as string || 'Unknown gateway error';
      getLogger().error(`Gateway bridge error: ${message}`, undefined, { sessionId, error: msg.error }, LogComponent.Gateway);

      if (message.includes('authentication') || message.includes('token expired') || message.includes('Invalid token')) {
        getLogger().warn('Gateway platform authentication failure, will restart gateway', undefined, LogComponent.Gateway);
        onAuthFailure();
      }
      break;
    }

    default:
      getLogger().debug('Unknown gateway message type', { type, sessionId }, LogComponent.Gateway);
      console.log('[STARTUP] Unknown gateway msg:', type, 'sessionId:', sessionId);
      break;
  }
}

function requestGatewayStatus(): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const proc = getGatewayProcess();
      if (!proc || proc.killed) {
        reject(new Error('Gateway not running'));
        return;
      }

      const id = `status-${Date.now()}`;
      const timeout = setTimeout(() => {
        _gatewayStatusRequests.delete(id);
        reject(new Error('Gateway status request timeout'));
      }, 5000);

      _gatewayStatusRequests.set(id, { resolve, reject, timeout });
      proc.send({ type: 'gateway:getStatus', id });
    });
  }

/**
 * Proactively send a plain text message to an IM channel via the gateway
 * subprocess. Resolves with the adapter's send outcome (`{ ok, error?,
 * platformMsgId? }`). Rejects when the gateway is not running or the request
 * times out.
 */
export function requestChannelSend(
  platform: string,
  platformChatId: string,
  text: string,
  filePath?: string,
): Promise<{ ok: boolean; error?: string; platformMsgId?: string }> {
  return new Promise((resolve, reject) => {
    const proc = getGatewayProcess();
    if (!proc || proc.killed) {
      reject(new Error('Gateway not running'));
      return;
    }

    const id = `send-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timeout = setTimeout(() => {
      _channelSendRequests.delete(id);
      reject(new Error('Gateway channel send request timeout'));
    }, 15_000);

    _channelSendRequests.set(id, { resolve, reject, timeout });
    proc.send({ type: 'gateway:send', id, platform, platformChatId, text, ...(filePath ? { filePath } : {}) });
  });
}

// Outbound functions
export function sendToGatewayProcess(data: Record<string, unknown>): void {
  const proc = getGatewayProcess();
  if (proc && !proc.killed) {
    proc.send(data);
  }
}

export function forwardToGateway(sessionId: string, event: Record<string, unknown>): void {
  const proc = getGatewayProcess();
  if (!proc || proc.killed) {
    getLogger().warn('Cannot forward: gateway not running', { sessionId }, LogComponent.Gateway);
    return;
  }

  const states = getSessionStates();
  const sessionInfo = states.get(sessionId);

  // Plan 520: the gateway's user-mapper is gone — resolve platform + chat
  // from the DB mapping (in-memory bridgeChannel stays the platform hint).
  let platform = sessionInfo?.bridgeChannel;
  let platformChatId: string | undefined;
  const db = getDatabase();
  if (db) {
    try {
      const row = db.prepare(
        'SELECT platform, platform_chat_id FROM gateway_user_map WHERE session_id = ? LIMIT 1'
      ).get(sessionId) as { platform?: string; platform_chat_id?: string } | undefined;
      platform = platform ?? row?.platform;
      platformChatId = row?.platform_chat_id;
    } catch { /* best effort */ }
  }

  proc.send({
    type: 'gateway:outbound',
    sessionId,
    platform,
    platformChatId,
    event,
  });

  // Terminal event → clear the busy broadcast (bot-status signal, plan 520).
  const eventType = event.type as string | undefined;
  if ((eventType === 'chat:done' || eventType === 'chat:error') && platform && platformChatId) {
    sendToGatewayProcess({
      type: 'gateway:agent_busy',
      platform,
      platformChatId,
      busy: false,
      ok: eventType !== 'chat:error',
    });
  }
}

export function isGatewaySession(sessionId: string): boolean {
  return getSessionStates().has(sessionId);
}

// IPC handlers
const _gatewayStatusRequests = new Map<string, { resolve: (value: any) => void; reject: (err: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
const _channelSendRequests = new Map<string, { resolve: (value: { ok: boolean; error?: string; platformMsgId?: string }) => void; reject: (err: Error) => void; timeout: ReturnType<typeof setTimeout> }>();

export function getOrBuildInitConfig(): GatewayInitConfig {
  // 注意：不再缓存。每次调用都从 DB 重读，确保 UI 保存新凭据后下一次 start 拿到最新值。
  // 缓存导致过 "配置完 channel 后必须重启 dev 才能生效" 的 bug。

  const platforms: Array<{ platform: string; enabled: boolean; credentials: Record<string, string>; options?: Record<string, unknown> }> = [];

  // New path: read channel adapters from ConfigStore. ConfigStore merges
  // secrets (tokens) back into its snapshot, so credentials are present.
  const configStore = getConfigStore();
  const adapters = configStore.getByPath('channels.adapters') as Record<string, ChannelAdapterEntry> | undefined;

  // ---- WeChat / iLink accounts (ConfigStore path) ----
  const weixinAdapter = adapters?.weixin;
  const weixinAccounts = (weixinAdapter?.accounts as Array<Record<string, unknown>> | undefined) ?? [];
  if (weixinAccounts.length > 0) {
    for (const account of weixinAccounts) {
      const accountId = String(account.account_id ?? '');
      const token =
        (account.token as string | undefined) ||
        (configStore.getByPath(`channels.adapters.weixin.credentials.${accountId}.token`) as string | undefined);
      if (!token?.trim()) {
        console.warn('[Gateway] Skipping weixin account with empty token:', accountId);
        continue;
      }
      platforms.push({
        platform: 'weixin',
        enabled: true,
        credentials: {
          botToken: token,
          ilinkBotId: accountId,
          baseUrl: (account.base_url as string) || 'https://ilinkai.weixin.qq.com',
          cdnBaseUrl: (account.cdn_base_url as string) || 'https://novac2c.cdn.weixin.qq.com/c2c',
        },
      });
    }
  }

  // ---- Telegram (ConfigStore path) ----
  // Hermes-aligned: one platform entry per bot account. The primary account
  // comes from `adapters.telegram.credentials.token`; extra accounts come from
  // the `accounts` array and/or TELEGRAM_BOT_TOKEN_<ACCOUNT> env. Each account
  // gets an isolated session namespace stamped by the adapter.
  const telegramAdapter = adapters?.telegram as Record<string, unknown> | undefined;
  const telegramCredentials = telegramAdapter?.credentials as Record<string, unknown> | undefined;
  const telegramToken = telegramCredentials?.token as string | undefined;
  const telegramOptions = (telegramAdapter?.options as Record<string, unknown> | undefined) ?? {};
  const telegramAccounts = (telegramAdapter?.accounts as Array<Record<string, unknown>> | undefined) ?? [];

  const telegramEntries: Array<{ token: string; account?: string }> = [];
  if (telegramAdapter?.enabled && telegramToken) {
    telegramEntries.push({ token: telegramToken });
  }
  // Env-sourced accounts: TELEGRAM_BOT_TOKEN_<ACCOUNT> (uppercase name).
  for (const [key, val] of Object.entries(process.env)) {
    const m = /^TELEGRAM_BOT_TOKEN_(.+)$/.exec(key);
    if (m && typeof val === 'string' && val.trim()) {
      const account = m[1].toLowerCase();
      if (!telegramEntries.some((e) => e.token === val)) {
        telegramEntries.push({ token: val.trim(), account });
      }
    }
  }
  // Config-sourced accounts: adapters.telegram.accounts[].{name, token}.
  for (const acc of telegramAccounts) {
    const accToken = acc.token as string | undefined;
    const accName = (acc.name as string | undefined) ?? (acc.account as string | undefined);
    if (accToken?.trim() && !telegramEntries.some((e) => e.token === accToken)) {
      telegramEntries.push({ token: accToken.trim(), account: accName });
    }
  }

  for (const entry of telegramEntries) {
    const options: Record<string, unknown> = { ...telegramOptions };
    if (entry.account) options.account = entry.account;
    platforms.push({
      platform: 'telegram',
      enabled: true,
      credentials: { token: entry.token },
      options,
    });
  }

  // ---- QQ (ConfigStore path) ----
  const qq = adapters?.qq as Record<string, unknown> | undefined;
  const qqCredentials = qq?.credentials as Record<string, unknown> | undefined;
  const qqAppId = qq?.app_id as string | undefined;
  const qqAppSecret = qqCredentials?.app_secret as string | undefined;
  if (qq?.enabled && qqAppId && qqAppSecret) {
    platforms.push({
      platform: 'qq',
      enabled: true,
      credentials: { appId: qqAppId, appSecret: qqAppSecret },
    });
  }

  // ---- Feishu (ConfigStore path) ----
  const feishu = adapters?.feishu as Record<string, unknown> | undefined;
  const feishuCredentials = feishu?.credentials as Record<string, unknown> | undefined;
  const feishuAppId = feishu?.app_id as string | undefined;
  const feishuAppSecret = feishuCredentials?.app_secret as string | undefined;
  if (feishu?.enabled && feishuAppId && feishuAppSecret) {
    platforms.push({
      platform: 'feishu',
      enabled: true,
      credentials: { appId: feishuAppId, appSecret: feishuAppSecret },
    });
  }

  // Check auto-start setting
  // autoStart + workspace now read from ConfigStore (channels.*)
  const channels = (getConfigStore().getByPath('channels') ?? {}) as {
    auto_start?: boolean;
    workspace?: string;
    profile_routes?: unknown;
  };
  const autoStart = channels.auto_start === true;
  const workspace = channels.workspace ?? '';
  let workingDirectory: string;
  if (workspace && workspace.trim()) {
    workingDirectory = workspace;
  } else {
    workingDirectory = getDefaultGatewayWorkspace();
  }

  // Load per-channel proxy configuration from ConfigStore
  const proxyRaw = getConfigStore().getByPath('gateway_proxy') as { global_enabled?: boolean; channels?: Record<string, boolean> } | undefined;
  const proxyConfig: GatewayProxyConfig = {
    globalEnabled: proxyRaw?.global_enabled ?? true,
    channels: proxyRaw?.channels ?? {},
  };

  const config: GatewayInitConfig = {
    platforms,
    autoStart,
    proxyConfig,
    workingDirectory,
    // Profile routes: (platform, chatId, threadId) → bot profile. Persisted
    // in ConfigStore under `channels.profile_routes`; the gateway resolves
    // them per inbound message and carries `options.profile` to the worker.
    profileRoutes: channels.profile_routes ?? [],
  };

  console.log('[STARTUP] getOrBuildInitConfig:', JSON.stringify({ platforms: platforms.map(p => ({ platform: p.platform, enabled: p.enabled, hasCredentials: !!Object.keys(p.credentials).length })), autoStart, workingDirectory }));
  return config;
}

export function registerGatewayIpcHandlers(): void {
  // 订阅主进程内的 config-changed 事件：DB 写入完成后触发 gateway 热重启
  // debounce 500ms 以合并快速连续保存（如 BridgeSection 一次保存触发 3 个 updateSetting）
  let reloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  gatewayConfigEvents.onConfigChanged((payload) => {
    if (reloadDebounceTimer) clearTimeout(reloadDebounceTimer);
    reloadDebounceTimer = setTimeout(() => {
      reloadDebounceTimer = null;
      if (!isGatewayRunning()) {
        // gateway 未在跑，不需要 reload（autoStart 由下次启动时读最新值）
        return;
      }
      const config = getOrBuildInitConfig();
      reloadGatewayProcess(config, `config-changed:${payload.source}`).catch(() => {
        // error already logged
      });
    }, 500);
  });

  ipcMain.handle('gateway:start', async () => {
    try {
      const config = getOrBuildInitConfig();
      console.log('[STARTUP] gateway:start called, platforms count:', config.platforms.length);
      const child = startGatewayProcess(config);

      child.on('message', (msg: Record<string, unknown>) => {
        handleGatewayMessage(msg, () => {
          // auth-failure 回调：热重启时用最新 config
          const fresh = getOrBuildInitConfig();
          reloadGatewayProcess(fresh, 'auth-failure').catch(() => { /* error already logged */ });
        });
      });

      try {
        await waitForGatewayReady(config, child, 30_000);
        child.send({ type: 'init', config });
        console.log('[STARTUP] UI gateway:start sent init');
        return { success: true };
      } catch (err) {
        getLogger().error('Gateway startup timeout', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Gateway);
        return { success: false, error: 'Gateway startup timeout' };
      }
    } catch (err) {
      getLogger().error('Failed to start gateway', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Gateway);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('gateway:stop', async () => {
    await stopGatewayProcess();
    const states = getSessionStates();
    states.clear();
    return { success: true };
  });

  ipcMain.handle('gateway:reload', async () => {
    try {
      // The renderer (BridgeSection.updateSetting) saves a gateway config key via
      // db:setting:set (which schedules a 500ms config-changed reload) and then
      // immediately invokes gateway:reload. Without cancelling the pending timer
      // here, two reloads race: the second SIGTERMs the process the first just
      // started, leaving the gateway disconnected until a manual restart. The
      // explicit reload below already reads the latest config, so cancelling the
      // debounced one is safe.
      if (reloadDebounceTimer) {
        clearTimeout(reloadDebounceTimer);
        reloadDebounceTimer = null;
      }

      const states = getSessionStates();
      states.clear();
      const config = getOrBuildInitConfig();
      // reloadGatewayProcess 内部已经 stop → start，调用方不用自己做
      await reloadGatewayProcess(config, 'ipc:gateway:reload');
      // 注意：reloadGatewayProcess 不等待 child 真正 init 完成（它只保证 stop→start）
      // 等待 ready 是 IPC 调用方的语义，所以这里再 wait
      const child = getGatewayProcess();
      if (child) {
        await waitForGatewayReady(config, child, 30_000).catch((err) => {
          getLogger().error('Gateway reload wait-for-ready failed', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Gateway);
        });
      }
      return { success: true };
    } catch (err) {
      getLogger().error('Gateway reload failed', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Gateway);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('gateway:testChannel', async (_event, channel: string) => {
    return await testBridgeChannel(channel);
  });

  ipcMain.handle('gateway:status', async () => {
    return {
      running: isGatewayRunning(),
      sessions: Array.from(getSessionStates().values()),
    };
  });

  // Plan 520: allow-list replaces the pairing system. Managed by Main via
  // channel-directory; the gateway only transparently forwards sender ids.
  ipcMain.handle('gateway:allowlist:list', () => {
    return getChannelAllowlist();
  });

  ipcMain.handle('gateway:allowlist:add', (_event, platform: string, platformUserId: string) => {
    addChannelAllowlistEntry(platform, platformUserId);
    return { success: true };
  });

  ipcMain.handle('gateway:allowlist:remove', (_event, platform: string, platformUserId: string) => {
    removeChannelAllowlistEntry(platform, platformUserId);
    return { success: true };
  });

  ipcMain.handle('gateway:getStatus', async () => {
    let autoStart = false;
    try {
      const db = getDatabase();
      if (db) {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'bridge_auto_start'").get() as { value: string } | undefined;
        autoStart = row?.value === 'true';
      }
    } catch { /* best effort */ }

    const running = isGatewayRunning();
    let adapters: Array<Record<string, unknown>> = [];

    if (running) {
      try {
        const status = await Promise.race([
          requestGatewayStatus(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Gateway status timeout')), 2000)
          ),
        ]);
        adapters = (status.adapters as Array<Record<string, unknown>>) || [];
      } catch { /* best effort */ }
    }

    return {
      running,
      adapters,
      autoStart,
      _orphaned: false,
    };
  });

  ipcMain.handle('gateway:feishu:qr:begin', async (_event, _domain?: string) => {
    const proc = getGatewayProcess();
    console.log('[Main] gateway:feishu:qr:begin called, proc:', proc ? 'exists' : 'null', proc?.killed ? 'killed' : 'running');
    if (!proc || proc.killed) {
      console.log('[Main] gateway:feishu:qr:begin: Gateway not running');
      return { success: false, error: 'Gateway not running' };
    }
    return new Promise((resolve) => {
      const id = `feishu-qr-begin-${Date.now()}`;
      console.log('[Main] gateway:feishu:qr:begin: sending message with id:', id);
      const timeout = setTimeout(() => {
        _gatewayStatusRequests.delete(id);
        console.log('[Main] gateway:feishu:qr:begin: timeout for id:', id);
        resolve({ success: false, error: 'Gateway QR begin timeout' });
      }, 15000);
      _gatewayStatusRequests.set(id, {
        resolve: (value: unknown) => {
          clearTimeout(timeout);
          _gatewayStatusRequests.delete(id);
          console.log('[Main] gateway:feishu:qr:begin: resolved for id:', id, value);
          const v = value as { result?: Record<string, unknown>; error?: string };
          if (v.error) {
            resolve({ success: false, error: v.error });
          } else if (v.result) {
            resolve({ success: true, ...v.result });
          } else {
            resolve({ success: false, error: 'Unknown error' });
          }
        },
        reject: (err) => {
          clearTimeout(timeout);
          _gatewayStatusRequests.delete(id);
          console.log('[Main] gateway:feishu:qr:begin: rejected for id:', id, err.message);
          resolve({ success: false, error: err.message });
        },
        timeout,
      } as { resolve: (value: unknown) => void; reject: (err: Error) => void; timeout: ReturnType<typeof setTimeout> });
      proc.send({ type: 'gateway:feishu:qr:begin', id, domain: _domain || 'feishu' });
      console.log('[Main] gateway:feishu:qr:begin: message sent to gateway');
    });
  });

  ipcMain.handle('gateway:feishu:qr:poll', async (_event, begin: { device_code: string; interval: number; expire_in: number }, _domain?: string) => {
    const proc = getGatewayProcess();
    if (!proc || proc.killed) {
      return { success: false, error: 'Gateway not running' };
    }
    return new Promise((resolve) => {
      const id = `feishu-qr-poll-${Date.now()}`;
      const timeout = setTimeout(() => {
        _gatewayStatusRequests.delete(id);
        resolve({ success: false, error: 'Gateway QR poll timeout' });
      }, 300000);
      _gatewayStatusRequests.set(id, {
        resolve: (value: unknown) => {
          clearTimeout(timeout);
          _gatewayStatusRequests.delete(id);
          const v = value as { result?: Record<string, unknown>; error?: string };
          if (v.error) {
            resolve({ success: false, error: v.error });
          } else if (v.result) {
            resolve({ success: true, ...v.result });
          } else {
            resolve({ success: false, error: 'Unknown error' });
          }
        },
        reject: (err) => {
          clearTimeout(timeout);
          _gatewayStatusRequests.delete(id);
          resolve({ success: false, error: err.message });
        },
        timeout,
      } as { resolve: (value: unknown) => void; reject: (err: Error) => void; timeout: ReturnType<typeof setTimeout> });
      proc.send({ type: 'gateway:feishu:qr:poll', id, begin, domain: _domain || 'feishu' });
    });
  });

  ipcMain.handle('gateway:is_gateway_session', (_event, sessionId: string) => {
    return isGatewaySession(sessionId);
  });

  ipcMain.handle('gateway:listSessions', () => {
    const db = getDatabase();

    // Get all gateway sessions from database
    // Gateway sessions have 'gw-' prefix in their id
    const sessions: Array<{
      id: string;
      title: string;
      platform: string;
      platformUserId: string;
      platformChatId: string;
      createdAt: number;
      updatedAt: number;
    }> = [];

    if (db) {
      try {
        // Query all gateway sessions (id starts with 'gw-')
        const rows = db.prepare(`
          SELECT id, title, created_at, updated_at
          FROM threads
          WHERE id LIKE 'gw-%'
          ORDER BY updated_at DESC
        `).all() as Array<{
          id: string;
          title: string;
          created_at: number;
          updated_at: number;
        }>;

        for (const row of rows) {
          // Try to get platform info from gateway_user_map
          const mapping = db.prepare(`
            SELECT platform, platform_user_id, platform_chat_id
            FROM gateway_user_map
            WHERE session_id = ?
          `).get(row.id) as {
            platform?: string;
            platform_user_id?: string;
            platform_chat_id?: string;
          } | undefined;

          // Extract platform from title if no mapping exists
          // Title format: "{platform} {timestamp}" or "{platform} Reset {timestamp}"
          let platform = mapping?.platform || 'unknown';
          if (platform === 'unknown' && row.title) {
            const titleParts = row.title.split(' ');
            if (titleParts.length > 0 && titleParts[0]) {
              platform = titleParts[0].toLowerCase();
            }
          }

          sessions.push({
            id: row.id,
            title: row.title || '',
            platform,
            platformUserId: mapping?.platform_user_id || '',
            platformChatId: mapping?.platform_chat_id || '',
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          });
        }
      } catch (err) {
        getLogger().error('Failed to list gateway sessions', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Gateway);
      }
    }

    return sessions;
  });

  ipcMain.handle('gateway:getSession', (_event, sessionId: string) => {
    const state = getSessionState(sessionId);
    if (!state) return null;

    const db = getDatabase();
    let title = '';

    if (db) {
      try {
        const row = db.prepare('SELECT title FROM threads WHERE id = ?').get(sessionId) as { title: string } | undefined;
        title = row?.title || '';
      } catch { /* best effort */ }
    }

    return {
      id: state.sessionId,
      title,
      platform: state.bridgeChannel || 'unknown',
      platformUserId: '',
      platformChatId: state.sessionId,
      createdAt: state.createdAt,
      updatedAt: state.lastActivityAt,
    };
  });

  ipcMain.handle('gateway:getProxyStatus', async () => {
    function detectWindowsSystemProxy(): string | undefined {
      if (process.platform !== 'win32') return undefined;
      try {
        const enableOutput = execSync(
          'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
          { encoding: 'utf-8', timeout: 3000 }
        );
        if (!enableOutput.match(/ProxyEnable\s+REG_DWORD\s+(0x1|1)/)) return undefined;

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
      } catch { /* ignore */ }
      return undefined;
    }

    const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy
      || process.env.HTTP_PROXY || process.env.http_proxy
      || process.env.ALL_PROXY || process.env.all_proxy;
    const systemProxy = detectWindowsSystemProxy();

    return {
      success: true,
      status: {
        configured: undefined,
        env: envProxy,
        system: systemProxy,
        effective: envProxy || systemProxy || undefined,
      },
    };
  });

  ipcMain.handle('gateway:get_config', () => {
    const db = getDatabase();
    if (!db) return {};

    const getSetting = (key: string): string | undefined => {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
      if (row) {
        try { return JSON.parse(row.value); } catch { return row.value; }
      }
      return undefined;
    };

    return {
      telegramToken: getSetting('telegram_bot_token'),
      qqAppId: getSetting('bridge_qq_app_id'),
      qqAppSecret: getSetting('bridge_qq_app_secret'),
      feishuAppId: getSetting('bridge_feishu_app_id'),
      feishuAppSecret: getSetting('bridge_feishu_app_secret'),
      weixinToken: getSetting('weixin_bot_token'),
      weixinAccountId: getSetting('weixin_account_id'),
      weixinBaseUrl: getSetting('weixin_base_url'),
    };
  });

  getLogger().info('Registered gateway IPC handlers', undefined, LogComponent.Gateway);
}

export async function startGateway(): Promise<void> {
  console.log('[STARTUP] startGateway() called');
  const config = getOrBuildInitConfig();
  const child = startGatewayProcess(config);

  child.on('message', (msg: Record<string, unknown>) => {
    handleGatewayMessage(msg, () => {
      // auth-failure 回调：热重启时用最新 config
      const fresh = getOrBuildInitConfig();
      reloadGatewayProcess(fresh, 'auth-failure:auto-start').catch(() => { /* error already logged */ });
    });
  });

  try {
    await waitForGatewayReady(config, child, 30000);
    console.log('[STARTUP] Gateway ready, sending init...');
    child.send({ type: 'init', config });
  } catch (err) {
    getLogger().error('Gateway auto-start timeout', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Gateway);
    console.error('[STARTUP] Gateway auto-start failed:', err);
  }
}
