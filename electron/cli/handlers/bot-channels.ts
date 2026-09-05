/**
 * electron/cli/handlers/bot-channels.ts
 *
 * Agent-scoped channel binding endpoints, reusing the gateway's channel
 * stack: a binding is a gateway profile route (`channels.profile_routes`)
 * mapping (platform[, chatId]) → the bot's config-agent id. Inbound gateway
 * messages on that platform/chat run with the bot's persona. Platform
 * credentials stay in `channels.adapters.<platform>.credentials`.
 *
 *   GET  /v1/agents/:agentId/channels           — list the bot's routes
 *   POST /v1/agents/:agentId/channels/connect    — bind { platform, chatId? }
 *   POST /v1/agents/:agentId/channels/disconnect — unbind { platform, chatId? }
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  asString,
  readJsonBody,
  recordAudit,
  sendJson,
} from './extra';
import { getLiveConfigAgent } from '../../config/agents';
import {
  addBotProfileRoute,
  listBotProfileRoutes,
  listGatewayPlatforms,
  removeBotProfileRoute,
} from '../../channels/profile-routes';

function agentExists(agentId: string): boolean {
  return getLiveConfigAgent(agentId) !== undefined;
}

/** GET /v1/agents/:agentId/channels */
export async function handleAgentChannelList(
  _req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
): Promise<void> {
  void _req;
  if (!agentExists(agentId)) {
    sendJson(res, 404, { error: { code: 'agent_not_found', message: `Unknown agent: ${agentId}` } });
    return;
  }
  try {
    sendJson(res, 200, { agentId, channels: listBotProfileRoutes(agentId) });
  } catch (err) {
    sendJson(res, 500, {
      error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

/** POST /v1/agents/:agentId/channels/connect — body { platform, chatId?, label? } */
export async function handleAgentChannelConnect(
  req: IncomingMessage,
  res: ServerResponse,
  correlationId: string | undefined,
  agentId: string,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, {
      error: { code: 'invalid_request', message: err instanceof Error ? err.message : String(err) },
    });
    return;
  }

  const platform = asString(body.platform) ?? '';
  const chatId = asString(body.chatId);
  const threadId = asString(body.threadId);
  const label = asString(body.label);

  if (!agentExists(agentId)) {
    sendJson(res, 404, { error: { code: 'agent_not_found', message: `Unknown agent: ${agentId}` } });
    return;
  }
  const configured = listGatewayPlatforms().map((p) => p.platform);
  if (!platform || !configured.includes(platform)) {
    sendJson(res, 400, {
      error: {
        code: 'unknown_platform',
        message: `Platform not configured in channels.adapters: ${platform || '(empty)'}. Configured: ${configured.join(', ') || '(none)'}`,
      },
    });
    return;
  }

  const result = addBotProfileRoute(agentId, platform, chatId, threadId, label);
  if (!result.ok) {
    const status = result.error === 'store_failed' ? 502 : 400;
    sendJson(res, status, { ok: false, platform, error: result.error });
    return;
  }
  await recordAudit(req, correlationId, 'channel.connect', `${agentId}:${platform}${chatId ? `:${chatId}` : ''}`);
  sendJson(res, 200, { ok: true, agentId, platform, ...(chatId ? { chatId } : {}) });
}

/** POST /v1/agents/:agentId/channels/disconnect — body { platform, chatId? } */
export async function handleAgentChannelDisconnect(
  req: IncomingMessage,
  res: ServerResponse,
  correlationId: string | undefined,
  agentId: string,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, {
      error: { code: 'invalid_request', message: err instanceof Error ? err.message : String(err) },
    });
    return;
  }

  const platform = asString(body.platform) ?? '';
  const chatId = asString(body.chatId);

  if (!agentExists(agentId)) {
    sendJson(res, 404, { error: { code: 'agent_not_found', message: `Unknown agent: ${agentId}` } });
    return;
  }
  if (!platform) {
    sendJson(res, 400, { error: { code: 'missing_arg', message: 'platform required' } });
    return;
  }

  const result = removeBotProfileRoute(agentId, platform, chatId);
  if (!result.ok) {
    const status = result.error === 'not_found' ? 404 : result.error === 'store_failed' ? 502 : 400;
    sendJson(res, status, { ok: false, platform, error: result.error });
    return;
  }
  await recordAudit(req, correlationId, 'channel.disconnect', `${agentId}:${platform}${chatId ? `:${chatId}` : ''}`);
  sendJson(res, 200, { ok: true, agentId, platform, ...(chatId ? { chatId } : {}) });
}
