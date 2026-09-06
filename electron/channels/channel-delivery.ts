/**
 * electron/channels/channel-delivery.ts — Outbound channel delivery (plan 488 §3.5 P2.2)
 *
 * Registry for platform-specific channel transports. Each transport implements the
 * `ChannelTransport` interface and is registered by platform name.
 *
 * When `deliverToChannel` is called with a channel address token (e.g. "slack:C12345"),
 * it resolves the address, looks up the transport for that platform, retrieves the
 * credentials from the secret store, and calls `transport.send()`.
 *
 * ## Transport interface
 *
 * Each transport implements:
 *   send(agentId, address, outbound): Promise<void>
 *
 * The transport is responsible for:
 * - Formatting the outbound message for the platform API
 * - Including the bot token from credentials
 * - Handling platform-specific rate limits and errors
 * - Returning rejected promise on failure (caller handles via queueChannelDeliveryFailure)
 */

import * as http from 'node:http';
import * as https from 'node:https';

import type { ChannelAddress, ChannelOutboundMessage } from '../../packages/agent/src/channels/types';
import { parseChannelAddress } from '../../packages/agent/src/channels/types';
import { getConnectorCredential } from './agent-session-channels';
import { getLogger, LogComponent } from '../logging/logger';

// =============================================================================
// Transport interface
// =============================================================================

/**
 * Platform-specific channel transport interface.
 * Implement this for each platform (Discord, Slack, etc.)
 */
export interface ChannelTransport {
  readonly platform: string;
  /**
   * Send an outbound message to a channel.
   * @param agentId    - The agent sending the message
   * @param address    - The channel address
   * @param outbound   - The message to send
   * @throws Error on delivery failure (caller catches and queues delivery failure)
   */
  send(agentId: string, address: ChannelAddress, outbound: ChannelOutboundMessage): Promise<void>;
}

// =============================================================================
// HTTP helper
// =============================================================================

/**
 * Simple HTTP request helper for platform API calls.
 * Handles Discord and Slack's HTTPS API requirements.
 */
function httpRequest(opts: {
  method: string;
  hostname: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  timeout?: number;
}): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const lib = opts.hostname.startsWith('discord') ? https : http;
    const req = lib.request(
      {
        method: opts.method,
        hostname: opts.hostname,
        path: opts.path,
        headers: opts.headers,
        timeout: opts.timeout ?? 10_000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP request timeout')); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// =============================================================================
// Discord transport
// =============================================================================

/**
 * Discord channel transport.
 *
 * Uses the Discord Bot API:
 *   POST https://discord.com/api/v10/channels/{channelId}/messages
 *   Authorization: Bot <token>
 */
class DiscordTransport implements ChannelTransport {
  readonly platform = 'discord';

  async send(agentId: string, address: ChannelAddress, outbound: ChannelOutboundMessage): Promise<void> {
    const token = getConnectorCredential(agentId, 'discord', 'token');
    if (!token) {
      throw new Error('Discord bot token not found for agent ${agentId}. Use secret-request to provide it.');
    }

    const channelId = address.chat; // For Discord, chat = channel ID

    let body: Record<string, unknown>;
    if (outbound.kind === 'text') {
      body = { content: outbound.content ?? '' };
    } else if (outbound.kind === 'attachment') {
      // Discord embed for URL attachment
      body = {
        content: outbound.content ?? '',
        embeds: [
          {
            title: outbound.caption ?? 'Attachment',
            url: outbound.url,
          },
        ],
      };
    } else {
      body = { content: '[unsupported message type]' };
    }

    const result = await httpRequest({
      method: 'POST',
      hostname: 'discord.com',
      path: `/api/v10/channels/${channelId}/messages`,
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'DiscordBot (duya, 1.0.0)',
      },
      body: JSON.stringify(body),
    });

    if (result.statusCode < 200 || result.statusCode >= 300) {
      let errMsg = `Discord API returned ${result.statusCode}`;
      try {
        const parsed = JSON.parse(result.body);
        if (parsed.message) errMsg += `: ${parsed.message}`;
      } catch { /* ignore parse errors */ }
      throw new Error(errMsg);
    }

    getLogger().debug('DiscordTransport: message sent', {
      agentId,
      channelId,
      statusCode: result.statusCode,
    }, LogComponent.AgentProcess);
  }
}

// =============================================================================
// Slack transport
// =============================================================================

/**
 * Slack channel transport.
 *
 * Uses the Slack Web API:
 *   POST https://slack.com/api/chat.postMessage
 *   Authorization: Bearer <token>
 */
class SlackTransport implements ChannelTransport {
  readonly platform = 'slack';

  async send(agentId: string, address: ChannelAddress, outbound: ChannelOutboundMessage): Promise<void> {
    const token = getConnectorCredential(agentId, 'slack', 'token');
    if (!token) {
      throw new Error('Slack bot token not found for agent ${agentId}. Use secret-request to provide it.');
    }

    const channelId = address.chat; // For Slack, chat = channel ID

    let body: Record<string, unknown> = { channel: channelId };

    if (outbound.kind === 'text') {
      body = { ...body, text: outbound.content ?? '' };
    } else if (outbound.kind === 'attachment') {
      body = {
        ...body,
        text: outbound.content ?? '',
        attachments: [
          {
            title: outbound.caption ?? 'Attachment',
            title_link: outbound.url,
          },
        ],
      };
    } else {
      body = { ...body, text: '[unsupported message type]' };
    }

    const result = await httpRequest({
      method: 'POST',
      hostname: 'slack.com',
      path: '/api/chat.postMessage',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(`Slack API returned ${result.statusCode}: ${result.body}`);
    }

    // Slack API returns { ok: true } or { ok: false, error: '...' }
    try {
      const parsed = JSON.parse(result.body);
      if (!parsed.ok) {
        throw new Error(`Slack API error: ${parsed.error ?? 'unknown'}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Slack API')) throw e;
      throw new Error(`Failed to parse Slack API response: ${result.body}`);
    }

    getLogger().debug('SlackTransport: message sent', {
      agentId,
      channelId,
    }, LogComponent.AgentProcess);
  }
}

// =============================================================================
// Transport registry
// =============================================================================

const transports = new Map<string, ChannelTransport>();

/**
 * Register a channel transport for a platform.
 * Platform name must match the platform field in the transport.
 */
export function registerTransport(transport: ChannelTransport): void {
  transports.set(transport.platform, transport);
}

/**
 * Get the transport for a platform.
 * Returns undefined if the platform is not registered.
 */
export function getTransport(platform: string): ChannelTransport | undefined {
  return transports.get(platform);
}

/**
 * Check if a platform has a registered transport.
 */
export function hasTransport(platform: string): boolean {
  return transports.has(platform);
}

/**
 * List all registered platforms.
 */
export function registeredPlatforms(): string[] {
  return [...transports.keys()];
}

// =============================================================================
// Channel delivery function (exported for wake/channels.ts)
// =============================================================================

const logger = getLogger();

/**
 * Deliver an outbound message to a channel via the registered transport.
 *
 * @param agentId     - The agent sending the message
 * @param addressToken - Channel address token, e.g. "slack:C12345"
 * @param outbound    - The message to send
 * @throws Error on delivery failure (caller should catch and queue via queueChannelDeliveryFailure)
 */
export async function channelDelivery(
  agentId: string,
  addressToken: string,
  outbound: ChannelOutboundMessage,
): Promise<void> {
  const address = parseChannelAddress(addressToken);
  if (!address) {
    throw new Error(`Invalid channel address token: "${addressToken}". Expected format: "platform:chatId".`);
  }

  // Feishu/WeChat outbound must reuse the SAME live adapter instance that is
  // polling inbound (context_token continuity, batching, stream cards). Prefer
  // the live registry over the stateless HTTP transports when present.
  const { getLiveOutbound } = await import('./connector-runtime');
  const live = getLiveOutbound(agentId, address.platform);
  if (live) {
    logger.info('channelDelivery: delivering via live adapter', {
      agentId,
      platform: address.platform,
      chat: address.chat,
    }, LogComponent.AgentProcess);
    await live(address.chat, outbound);
    return;
  }

  const transport = getTransport(address.platform);
  if (!transport) {
    throw new Error(
      `No transport registered for platform "${address.platform}". ` +
      `Registered platforms: [${registeredPlatforms().join(', ') || 'none'}].`,
    );
  }

  logger.info('channelDelivery: delivering message', {
    agentId,
    platform: address.platform,
    chat: address.chat,
    outboundKind: outbound.kind,
  }, LogComponent.AgentProcess);

  await transport.send(agentId, address, outbound);
}

// =============================================================================
// Default transports registration
// =============================================================================

// Register built-in transports on module load
registerTransport(new DiscordTransport());
registerTransport(new SlackTransport());

/**
 * Telegram channel transport (plan 488 P6).
 *
 * Uses the Telegram Bot API with the bot's own token:
 *   POST https://api.telegram.org/bot<token>/sendMessage
 *   { chat_id, text }
 */
class TelegramTransport implements ChannelTransport {
  readonly platform = 'telegram';

  async send(agentId: string, address: ChannelAddress, outbound: ChannelOutboundMessage): Promise<void> {
    const token = getConnectorCredential(agentId, 'telegram', 'token');
    if (!token) {
      throw new Error(`Telegram bot token not found for agent ${agentId}. Use secret-request to provide it.`);
    }

    let text: string;
    if (outbound.kind === 'attachment') {
      // Telegram media send needs multipart (sendPhoto/sendDocument); until a
      // multipart transport lands, deliver the URL as a link with caption.
      text = [outbound.caption ?? 'Attachment', outbound.url].filter(Boolean).join('\n');
    } else {
      text = outbound.content ?? '';
    }

    const result = await httpRequest({
      method: 'POST',
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: address.chat, text }),
    });

    if (result.statusCode < 200 || result.statusCode >= 300) {
      let errMsg = `Telegram API returned ${result.statusCode}`;
      try {
        const parsed = JSON.parse(result.body);
        if (parsed.description) errMsg += `: ${parsed.description}`;
      } catch { /* ignore parse errors */ }
      throw new Error(errMsg);
    }
  }
}

registerTransport(new TelegramTransport());
