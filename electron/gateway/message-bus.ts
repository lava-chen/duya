import { ipcMain } from 'electron';
import * as http from 'http';
import { getLogger, LogComponent } from '../logging/logger';
import { getDatabase } from '../ipc/db-handlers';
import { GatewayInitConfig, GatewayProxyConfig } from './types';
import { startGatewayProcess, stopGatewayProcess, waitForGatewayReady, isGatewayRunning, getGatewayProcess, reloadGatewayProcess } from './lifecycle';
import { GatewaySessionState } from './types';
import { dispatchGatewayDbAction } from './db-bridge';
import { gatewayConfigEvents } from './config-events';

/**
 * Gateway (IM 通道: 飞书/微信/Telegram 等) 创建的 session 固定 permission_profile='default'.
 * 不读 desktop settings.permissionMode, 避免桌面端用户切 bypass 污染 IM 通道权限.
 * Gateway 自身的权限控制走 IM 平台白名单/配对机制.
 */
const GATEWAY_PERMISSION_PROFILE = 'default';
import { execSync } from 'child_process';
import { testBridgeChannel } from '../services/network/bridge-tester';
import { getPairingStore } from './pairing';
import { getAgentServerPort } from '../agents/agent-server-lifecycle';
import { getGatewayProxyConfig } from '../db/queries/settings';
import { getDefaultGatewayWorkspace, prepareGatewayWorkspace } from './config';
import { buildGatewayInboundChatRequest } from './inbound-request';

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

  try {
    const { getConfigManager } = require('../config/manager');
    const configManager = getConfigManager();
    const activeProvider = configManager?.getActiveProvider();

    const getSetting = (key: string): string | undefined => {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
      if (row) {
        try { return JSON.parse(row.value); } catch { return row.value; }
      }
      return undefined;
    };

    const gatewayModelSetting = getSetting('gatewayModel');
    const modelFromProvider = activeProvider?.options?.defaultModel || activeProvider?.options?.model || '';
    const resolvedModel = gatewayModelSetting || modelFromProvider;

    if (activeProvider) {
      _cachedProviderConfig = {
        apiKey: activeProvider.apiKey,
        baseURL: activeProvider.baseUrl || undefined,
        model: resolvedModel,
        provider: activeProvider.providerType,
        authStyle: 'api_key',
      };
    } else {
      _cachedProviderConfig = null;
    }
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
    db.prepare(`UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?`).run(title, now, sessionId);

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
      sendToGatewayProcess({ type: 'reset', sessionId });
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

  sendToGatewayProcess({ type: 'reset', sessionId });

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
      // Forward inbound message from Gateway to Agent Server and receive SSE stream
      const inboundMsg = msg as {
        sessionId: string;
        prompt: string;
        platform: string;
        platformMsgId: string;
        platformChatId: string;
        options?: Record<string, unknown>;
      };

      const port = getAgentServerPort();
      if (!port) {
        getLogger().error('Agent Server not running, cannot forward gateway:inbound', undefined, { sessionId: inboundMsg.sessionId }, LogComponent.Gateway);
        break;
      }

      const sessionId = inboundMsg.sessionId;
      const platform = inboundMsg.platform;
      const platformChatId = inboundMsg.platformChatId;

      // Generate a meaningful title from the first inbound message.
      // This is fire-and-forget and must not block the SSE forwarding below.
      maybeUpdateGatewaySessionTitle(sessionId, inboundMsg.prompt, platform);

      const providerConfig = getCachedProviderConfig();
      if (providerConfig) {
        console.log('[Main] gateway:inbound: using cached provider config, provider:', providerConfig.provider, 'model:', providerConfig.model || '(empty)');
      } else {
        console.warn('[Main] gateway:inbound: no active provider configured');
      }

      // Accumulate text from chat:text events
      let accumulatedText = '';
      let sseBuffer = '';

      const workingDirectory = prepareGatewayWorkspace(getOrBuildInitConfig());
      const db = getDatabase();
      if (db) {
        try {
          // Repair sessions created before the gateway workspace contract was
          // introduced. More importantly, keep UI metadata aligned with the
          // top-level cwd passed to the worker below and restore the fixed
          // channel permission profile for legacy rows.
          db.prepare(
            'UPDATE chat_sessions SET working_directory = ?, permission_profile = ?, updated_at = ? WHERE id = ?',
          ).run(workingDirectory, GATEWAY_PERMISSION_PROFILE, Date.now(), sessionId);
        } catch (err) {
          getLogger().warn(
            'Failed to synchronize gateway session workspace',
            { sessionId, error: err instanceof Error ? err.message : String(err) },
            LogComponent.Gateway,
          );
        }
      }

      const body = JSON.stringify(buildGatewayInboundChatRequest({
        inbound: inboundMsg,
        providerConfig,
        workingDirectory,
      }));

      const req = require('http').request(
        {
          method: 'POST',
          hostname: '127.0.0.1',
          port,
          path: `/sessions/${sessionId}/chat`,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'Accept': 'text/event-stream',
          },
        },
        (res: http.IncomingMessage) => {
          res.on('data', (chunk: Buffer) => {
            sseBuffer += chunk.toString();
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6);
              try {
                const event = JSON.parse(data);

                // Handle different event types
                if (event.type === 'text') {
                  const content = event.data?.content || '';
                  accumulatedText += content;
                  // Forward text event to Gateway immediately
                  sendToGatewayProcess({
                    type: 'gateway:outbound',
                    sessionId,
                    platform,
                    platformChatId,
                    event: { type: 'chat:text', content },
                  });
                } else if (event.type === 'thinking') {
                  const content = event.data?.content || '';
                  sendToGatewayProcess({
                    type: 'gateway:outbound',
                    sessionId,
                    platform,
                    platformChatId,
                    event: { type: 'chat:thinking', content },
                  });
                } else if (event.type === 'done') {
                  getLogger().debug('[gateway:inbound] done event received', {
                    sessionId,
                    accumulatedLength: accumulatedText.length,
                  }, LogComponent.Gateway);

                  // Send final content with accumulated text
                  sendToGatewayProcess({
                    type: 'gateway:outbound',
                    sessionId,
                    platform,
                    platformChatId,
                    event: {
                      type: 'chat:done',
                      finalContent: accumulatedText,
                    },
                  });
                } else if (event.type === 'error') {
                  const message = event.data?.message || 'Agent error';
                  getLogger().error('[gateway:inbound] Agent error', new Error(message), { sessionId }, LogComponent.Gateway);
                  sendToGatewayProcess({
                    type: 'gateway:outbound',
                    sessionId,
                    platform,
                    platformChatId,
                    event: { type: 'chat:error', message },
                  });
                }
              } catch (e) {
                // Ignore parse errors for partial SSE data
              }
            }
          });

          res.on('end', () => {
            getLogger().debug('[gateway:inbound] SSE stream ended', { sessionId }, LogComponent.Gateway);
          });
        }
      );

      req.on('error', (err: Error) => {
        getLogger().error('Failed to forward gateway:inbound to Agent Server', err, { sessionId }, LogComponent.Gateway);
      });

      req.write(body);
      req.end();

      getLogger().debug('Forwarded gateway:inbound to Agent Server', { sessionId, promptLength: inboundMsg.prompt.length }, LogComponent.Gateway);
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

    case 'gateway:create_session': {
      // Handle gateway:create_session from Gateway subprocess
      const data = msg as {
        id?: string;
        platform: string;
        platformUserId: string;
        platformChatId: string;
      };
      console.log('[Main] gateway:create_session received, id:', data.id);

      // Use platform + platformChatId as sessionId to ensure conversation history is preserved
      const sessionId = `gw-${data.platform}-${data.platformChatId}`;
      createOrResetGatewaySession(sessionId, data.platform);

      // Resolve workspace from init config (reads bridge_workspace setting,
      // falls back to ~/.duya/workspace).
      const workingDirectory = prepareGatewayWorkspace(getOrBuildInitConfig());

      // Save session to threads table and chat_sessions table
      const db = getDatabase();
      if (db) {
        try {
          const now = Date.now();
          const title = `${data.platform} ${new Date().toLocaleString()}`;
          db.prepare(`
            INSERT INTO threads (id, title, provider_type, model, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
          `).run(sessionId, title, 'gateway', '', now, now);
          db.prepare(`
            INSERT INTO chat_sessions (id, title, model, system_prompt, working_directory, project_name, status, mode, permission_profile, provider_id, generation, created_at, updated_at, is_deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT(id) DO UPDATE SET
              working_directory = excluded.working_directory,
              permission_profile = excluded.permission_profile,
              updated_at = excluded.updated_at
          `).run(sessionId, title, '', '', workingDirectory, '', 'active', 'chat', GATEWAY_PERMISSION_PROFILE, 'env', 0, now, now);

          // Create user mapping atomically (saves one IPC round-trip from Gateway)
          db.prepare(`
            INSERT INTO gateway_user_map (id, platform, platform_user_id, platform_chat_id, session_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(platform, platform_chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at
          `).run(`${data.platform}:${data.platformChatId}`, data.platform, data.platformUserId, data.platformChatId, sessionId, now, now);
        } catch (err) {
          getLogger().error('Failed to save gateway session', err instanceof Error ? err : new Error(String(err)), { sessionId }, LogComponent.Gateway);
        }
      }

      // Send response back to Gateway
      console.log('[Main] Sending gateway:create_session:response, id:', data.id, 'sessionId:', sessionId);
      sendToGatewayProcess({
        type: 'gateway:create_session:response',
        id: data.id,
        sessionId,
      });
      break;
    }

    case 'gateway:reset_session': {
      // Handle gateway:reset_session from Gateway subprocess
      const data = msg as {
        id?: string;
        platform: string;
        platformChatId: string;
        platformUserId: string;
        platformMsgId: string;
      };
      console.log('[Main] gateway:reset_session received, platform:', data.platform);

      const db = getDatabase();

      // 1. Find old session id from the user mapping table (source of
      //    truth for platform+chat → session). The in-memory states map
      //    may have been cleared or keyed differently, so DB lookup is
      //    more reliable.
      let oldSessionId: string | undefined;
      if (db) {
        const row = db.prepare(
          'SELECT session_id FROM gateway_user_map WHERE platform = ? AND platform_chat_id = ?'
        ).get(data.platform, data.platformChatId) as { session_id?: string } | undefined;
        oldSessionId = row?.session_id;
      }

      // 2. Reset old session in-memory state if it exists. Messages are
      //    intentionally preserved so the old session remains viewable in
      //    the UI; /new creates a fresh session by updating the mapping
      //    below.
      if (oldSessionId) {
        resetGatewaySession(oldSessionId);
      }

      // 3. Generate a NEW random session id. A deterministic id
      //    (gw-<platform>-<chatId>) would reuse the same DB rows and
      //    the agent would still see the old context. A fresh id
      //    guarantees a clean slate — matches the renderer IPC path
      //    (ipcMain.handle('gateway:reset_session')).
      const sessionId = `gw-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      createOrResetGatewaySession(sessionId, data.platform);

      // Resolve workspace from init config (reads bridge_workspace setting,
      // falls back to ~/.duya/workspace).
      const workingDirectory = prepareGatewayWorkspace(getOrBuildInitConfig());

      // Save new session to threads table and chat_sessions table
      if (db) {
        try {
          const now = Date.now();
          const title = `${data.platform} Reset ${new Date().toLocaleString()}`;
          db.prepare(`
            INSERT INTO threads (id, title, provider_type, model, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at
          `).run(sessionId, title, 'gateway', '', now, now);
          // Also insert into chat_sessions so messages can be persisted via replaceMessages
          db.prepare(`
            INSERT INTO chat_sessions (id, title, model, system_prompt, working_directory, project_name, status, mode, permission_profile, provider_id, generation, created_at, updated_at, is_deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT(id) DO UPDATE SET
              working_directory = excluded.working_directory,
              permission_profile = excluded.permission_profile,
              updated_at = excluded.updated_at
          `).run(sessionId, title, '', '', workingDirectory, '', 'active', 'chat', GATEWAY_PERMISSION_PROFILE, 'env', 0, now, now);
          // Update the user mapping to point at the new session. Without
          // this, getOrCreateSession would return the old session id and
          // the reset would be invisible — the next inbound message would
          // still route to the old session with its old context.
          db.prepare(`
            INSERT INTO gateway_user_map (id, platform, platform_user_id, platform_chat_id, session_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(platform, platform_chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at
          `).run(`${data.platform}:${data.platformChatId}`, data.platform, data.platformUserId, data.platformChatId, sessionId, now, now);
        } catch (err) {
          getLogger().error('Failed to save gateway reset session', err instanceof Error ? err : new Error(String(err)), { sessionId }, LogComponent.Gateway);
        }
      }

      // Send response back to Gateway
      sendToGatewayProcess({
        type: 'gateway:reset_session:response',
        id: data.id,
        sessionId,
        oldSessionId,
      });
      break;
    }

    case 'gateway:pairing:check': {
      const data = msg as { id: string; platform: string; platformUserId: string };
      try {
        const store = getPairingStore();
        const approved = store.isApproved(data.platform, data.platformUserId);
        sendToGatewayProcess({ type: 'gateway:pairing:check:response', id: data.id, approved });
      } catch (err) {
        getLogger().error('Failed to check pairing', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Gateway);
        sendToGatewayProcess({ type: 'gateway:pairing:check:response', id: data.id, approved: false });
      }
      break;
    }

    case 'gateway:pairing:generate': {
      const data = msg as {
        id: string;
        platform: string;
        platformUserId: string;
        platformChatId: string;
        userName: string;
      };
      try {
        const store = getPairingStore();
        const result = store.generateCode(data.platform, data.platformUserId, data.platformChatId, data.userName);
        sendToGatewayProcess({ type: 'gateway:pairing:generate:response', id: data.id, ...result });
      } catch (err) {
        getLogger().error('Failed to generate pairing code', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Gateway);
        sendToGatewayProcess({ type: 'gateway:pairing:generate:response', id: data.id, code: '', error: 'internal_error' });
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

  proc.send({
    type: 'gateway:outbound',
    sessionId,
    platform: sessionInfo?.bridgeChannel,
    platformChatId: undefined,
    event,
  });
}

export function forwardPermissionToGateway(
  sessionId: string,
  permission: { id: string; toolName: string; toolInput: Record<string, unknown> },
): void {
  const proc = getGatewayProcess();
  if (!proc || proc.killed) return;

  proc.send({
    type: 'gateway:permission_request',
    sessionId,
    permission,
  });
}

export function isGatewaySession(sessionId: string): boolean {
  return getSessionStates().has(sessionId);
}

// IPC handlers
const _gatewayStatusRequests = new Map<string, { resolve: (value: any) => void; reject: (err: Error) => void; timeout: ReturnType<typeof setTimeout> }>();

export function getOrBuildInitConfig(): GatewayInitConfig {
  // 注意：不再缓存。每次调用都从 DB 重读，确保 UI 保存新凭据后下一次 start 拿到最新值。
  // 缓存导致过 "配置完 channel 后必须重启 dev 才能生效" 的 bug。

  const db = getDatabase();
  const platforms: Array<{ platform: string; enabled: boolean; credentials: Record<string, string>; options?: Record<string, unknown> }> = [];

  if (db) {
    // Load WeChat/iLink accounts from weixin_accounts table
    const weixinAccounts = db.prepare(
      'SELECT account_id, user_id, token, base_url, cdn_base_url FROM weixin_accounts WHERE enabled = 1'
    ).all() as Array<{ account_id: string; user_id: string; token: string; base_url: string; cdn_base_url: string }>;

    for (const account of weixinAccounts) {
      if (!account.token?.trim()) {
        console.warn('[Gateway] Skipping weixin account with empty token:', account.account_id);
        continue;
      }
      platforms.push({
        platform: 'weixin',
        enabled: true,
        credentials: {
          botToken: account.token,
          ilinkBotId: account.account_id,
          baseUrl: account.base_url || 'https://ilinkai.weixin.qq.com',
          cdnBaseUrl: account.cdn_base_url || 'https://novac2c.cdn.weixin.qq.com/c2c',
        },
      });
    }

    // Load legacy settings-based WeChat config if no accounts exist
    if (weixinAccounts.length === 0) {
      const weixinEnabled = db.prepare("SELECT value FROM settings WHERE key = 'bridge_weixin_enabled'").get() as { value: string } | undefined;
      const weixinToken = db.prepare("SELECT value FROM settings WHERE key = 'weixin_bot_token'").get() as { value: string } | undefined;
      const weixinAccountId = db.prepare("SELECT value FROM settings WHERE key = 'weixin_account_id'").get() as { value: string } | undefined;
      const weixinBaseUrl = db.prepare("SELECT value FROM settings WHERE key = 'weixin_base_url'").get() as { value: string } | undefined;

      if (weixinEnabled?.value === 'true' && weixinToken?.value) {
        platforms.push({
          platform: 'weixin',
          enabled: true,
          credentials: {
            botToken: weixinToken.value,
            ilinkBotId: weixinAccountId?.value || '',
            baseUrl: weixinBaseUrl?.value || 'https://ilinkai.weixin.qq.com',
            cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
          },
        });
      }
    }

    // Load Telegram config
    const telegramEnabled = db.prepare("SELECT value FROM settings WHERE key = 'bridge_telegram_enabled'").get() as { value: string } | undefined;
    const telegramToken = db.prepare("SELECT value FROM settings WHERE key = 'telegram_bot_token'").get() as { value: string } | undefined;

    if (telegramEnabled?.value === 'true' && telegramToken?.value) {
      platforms.push({
        platform: 'telegram',
        enabled: true,
        credentials: { token: telegramToken.value },
      });
    }

    // Load QQ config
    const qqEnabled = db.prepare("SELECT value FROM settings WHERE key = 'bridge_qq_enabled'").get() as { value: string } | undefined;
    const qqAppId = db.prepare("SELECT value FROM settings WHERE key = 'bridge_qq_app_id'").get() as { value: string } | undefined;
    const qqAppSecret = db.prepare("SELECT value FROM settings WHERE key = 'bridge_qq_app_secret'").get() as { value: string } | undefined;

    if (qqEnabled?.value === 'true' && qqAppId?.value && qqAppSecret?.value) {
      platforms.push({
        platform: 'qq',
        enabled: true,
        credentials: {
          appId: qqAppId.value,
          appSecret: qqAppSecret.value,
        },
      });
    }

    // Load Feishu config
    const feishuEnabled = db.prepare("SELECT value FROM settings WHERE key = 'bridge_feishu_enabled'").get() as { value: string } | undefined;
    const feishuAppId = db.prepare("SELECT value FROM settings WHERE key = 'bridge_feishu_app_id'").get() as { value: string } | undefined;
    const feishuAppSecret = db.prepare("SELECT value FROM settings WHERE key = 'bridge_feishu_app_secret'").get() as { value: string } | undefined;

    if (feishuEnabled?.value === 'true' && feishuAppId?.value && feishuAppSecret?.value) {
      platforms.push({
        platform: 'feishu',
        enabled: true,
        credentials: {
          appId: feishuAppId.value,
          appSecret: feishuAppSecret.value,
        },
      });
    }
  }

  // Check auto-start setting
  let autoStart = false;
  if (db) {
    const autoStartRow = db.prepare("SELECT value FROM settings WHERE key = 'bridge_auto_start'").get() as { value: string } | undefined;
    autoStart = autoStartRow?.value === 'true';
  }

  // Load per-channel proxy configuration
  const proxyConfig = getGatewayProxyConfig();

  // Read gateway workspace from DB (bridge_workspace setting). Falls back to
  // ~/.duya/workspace when absent/empty. Never use process.cwd() — that leaks
  // the Electron app's cwd (e.g. the dev repo path) into agent sessions.
  const workspaceRow = db.prepare("SELECT value FROM settings WHERE key = 'bridge_workspace'").get() as { value: string } | undefined;
  let workingDirectory: string;
  if (workspaceRow?.value) {
    // Settings are stored as JSON strings; plain strings also accepted.
    try {
      const parsed = JSON.parse(workspaceRow.value);
      workingDirectory = typeof parsed === 'string' ? parsed : workspaceRow.value;
    } catch {
      workingDirectory = workspaceRow.value;
    }
  }
  if (!workingDirectory || !workingDirectory.trim()) {
    workingDirectory = getDefaultGatewayWorkspace();
  }

  const config: GatewayInitConfig = {
    platforms,
    autoStart,
    proxyConfig,
    workingDirectory,
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

  ipcMain.handle('gateway:pairing:list', async () => {
    try {
      const store = getPairingStore();
      const pending = store.listAllPending();
      const approved = store.listApproved();
      return { pending, approved };
    } catch (err) {
      getLogger().error('Failed to list pairings', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Gateway);
      return { pending: [], approved: [] };
    }
  });

  ipcMain.handle('gateway:pairing:check', async (_event, platform: string, platformUserId: string) => {
    try {
      const store = getPairingStore();
      return { approved: store.isApproved(platform, platformUserId) };
    } catch (err) {
      getLogger().error('Failed to check pairing', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Gateway);
      return { approved: false };
    }
  });

  ipcMain.handle('gateway:pairing:generate', async (
    _event,
    platform: string,
    platformUserId: string,
    platformChatId: string,
    userName: string,
  ) => {
    try {
      const store = getPairingStore();
      return store.generateCode(platform, platformUserId, platformChatId, userName);
    } catch (err) {
      getLogger().error('Failed to generate pairing code', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Gateway);
      return { code: '', error: 'internal_error' };
    }
  });

  ipcMain.handle('gateway:pairing:approve', async (_event, platform: string, code: string) => {
    try {
      const store = getPairingStore();
      return store.approve(platform, code);
    } catch (err) {
      getLogger().error('Failed to approve pairing', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Gateway);
      return { approved: false, error: 'internal_error' };
    }
  });

  ipcMain.handle('gateway:pairing:revoke', async (_event, platform: string, platformUserId: string) => {
    try {
      const store = getPairingStore();
      return { revoked: store.revoke(platform, platformUserId) };
    } catch (err) {
      getLogger().error('Failed to revoke pairing', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Gateway);
      return { revoked: false };
    }
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

  ipcMain.handle('gateway:send', (_event, sessionId: string, data: string) => {
    try {
      const parsed = typeof data === 'string' ? JSON.parse(data) : data;
      forwardToGateway(sessionId, parsed);
    } catch {
      forwardToGateway(sessionId, data as unknown as Record<string, unknown>);
    }
    return { success: true };
  });

  ipcMain.handle('gateway:permission', (_event, sessionId: string, permission: { id: string; toolName: string; toolInput: Record<string, unknown> }) => {
    forwardPermissionToGateway(sessionId, permission);
    return { success: true };
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

  ipcMain.handle('gateway:create_session', (_event, data: { platform: string; platformUserId: string; platformChatId: string }) => {
    const sessionId = `gw-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    createOrResetGatewaySession(sessionId, data.platform);

    // Resolve workspace from init config (reads bridge_workspace setting,
    // falls back to ~/.duya/workspace).
    const workingDirectory = prepareGatewayWorkspace(getOrBuildInitConfig());

    // Save session to threads table and chat_sessions table
    const db = getDatabase();
    if (db) {
      try {
        const now = Date.now();
        const title = `${data.platform} ${new Date().toLocaleString()}`;
        db.prepare(`
          INSERT INTO threads (id, title, provider_type, model, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
        `).run(sessionId, title, 'gateway', '', now, now);
        // Also insert into chat_sessions so messages can be persisted via replaceMessages
        db.prepare(`
          INSERT INTO chat_sessions (id, title, model, system_prompt, working_directory, project_name, status, mode, permission_profile, provider_id, generation, created_at, updated_at, is_deleted)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
          ON CONFLICT(id) DO UPDATE SET
            working_directory = excluded.working_directory,
            permission_profile = excluded.permission_profile,
            updated_at = excluded.updated_at
        `).run(sessionId, title, '', '', workingDirectory, '', 'active', 'chat', GATEWAY_PERMISSION_PROFILE, 'env', 0, now, now);
      } catch (err) {
        getLogger().error('Failed to save gateway session to threads', err instanceof Error ? err : new Error(String(err)), { sessionId }, LogComponent.Gateway);
      }
    }

    return { sessionId, success: true };
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
