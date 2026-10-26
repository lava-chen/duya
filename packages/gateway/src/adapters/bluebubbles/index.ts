/**
 * iMessage adapter via a BlueBubbles server.
 *
 * Apple exposes no user-facing iMessage API, so the only realistic path is a
 * BlueBubbles (or AirMessage) bridge running on a Mac. Two consequences shape
 * this adapter:
 *
 * - **The webhook is self-registered.** BlueBubbles must be told where to POST;
 *   a manually configured URL goes stale as soon as the gateway changes host or
 *   port, so `start()` registers and `stop()` unregisters it through the REST
 *   API. BlueBubbles authenticates the webhook by a password query parameter,
 *   not by a header or HMAC, which is why `password` never leaves the adapter.
 * - **Capabilities depend on the Private API.** Typing indicators and read
 *   receipts only work when the server reports `private_api && helper_connected`;
 *   without that, calls silently do nothing on Apple's side, so the adapter
 *   probes once at startup and skips those calls.
 *
 * Tapbacks (`associatedMessageType` 2000-2005 / 3000-3005) are reaction
 * side-channel events, not messages: they are acked and dropped.
 */

import path from 'node:path';
import type {
  PlatformConfig,
  NormalizedMessage,
  NormalizedReply,
  SendResult,
  MediaReply,
} from '../../types.js';
import { BaseAdapter } from '../base-adapter.js';
import { registerAdapterFactory } from '../base.js';
import { proxyFetch } from '../../proxy-fetch.js';
import { BoundedIdSet } from '../shared/dedup.js';
import { parseGatingOptions, evaluateGating, type GatingOptions } from '../shared/gating.js';
import { WebhookServer, type WebhookRequest, type WebhookResponse } from '../shared/webhook-server.js';
import { fetchMediaToCache, readMediaSource } from '../shared/media-cache.js';

const DEFAULT_PORT = 8645;
const DEFAULT_PATH = '/bluebubbles-webhook';
const MAX_MESSAGE_LENGTH = 4000;
const CHAT_RATE_LIMIT_MS = 1000;

const TAPBACK_TYPES = new Set<number>([
  2000, 2001, 2002, 2003, 2004, 2005, 3000, 3001, 3002, 3003, 3004, 3005,
]);

interface BlueBubblesOptions {
  port?: number;
  host?: string;
  webhook_path?: string;
  dm_policy?: 'open' | 'allowlist' | 'pairing' | 'disabled';
  allow_from?: string[];
  group_policy?: 'open' | 'allowlist' | 'pairing' | 'disabled';
  group_allow_from?: string[];
  require_mention?: boolean;
  mention_patterns?: string[];
  free_response_chats?: string[];
  send_read_receipts?: boolean;
  /** Route messages through the Private API (needed for typing/effects). */
  use_private_api?: boolean;
}

interface BBAttachment {
  guid?: string;
  mimeType?: string;
  transferName?: string;
  totalBytes?: number;
}

interface BBMessageData {
  guid?: string;
  text?: string;
  isFromMe?: boolean;
  handle?: { address?: string };
  chats?: Array<{ guid?: string; displayName?: string }>;
  dateCreated?: number;
  associatedMessageType?: number | string;
  attachments?: BBAttachment[];
  /** Present on replies. */
  associatedMessageGuid?: string;
}

export class BlueBubblesAdapter extends BaseAdapter {
  readonly platform = 'bluebubbles' as const;

  private serverUrl = '';
  private password = '';
  private webhookPath = DEFAULT_PATH;
  private privateApi = false;
  private helperConnected = false;
  private sendReadReceipts = true;
  private usePrivateApi = true;

  private gating: GatingOptions = parseGatingOptions();
  private server: WebhookServer | null = null;
  private registeredWebhookUrl = '';
  private readonly seen = new BoundedIdSet({ capacity: 2000, ttlMs: 30 * 60_000 });

  constructor() {
    super({ rateLimitMs: CHAT_RATE_LIMIT_MS, maxRetries: 2 });
    registerAdapterFactory('bluebubbles', () => new BlueBubblesAdapter());
  }

  async start(config: PlatformConfig): Promise<void> {
    if (this.running) return;

    this.serverUrl = (config.credentials['server_url'] ?? '').trim().replace(/\/+$/, '');
    this.password = (config.credentials['password'] ?? '').trim();
    if (!this.serverUrl || !this.password) {
      throw new Error('BlueBubbles requires `server_url` and `password` credentials');
    }

    const options = (config.options ?? {}) as BlueBubblesOptions;
    this.webhookPath = options.webhook_path ?? DEFAULT_PATH;
    this.sendReadReceipts = options.send_read_receipts !== false;
    this.usePrivateApi = options.use_private_api !== false;
    this.gating = parseGatingOptions(config.options);
    this.config = config;

    await this.probeServer();

    this.server = new WebhookServer({
      port: options.port ?? DEFAULT_PORT,
      ...(options.host ? { host: options.host } : {}),
      paths: [this.webhookPath],
      onRequest: (req) => this.handleWebhook(req),
      onError: (err) => this.updateHealthError(err),
    });
    await this.server.listen();

    this.running = true;
    this.updateHealthConnected();
    this.setBotUsername('imessage');
    await this.registerWebhook();
  }

  async stop(): Promise<void> {
    if (!this.running && !this.server) return;
    this.running = false;
    this.health.connected = false;
    await this.unregisterWebhook();
    const server = this.server;
    this.server = null;
    await server?.close();
  }

  isRunning(): boolean {
    return this.running;
  }

  // ---------------------------------------------------------------------------
  // Server bootstrap
  // ---------------------------------------------------------------------------

  private async probeServer(): Promise<void> {
    try {
      const info = await this.api<{ data?: { private_api?: boolean; helper_connected?: boolean; os_version?: string } }>(
        '/api/v1/server/info',
        'GET',
      );
      this.privateApi = info?.data?.private_api === true;
      this.helperConnected = info?.data?.helper_connected === true;
    } catch (err) {
      throw new Error(
        `BlueBubbles server unreachable at ${this.serverUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private webhookUrl(): string {
    const host = this.server?.host === '127.0.0.1' ? '127.0.0.1' : (this.server?.host ?? '127.0.0.1');
    return `http://${host}:${this.server?.port ?? DEFAULT_PORT}${this.webhookPath}`;
  }

  private async registerWebhook(): Promise<void> {
    const url = this.webhookUrl();
    try {
      await this.api('/api/v1/webhook', 'POST', {
        url,
        events: ['new-message', 'updated-message'],
      });
      this.registeredWebhookUrl = url;
    } catch {
      // A pre-existing registration is fine; inbound still works.
    }
  }

  private async unregisterWebhook(): Promise<void> {
    if (!this.registeredWebhookUrl) return;
    try {
      await this.api('/api/v1/webhook', 'DELETE', { url: this.registeredWebhookUrl });
    } catch {
      // Best-effort: a stale webhook only produces 404s on the BB side.
    }
    this.registeredWebhookUrl = '';
  }

  // ---------------------------------------------------------------------------
  // Inbound
  // ---------------------------------------------------------------------------

  private async handleWebhook(req: WebhookRequest): Promise<WebhookResponse> {
    if (req.method !== 'POST') {
      return { status: 405, body: 'method not allowed', contentType: 'text/plain' };
    }

    let payload: { type?: string; data?: BBMessageData };
    try {
      payload = JSON.parse(req.rawBody.toString('utf8')) as { type?: string; data?: BBMessageData };
    } catch {
      return { status: 400, body: 'invalid json', contentType: 'text/plain' };
    }

    if (payload.type !== 'new-message' && payload.type !== 'updated-message') {
      return { status: 200, body: 'ok', contentType: 'text/plain' };
    }

    void this.handleMessage(payload.data ?? {}).catch((err) => this.updateHealthError(err));
    return { status: 200, body: 'ok', contentType: 'text/plain' };
  }

  private async handleMessage(data: BBMessageData): Promise<void> {
    if (!data.guid || data.isFromMe) return;

    const associated = Number(data.associatedMessageType);
    if (Number.isFinite(associated) && TAPBACK_TYPES.has(associated)) {
      // Tapback: a reaction, not a message body.
      return;
    }
    if (!this.seen.add(data.guid)) return;

    const chatGuid = data.chats?.[0]?.guid ?? '';
    const sender = data.handle?.address ?? '';
    if (!chatGuid || !sender) return;

    // BlueBubbles encodes group chats as `iMessage;+;chat…`.
    const isGroup = chatGuid.includes(';+;');
    const text = data.text ?? '';

    const verdict = evaluateGating(this.gating, {
      senderId: sender,
      chatId: chatGuid,
      isGroup,
      text,
      botMentioned: isGroup && /@\S+/.test(text),
    });
    if (verdict === 'deny') return;

    this.incrementMessageCount();

    const media = await this.downloadAttachments(data.attachments ?? [], data.guid);

    const normalized: NormalizedMessage = {
      platform: 'bluebubbles',
      platformUserId: sender,
      platformChatId: chatGuid,
      platformMsgId: data.guid,
      ...(text ? { text } : {}),
      ...(media.imagePaths.length ? { imagePaths: media.imagePaths } : {}),
      ...(media.voicePaths.length ? { voicePaths: media.voicePaths } : {}),
      ...(media.videoPaths.length ? { videoPaths: media.videoPaths } : {}),
      ...(media.filePaths.length ? { filePaths: media.filePaths } : {}),
      ...(data.associatedMessageGuid ? { replyToMsgId: data.associatedMessageGuid } : {}),
      ts: data.dateCreated ?? Date.now(),
    };

    if (!normalized.text && !normalized.imagePaths && !normalized.voicePaths && !normalized.videoPaths && !normalized.filePaths) {
      normalized.text = '[attachment]';
    }

    if (normalized.text?.startsWith('/') && this.commandHandler) {
      const handled = await this.commandHandler(normalized).catch(() => false);
      if (handled) return;
    }
    this.messageHandler?.(normalized);
  }

  private async downloadAttachments(
    attachments: BBAttachment[],
    messageId: string,
  ): Promise<{
    imagePaths: string[];
    voicePaths: string[];
    videoPaths: string[];
    filePaths: Array<{ name: string; path: string }>;
  }> {
    const result = {
      imagePaths: [] as string[],
      voicePaths: [] as string[],
      videoPaths: [] as string[],
      filePaths: [] as Array<{ name: string; path: string }>,
    };

    for (const attachment of attachments) {
      if (!attachment.guid) continue;
      const cached = await fetchMediaToCache(
        'bluebubbles',
        `${this.serverUrl}/api/v1/attachment/${attachment.guid}/download?password=${encodeURIComponent(this.password)}`,
        {
          mimeHint: attachment.mimeType,
          ...(attachment.transferName ? { nameHint: attachment.transferName } : {}),
          idHint: messageId,
        },
      );
      if (!cached) continue;

      switch (cached.category) {
        case 'image': result.imagePaths.push(cached.path); break;
        case 'voice': result.voicePaths.push(cached.path); break;
        case 'video': result.videoPaths.push(cached.path); break;
        default: result.filePaths.push({ name: cached.name, path: cached.path }); break;
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Outbound
  // ---------------------------------------------------------------------------

  async sendReply(chatId: string, reply: NormalizedReply): Promise<SendResult> {
    try {
      switch (reply.type) {
        case 'text':
          return await this.sendText(chatId, reply.text);

        case 'stream_start':
        case 'stream_chunk':
          return { ok: true };

        case 'stream_end':
          return await this.sendText(chatId, reply.finalText);

        case 'permission_request': {
          const body = [reply.text, '', ...reply.buttons.map((b) => `• ${b.text}`)].join('\n');
          return await this.sendText(chatId, body);
        }

        case 'inline_keyboard': {
          const body = [reply.text, '', ...reply.rows.flat().map((b) => `• ${b.text}`)].join('\n');
          return await this.sendText(chatId, body);
        }

        case 'media':
          return await this.sendMedia(chatId, reply);

        case 'error':
          return await this.sendText(chatId, `⚠️ ${reply.message}`);

        default:
          return { ok: false, error: 'Unsupported reply type for BlueBubbles' };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    if (!this.running || !this.privateApiForTyping()) return;
    try {
      await this.api(`/api/v1/chat/${encodeURIComponent(chatId)}/typing`, 'POST', {});
    } catch {
      // Cosmetic.
    }
  }

  private privateApiForTyping(): boolean {
    // Typing indicators only reach Apple when the Private API helper is loaded.
    return this.privateApi && this.helperConnected;
  }

  private async sendText(chatId: string, input: string): Promise<SendResult> {
    const chunks = splitText(input ?? '', MAX_MESSAGE_LENGTH);
    if (chunks.length === 0) return { ok: false, error: 'empty message' };

    let lastGuid = '';
    for (const chunk of chunks) {
      await this.waitForRateLimit(chatId);
      const result = await this.api<{ data?: { guid?: string } }>('/api/v1/message/text', 'POST', {
        chatGuid: chatId,
        tempGuid: `duya-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        message: chunk,
        method: this.privateApi && this.helperConnected ? 'private-api' : 'apple-script',
      });
      lastGuid = result?.data?.guid ?? lastGuid;
      this.recordSendTime(chatId);
      if (this.sendReadReceipts) void this.markRead(chatId);
    }

    return { ok: true, ...(lastGuid ? { platformMsgId: lastGuid } : {}) };
  }

  private async markRead(chatId: string): Promise<void> {
    try {
      await this.api(`/api/v1/chat/${encodeURIComponent(chatId)}/read`, 'POST', {});
    } catch {
      // Best-effort.
    }
  }

  private async sendMedia(chatId: string, reply: MediaReply): Promise<SendResult> {
    const buffer = await readMediaSource(reply.filePath, 100 * 1024 * 1024);
    if (!buffer) return { ok: false, error: 'media source unreadable or too large' };

    const form = new FormData();
    form.append('chatGuid', chatId);
    form.append('tempGuid', `duya-${Date.now()}`);
    form.append('name', path.basename(reply.filePath));
    const name = path.basename(reply.filePath);
    form.append('attachment', new Blob([new Uint8Array(buffer)]), name);
    if (reply.caption) form.append('message', reply.caption);

    await this.waitForRateLimit(chatId);
    const result = await this.request<{ data?: { guid?: string } }>(
      '/api/v1/message/attachment',
      'POST',
      form,
    );
    this.recordSendTime(chatId);
    return { ok: true, ...(result?.data?.guid ? { platformMsgId: result.data.guid } : {}) };
  }

  // ---------------------------------------------------------------------------
  // REST transport
  // ---------------------------------------------------------------------------

  private api<T = unknown>(pathname: string, method: string, body?: unknown): Promise<T> {
    return this.request<T>(pathname, method, body);
  }

  private async request<T>(pathname: string, method: string, body?: unknown): Promise<T> {
    const separator = pathname.includes('?') ? '&' : '?';
    const url = `${this.serverUrl}${pathname}${separator}password=${encodeURIComponent(this.password)}`;

    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    const response = await proxyFetch(url, {
      method,
      ...(body === undefined
        ? {}
        : isForm
          ? { body: body as FormData }
          : {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
    });

    const text = await response.text();
    let parsed: unknown;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      const detail = (parsed as { message?: string } | undefined)?.message ?? `HTTP ${response.status}`;
      throw new Error(`BlueBubbles API error: ${detail}`);
    }
    return parsed as T;
  }
}

function splitText(text: string, max: number): string[] {
  if (text.length <= max) return text ? [text] : [];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const slice = rest.slice(0, max);
    const boundary = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('\n'), slice.lastIndexOf('. '));
    const cut = boundary > max * 0.5 ? boundary + 1 : max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

new BlueBubblesAdapter();
