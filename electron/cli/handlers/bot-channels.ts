/**
 * electron/cli/handlers/bot-channels.ts
 *
 * Agent-scoped channel binding endpoints (plan 488 grok-form: each bot owns
 * its platform connection). A binding = the bot's own platform token, stored
 * per-agent; the connector runtime long-polls the platform with it and wakes
 * the bot's persistent session on inbound messages.
 *
 *   GET  /v1/agents/:agentId/channels           — list bound channels (no credentials)
 *   POST /v1/agents/:agentId/channels/connect    — { platform, credential, label? }
 *   POST /v1/agents/:agentId/channels/disconnect — { platform }
 *
 * The CLI reads the credential from an env var or stdin — never from an
 * argv flag (argv leaks via process listings and shell history).
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
  disconnectChannel,
  listAgentChannels,
  storeConnectorCredential,
} from '../../channels/agent-session-channels';
import { openChannelStore } from '../../channels/channel-store';
import { getBotConnectorManager } from '../../channels/connector-runtime';
import { CONNECTOR_MANIFESTS } from '../../../packages/agent/src/channels/types';
import { getLogger, LogComponent } from '../../logging/logger';

const CHANNEL_CREDENTIAL_FIELD = 'token';

function findManifest(platform: string) {
  return CONNECTOR_MANIFESTS.find((m) => m.platform === platform) ?? null;
}

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
    const channels = listAgentChannels(agentId);
    sendJson(res, 200, {
      agentId,
      channels: channels.map((c) => ({
        platform: c.platform,
        label: c.label,
        status: c.status,
        displayName: findManifest(c.platform)?.displayName ?? c.platform,
      })),
    });
  } catch (err) {
    sendJson(res, 500, {
      error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

/** POST /v1/agents/:agentId/channels/connect — body { platform, credential, label? } */
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
  const credential = asString(body.credential) ?? asString(body.token) ?? '';
  const label = asString(body.label) ?? '';
  const manifest = findManifest(platform);

  if (!agentExists(agentId)) {
    sendJson(res, 404, { error: { code: 'agent_not_found', message: `Unknown agent: ${agentId}` } });
    return;
  }
  if (!manifest) {
    sendJson(res, 400, {
      error: {
        code: 'unknown_platform',
        message: `Unknown platform: ${platform}. Known: ${CONNECTOR_MANIFESTS.map((m) => m.platform).join(', ')}`,
      },
    });
    return;
  }
  if (manifest.availability !== 'available') {
    sendJson(res, 400, {
      error: { code: 'platform_unavailable', message: `${manifest.displayName} is not available yet` },
    });
    return;
  }
  if (!credential.trim()) {
    sendJson(res, 400, {
      error: {
        code: 'missing_credential',
        message:
          'credential required (CLI: set DUYA_CHANNEL_TOKEN or pipe it via stdin; never pass it as an argv flag)',
      },
    });
    return;
  }

  const logger = getLogger();
  try {
    storeConnectorCredential(agentId, platform, CHANNEL_CREDENTIAL_FIELD, credential);
    openChannelStore(agentId).writeMetadata(platform, label || manifest.displayName);
    getBotConnectorManager().sync();
    await recordAudit(req, correlationId, 'channel.connect', `${agentId}:${platform}`, `label=${label || manifest.displayName}`);
    logger.info('Bot channel connected via CLI', { agentId, platform }, LogComponent.Gateway);
    sendJson(res, 200, { ok: true, agentId, platform, label: label || manifest.displayName });
  } catch (err) {
    logger.error(
      'Bot channel connect failed',
      err instanceof Error ? err : new Error(String(err)),
      { agentId, platform },
      LogComponent.Gateway,
    );
    sendJson(res, 502, { ok: false, platform, error: err instanceof Error ? err.message : String(err) });
  }
}

/** POST /v1/agents/:agentId/channels/disconnect — body { platform } */
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
  if (!agentExists(agentId)) {
    sendJson(res, 404, { error: { code: 'agent_not_found', message: `Unknown agent: ${agentId}` } });
    return;
  }
  if (!findManifest(platform)) {
    sendJson(res, 400, { error: { code: 'unknown_platform', message: `Unknown platform: ${platform}` } });
    return;
  }

  try {
    disconnectChannel(agentId, platform);
    getBotConnectorManager().sync();
    await recordAudit(req, correlationId, 'channel.disconnect', `${agentId}:${platform}`);
    sendJson(res, 200, { ok: true, agentId, platform });
  } catch (err) {
    sendJson(res, 502, { ok: false, platform, error: err instanceof Error ? err.message : String(err) });
  }
}
