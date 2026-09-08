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

import * as fs from 'node:fs';
import * as https from 'node:https';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import type { ChannelAddress, ChannelOutboundMessage } from '../../packages/agent/src/channels/types';
import { parseChannelAddress } from '../../packages/agent/src/channels/types';
import { getConnectorCredential } from './agent-session-channels';
import { isFileUrl, fileUrlToPath, mediaTypeForPath, mimeTypeForPath } from './file-url';
import { getLogger, LogComponent } from '../logging/logger';
import { channelOutboundToNormalizedReply, getConnector } from './connector-runtime';


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
 * Handles Discord, Slack and Telegram's HTTPS API requirements.
 *
 * All built-in platform transports are HTTPS-only: api.telegram.org and
 * api.slack.com answer plaintext (port 80) with a 301 → https redirect that
 * raw clients do not follow, so requests always go over TLS. Redirect
 * responses (301/302/303/307/308) with a Location header are followed up to
 * MAX_REDIRECT_HOPS (Telegram's Bot API uses them for datacenter routing).
 *
 * `body` may be a string (JSON — sent as before) or a Buffer (multipart —
 * Content-Length is set from the byte length, plan 507 P3.2).
 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_HOPS = 5;

function httpRequest(opts: {
  method: string;
  hostname: string;
  path: string;
  headers: Record<string, string>;
  body?: string | Buffer;
  timeout?: number;
}): Promise<{ statusCode: number; body: string }> {
  return requestOnce({ ...opts, url: new URL(`https://${opts.hostname}${opts.path}`) }, 0);
}

function requestOnce(
  opts: { url: URL; method: string; headers: Record<string, string>; body?: string | Buffer; timeout?: number },
  hop: number,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...opts.headers };
    if (Buffer.isBuffer(opts.body)) {
      headers['Content-Length'] = String(opts.body.length);
    }
    const req = https.request(
      {
        method: opts.method,
        hostname: opts.url.hostname,
        port: opts.url.port || 443,
        path: opts.url.pathname + opts.url.search,
        headers,
        timeout: opts.timeout ?? 10_000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const location = res.headers.location;
          if (REDIRECT_STATUSES.has(status) && location && hop < MAX_REDIRECT_HOPS) {
            requestOnce({ ...opts, url: new URL(location, opts.url) }, hop + 1).then(resolve, reject);
            return;
          }
          resolve({ statusCode: status, body });
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
// Multipart builder (plan 507 P3.2/P3.3)
// =============================================================================

/** A single file part of a multipart/form-data body. */
export interface MultipartFilePart {
  /** Form field name for the file part (e.g. "photo", "files[0]"). */
  name: string;
  /** Filename reported in the Content-Disposition. */
  filename: string;
  /** MIME type for the file part. */
  contentType: string;
  bytes: Buffer;
}

/**
 * Minimal RFC 7578 multipart/form-data body builder: string fields plus one
 * file part. Enough for Telegram media sends (single file + chat_id/caption)
 * and Discord uploads (files[0] + payload_json); not a general MIME writer.
 */
export function buildMultipartBody(
  fields: Record<string, string>,
  file: MultipartFilePart,
): { body: Buffer; contentType: string } {
  const boundary = `----duya-${randomBytes(16).toString('hex')}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${name}"\r\n` +
          `\r\n` +
          `${value}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.contentType}\r\n` +
        `\r\n`,
    ),
  );
  parts.push(file.bytes, Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

export type TelegramMediaKind = 'photo' | 'voice' | 'video' | 'document';

/**
 * Map a media kind (from `mediaTypeForPath`) to the Telegram Bot API endpoint
 * and the multipart file-part field name for the media upload.
 */
export function telegramMediaSend(kind: TelegramMediaKind): {
  endpoint: string;
  fileField: string;
} {
  switch (kind) {
    case 'photo': return { endpoint: 'sendPhoto', fileField: 'photo' };
    case 'video': return { endpoint: 'sendVideo', fileField: 'video' };
    case 'voice': return { endpoint: 'sendAudio', fileField: 'audio' };
    default: return { endpoint: 'sendDocument', fileField: 'document' };
  }
}

/** Hard truncation limit for Telegram media captions. */
const TELEGRAM_CAPTION_LIMIT = 1024;

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

    // file:// attachments are uploaded as real files via multipart (plan 507
    // P3.3); https:// attachments keep the embed/link path below.
    if (outbound.kind === 'attachment' && outbound.url && isFileUrl(outbound.url)) {
      await this.sendFile(token, channelId, outbound);
      return;
    }

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

  /**
   * Upload a file:// attachment as a real file: POST multipart to
   * /channels/{channelId}/messages with `files[0]` (the bytes) and
   * `payload_json` (message content). The file:// url is included in the
   * content next to the caption so the link survives alongside the upload.
   */
  private async sendFile(
    token: string,
    channelId: string,
    outbound: ChannelOutboundMessage,
  ): Promise<void> {
    const filePath = fileUrlToPath(outbound.url as string);
    const bytes = await fs.promises.readFile(filePath);
    const caption = outbound.caption ?? outbound.content ?? '';
    const content = caption ? `${caption}\n${outbound.url}` : (outbound.url ?? '');
    const { body, contentType } = buildMultipartBody(
      { payload_json: JSON.stringify({ content }) },
      {
        name: 'files[0]',
        filename: path.basename(filePath),
        contentType: mimeTypeForPath(filePath),
        bytes,
      },
    );

    const result = await httpRequest({
      method: 'POST',
      hostname: 'discord.com',
      path: `/api/v10/channels/${channelId}/messages`,
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': contentType,
        'User-Agent': 'DiscordBot (duya, 1.0.0)',
      },
      body,
    });

    if (result.statusCode < 200 || result.statusCode >= 300) {
      let errMsg = `Discord API returned ${result.statusCode}`;
      try {
        const parsed = JSON.parse(result.body);
        if (parsed.message) errMsg += `: ${parsed.message}`;
      } catch { /* ignore parse errors */ }
      throw new Error(errMsg);
    }

    getLogger().debug('DiscordTransport: attachment uploaded', {
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

    // file:// attachments are uploaded as real media via multipart (plan 507
    // P3.2); https:// attachments keep the link-with-caption text below.
    if (outbound.kind === 'attachment' && outbound.url && isFileUrl(outbound.url)) {
      await this.sendFile(token, address.chat, outbound);
      return;
    }

    let text: string;
    if (outbound.kind === 'attachment') {
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

  /**
   * Upload a file:// attachment as real media: read the bytes from disk and
   * POST multipart to the Bot API endpoint picked by media type —
   * sendPhoto (image), sendVideo (video), sendAudio (audio), sendDocument
   * (everything else) — with chat_id and a caption (hard-truncated to
   * Telegram's 1024-char caption limit) as form fields.
   */
  private async sendFile(
    token: string,
    chatId: string,
    outbound: ChannelOutboundMessage,
  ): Promise<void> {
    const filePath = fileUrlToPath(outbound.url as string);
    const bytes = await fs.promises.readFile(filePath);
    const kind: TelegramMediaKind = mediaTypeForPath(filePath);
    const { endpoint, fileField } = telegramMediaSend(kind);
    const caption = (outbound.caption ?? outbound.content ?? '').slice(0, TELEGRAM_CAPTION_LIMIT);

    const { body, contentType } = buildMultipartBody(
      { chat_id: chatId, ...(caption ? { caption } : {}) },
      {
        name: fileField,
        filename: path.basename(filePath),
        contentType: mimeTypeForPath(filePath),
        bytes,
      },
    );

    const result = await httpRequest({
      method: 'POST',
      hostname: 'api.telegram.org',
      path: `/bot${token}/${endpoint}`,
      headers: { 'Content-Type': contentType },
      body,
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

/**
 * WeChat channel transport (plan 488 P6).
 *
 * Outbound must reuse the SAME WeixinConnector (and its started
 * `WeixinAdapter`) that `BotConnectorManager` is already running for inbound
 * polling — context_token continuity, batching, and stream cards all assume
 * one adapter instance per bot. The transport therefore reaches into
 * `getConnector(agentId, 'weixin')` instead of `new`-ing a duplicate (the
 * duplicate path was previously fire-and-forget `start()`, which races the
 * outbound call). When the bot's weixin connector has not been started yet
 * (binding missing, credentials absent, or manager.sync() not yet run) we
 * surface a clear error instead of silently spinning up a parallel adapter.
 *
 * Note: the live outbound registry path in `channelDelivery()` is preferred
 * and will normally short-circuit before this transport runs; this fallback
 * remains so callers hitting `WeixinTransport.send` directly still go through
 * the right adapter instance.
 */
class WeixinTransport implements ChannelTransport {
  readonly platform = 'weixin';

  async send(agentId: string, address: ChannelAddress, outbound: ChannelOutboundMessage): Promise<void> {
    const botToken = getConnectorCredential(agentId, 'weixin', 'botToken');
    if (!botToken) {
      throw new Error(`Weixin bot token not found for agent ${agentId}. Use secret-request to provide it.`);
    }

    const connector = getConnector(agentId, 'weixin');
    if (!connector) {
      throw new Error(
        `Weixin bot connector is not running for agent ${agentId}. ` +
        `Make sure the agent is bound to the weixin platform and the connector-runtime has started it.`,
      );
    }

    const normalized = channelOutboundToNormalizedReply(outbound);
    const result = await connector.getAdapter().sendReply(address.chat, normalized);

    if (!result.ok) {
      throw new Error(result.error ?? 'Weixin sendReply failed');
    }
  }
}

registerTransport(new WeixinTransport());
registerTransport(new TelegramTransport());
