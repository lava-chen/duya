/**
 * WhatsApp Cloud API adapter (Meta Graph).
 *
 * This is the official-API counterpart of the `whatsapp` adapter (which drives
 * WhatsApp Web through puppeteer). It is the adapter to prefer for bots:
 * - no browser, no session directory, no QR re-scan on host reboot,
 * - inbound arrives as signed webhooks (HMAC-SHA256 over the raw body),
 * - outbound supports native quick-reply buttons and lists, which the Web
 *   adapter can only render as plain text.
 *
 * Known platform constraints this adapter encodes:
 * - one message is capped at 4096 UTF-16 units → outbound text is chunked,
 * - an interactive message carries at most 3 quick-reply buttons; beyond that
 *   the choice is downgraded to a list,
 * - free-form (non-template) messages are only delivered inside the 24h
 *   customer-service window; a failed send surfaces Meta's error verbatim so
 *   the operator can see "outside allowed window" instead of a generic failure,
 * - "typing" and "read receipt" are one call: `status: "read"` plus
 *   `typing_indicator`, keyed by the inbound wamid. Without a recent inbound
 *   wamid the indicator cannot be shown and is skipped.
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
import { verifyHubSignature, verifyMetaChallenge } from '../shared/signature.js';
import { parseGatingOptions, evaluateGating, type GatingOptions } from '../shared/gating.js';
import { WebhookServer, headerValue, type WebhookRequest, type WebhookResponse } from '../shared/webhook-server.js';
import { fetchMediaToCache } from '../shared/media-cache.js';
import { getPlatformDescriptor } from '../../platform-capabilities.js';

import type {
  WAMediaRef,
  WAMessage,
  WAWebhookPayload,
  WASendPayload,
  WhatsAppCloudOptions,
} from './types.js';
import {
  formatForWhatsApp,
  splitForWhatsApp,
  buildInteractivePayload,
  mediaRefOf,
  inboundTextOf,
  callbackDataOf,
  senderNameOf,
} from './message-utils.js';

const GRAPH_BASE = 'https://graph.facebook.com';
const DEFAULT_API_VERSION = 'v21.0';
const DEFAULT_PORT = 8090;
const DEFAULT_WEBHOOK_PATH = '/whatsapp/webhook';
const CHAT_RATE_LIMIT_MS = 1200;
const MAX_WEBHOOK_BYTES = 3 * 1024 * 1024;

/** Per-media-type upload ceilings enforced by Meta. */
const MEDIA_LIMITS_MB: Record<'image' | 'video' | 'audio' | 'document', number> = {
  image: 5,
  video: 16,
  audio: 16,
  document: 100,
};

export class WhatsAppCloudAdapter extends BaseAdapter {
  readonly platform = 'whatsapp_cloud' as const;

  private phoneNumberId = '';
  private accessToken = '';
  private appSecret = '';
  private verifyToken = '';
  private apiVersion = DEFAULT_API_VERSION;
  private verifySignature = true;
  private mediaMaxMb = 25;

  private server: WebhookServer | null = null;
  private gating: GatingOptions = parseGatingOptions();
  /** wamid FIFO: Meta retries a webhook for up to 7 days. */
  private seen = new BoundedIdSet({ capacity: 5000 });
  /** Last inbound wamid per chat, required to attach a typing indicator. */
  private lastInboundId = new Map<string, string>();

  constructor() {
    super({ rateLimitMs: CHAT_RATE_LIMIT_MS, maxRetries: 2 });
    registerAdapterFactory('whatsapp_cloud', () => new WhatsAppCloudAdapter());
  }

  async start(config: PlatformConfig): Promise<void> {
    if (this.running) return;

    const creds = config.credentials ?? {};
    this.phoneNumberId = (creds['phone_number_id'] ?? '').trim();
    this.accessToken = (creds['access_token'] ?? '').trim();
    this.appSecret = (creds['app_secret'] ?? '').trim();
    this.verifyToken = (creds['verify_token'] ?? '').trim();
    this.apiVersion = (creds['api_version'] ?? DEFAULT_API_VERSION).trim() || DEFAULT_API_VERSION;

    const missing = getPlatformDescriptor('whatsapp_cloud').credentialFields
      .filter((field) => field.required && !creds[field.key])
      .map((field) => field.key);
    if (missing.length > 0) {
      throw new Error(`WhatsApp Cloud is missing credentials: ${missing.join(', ')}`);
    }

    const options = (config.options ?? {}) as WhatsAppCloudOptions;
    this.verifySignature = options.verify_signature !== false;
    this.mediaMaxMb = Math.max(1, options.media_max_mb ?? 25);
    this.gating = parseGatingOptions(config.options);
    this.config = config;

    this.server = new WebhookServer({
      port: options.port ?? DEFAULT_PORT,
      ...(options.host ? { host: options.host } : {}),
      paths: [options.webhook_path ?? DEFAULT_WEBHOOK_PATH],
      maxBodyBytes: MAX_WEBHOOK_BYTES,
      onRequest: (req) => this.handleWebhook(req),
      onError: (err) => this.updateHealthError(err),
    });
    await this.server.listen();

    this.running = true;
    this.updateHealthConnected();
    this.setBotUsername(this.phoneNumberId);
  }

  async stop(): Promise<void> {
    if (!this.running && !this.server) return;
    this.running = false;
    this.health.connected = false;
    const server = this.server;
    this.server = null;
    await server?.close();
    this.lastInboundId.clear();
  }

  isRunning(): boolean {
    return this.running;
  }

  // ---------------------------------------------------------------------------
  // Inbound
  // ---------------------------------------------------------------------------

  private async handleWebhook(req: WebhookRequest): Promise<WebhookResponse> {
    // Subscription handshake: echo the challenge only for the configured token.
    if (req.method === 'GET') {
      const challenge = verifyMetaChallenge(req.query, this.verifyToken);
      if (challenge === null) {
        return { status: 403, body: 'verification failed', contentType: 'text/plain' };
      }
      return { status: 200, body: challenge, contentType: 'text/plain' };
    }

    if (req.method !== 'POST') {
      return { status: 405, body: 'method not allowed', contentType: 'text/plain' };
    }

    if (this.verifySignature) {
      const signature = headerValue(req.headers, 'x-hub-signature-256');
      if (!verifyHubSignature(this.appSecret, req.rawBody, signature)) {
        return { status: 401, body: 'invalid signature', contentType: 'text/plain' };
      }
    }

    let payload: WAWebhookPayload;
    try {
      payload = JSON.parse(req.rawBody.toString('utf8')) as WAWebhookPayload;
    } catch {
      return { status: 400, body: 'invalid json', contentType: 'text/plain' };
    }

    // Meta retries anything that is not a fast 200; acknowledgement must not
    // wait on media download or on the agent.
    void this.processPayload(payload).catch((err) => this.updateHealthError(err));
    return { status: 200, body: 'EVENT_RECEIVED', contentType: 'text/plain' };
  }

  private async processPayload(payload: WAWebhookPayload): Promise<void> {
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field && change.field !== 'messages') continue;
        const value = change.value;
        if (!value) continue;

        // Delivery/read receipts tell us nothing the agent needs.
        if (value.statuses?.length && !value.messages?.length) continue;

        for (const message of value.messages ?? []) {
          await this.handleInbound(message, value.contacts);
        }
      }
    }
  }

  private async handleInbound(
    message: WAMessage,
    contacts: Array<{ profile?: { name?: string }; wa_id?: string }> | undefined,
  ): Promise<void> {
    if (!message.from || !message.id) return;
    if (!this.seen.add(message.id)) return;

    // Reactions arrive as their own message; forward them as gateway events so
    // the host can render them without faking a chat turn.
    if (message.type === 'reaction') {
      this.forwardReaction(message);
      return;
    }

    const verdict = evaluateGating(this.gating, {
      senderId: message.from,
      chatId: message.from,
      isGroup: false,
      text: inboundTextOf(message),
      // Cloud API DMs never carry a mention.
      botMentioned: false,
    });
    if (verdict === 'deny') return;

    this.incrementMessageCount();
    this.lastInboundId.set(message.from, message.id);

    const attachments = await this.downloadInboundMedia(message);
    const text = inboundTextOf(message);
    const callbackData = callbackDataOf(message);

    const normalized: NormalizedMessage = {
      platform: 'whatsapp_cloud',
      platformUserId: message.from,
      platformChatId: message.from,
      platformMsgId: message.id,
      ...(text ? { text } : {}),
      ...(attachments.imagePaths.length ? { imagePaths: attachments.imagePaths } : {}),
      ...(attachments.voicePaths.length ? { voicePaths: attachments.voicePaths } : {}),
      ...(attachments.videoPaths.length ? { videoPaths: attachments.videoPaths } : {}),
      ...(attachments.filePaths.length ? { filePaths: attachments.filePaths } : {}),
      ...(message.context?.id ? { replyToMsgId: message.context.id } : {}),
      ...(callbackData ? { callbackData } : {}),
      ts: Number(message.timestamp) * 1000 || Date.now(),
    };

    if (!normalized.text && !normalized.imagePaths && !normalized.voicePaths && !normalized.videoPaths && !normalized.filePaths) {
      // Sticker/contacts/unsupported type: keep the turn alive with a marker.
      normalized.text = `[${message.type}]`;
    }

    const senderName = senderNameOf(contacts, message.from);
    if (senderName && !normalized.text) {
      normalized.text = `[${message.type}] ${senderName}`;
    }

    if (normalized.text?.startsWith('/') && this.commandHandler) {
      const handled = await this.commandHandler(normalized).catch(() => false);
      if (handled) return;
    }
    this.messageHandler?.(normalized);
  }

  private forwardReaction(message: WAMessage): void {
    const emoji = message.reaction?.emoji ?? '';
    if (!emoji) return;
    const ipc = this.ipc();
    if (!ipc) return;
    void (async () => {
      let sessionId: string | null = null;
      try {
        const result = (await ipc.request('db:request', {
          action: 'gateway_user:getMapping',
          platform: 'whatsapp_cloud',
          chatId: message.from,
        })) as { sessionId?: string } | null;
        sessionId = result?.sessionId ?? null;
      } catch {
        sessionId = null;
      }
      ipc.send({
        type: 'gateway:reaction',
        sessionId: sessionId ?? '',
        platform: 'whatsapp_cloud',
        platformChatId: message.from,
        platformMsgId: message.reaction?.message_id ?? message.id,
        emoji,
        userId: message.from,
      });
    })();
  }

  private ipc(): { send: (msg: object) => void; request: (channel: string, data: object) => Promise<unknown> } | null {
    const getter = (this as unknown as {
      getIpcClient?: () => { send: (msg: object) => void; request: (channel: string, data: object) => Promise<unknown> };
    }).getIpcClient;
    return getter ? getter.call(this) : null;
  }

  private async downloadInboundMedia(message: WAMessage): Promise<{
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

    const ref = mediaRefOf(message);
    if (!ref?.id) return result;

    const media = await this.fetchMedia(ref, message.id);
    if (!media) return result;

    switch (media.category) {
      case 'image': result.imagePaths.push(media.path); break;
      case 'voice': result.voicePaths.push(media.path); break;
      case 'video': result.videoPaths.push(media.path); break;
      default: result.filePaths.push({ name: media.name, path: media.path }); break;
    }
    return result;
  }

  /** Two-step media read: resolve the id to a URL, then download with bearer. */
  private async fetchMedia(ref: WAMediaRef, messageId: string) {
    const maxBytes = this.mediaMaxMb * 1024 * 1024;
    try {
      const meta = await this.graph<{ url?: string; mime_type?: string; file_size?: number }>(
        `/${ref.id}`,
        'GET',
      );
      if (!meta?.url) return null;
      if (meta.file_size && meta.file_size > maxBytes) return null;

      return await fetchMediaToCache('whatsapp-cloud', meta.url, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
        maxBytes,
        mimeHint: ref.mime_type ?? meta.mime_type,
        ...(ref.filename ? { nameHint: ref.filename } : {}),
        idHint: messageId,
      });
    } catch (err) {
      this.updateHealthError(err);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Outbound
  // ---------------------------------------------------------------------------

  async sendReply(chatId: string, reply: NormalizedReply): Promise<SendResult> {
    try {
      switch (reply.type) {
        case 'text':
          return await this.sendText(chatId, reply.text, reply.replyToMsgId);

        case 'stream_start':
        case 'stream_chunk':
          // Cloud API has no draft streaming; the host sends one final text.
          return { ok: true };

        case 'stream_end':
          return await this.sendText(chatId, reply.finalText, reply.replyToMsgId);

        case 'permission_request': {
          const interactive = buildInteractivePayload(
            reply.text,
            reply.buttons.map((b) => ({ id: b.callbackData, title: b.text })),
          );
          return await this.sendInteractive(chatId, interactive, reply.replyToMsgId);
        }

        case 'inline_keyboard': {
          const flat = reply.rows.flat().map((b) => ({ id: b.callbackData, title: b.text }));
          const interactive = buildInteractivePayload(reply.text, flat);
          return await this.sendInteractive(chatId, interactive, reply.replyToMsgId);
        }

        case 'media':
          return await this.sendMedia(chatId, reply);

        case 'error':
          return await this.sendText(chatId, `⚠️ ${reply.message}`);

        default:
          return { ok: false, error: 'Unsupported reply type for WhatsApp Cloud' };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Typing indicator. Meta requires a recent inbound wamid; marks the message
   * as read in the same call. Best-effort: a stale wamid (131009) is ignored.
   */
  async sendTyping(chatId: string): Promise<void> {
    const messageId = this.lastInboundId.get(chatId);
    if (!messageId || !this.running) return;
    try {
      await this.graph(`/${this.phoneNumberId}/messages`, 'POST', {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' },
      });
    } catch {
      // Typing is cosmetic; never surface it to the turn.
    }
  }

  private async sendText(chatId: string, input: string, replyToMsgId?: string): Promise<SendResult> {
    const text = formatForWhatsApp(input ?? '');
    const chunks = splitForWhatsApp(text);
    if (chunks.length === 0) return { ok: false, error: 'empty message' };

    let lastId = '';
    for (let i = 0; i < chunks.length; i++) {
      await this.waitForRateLimit(chatId);
      const payload: WASendPayload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: chatId,
        type: 'text',
        text: { body: chunks[i], preview_url: false },
      };
      if (i === 0 && replyToMsgId) payload.context = { message_id: replyToMsgId };
      const result = await this.graph<{ messages?: Array<{ id: string }> }>(
        `/${this.phoneNumberId}/messages`,
        'POST',
        payload,
      );
      lastId = result?.messages?.[0]?.id ?? lastId;
      this.recordSendTime(chatId);
    }
    return { ok: true, platformMsgId: lastId };
  }

  private async sendInteractive(
    chatId: string,
    interactive: Record<string, unknown>,
    replyToMsgId?: string,
  ): Promise<SendResult> {
    await this.waitForRateLimit(chatId);
    const payload: WASendPayload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: chatId,
      type: 'interactive',
      interactive,
      ...(replyToMsgId ? { context: { message_id: replyToMsgId } } : {}),
    };
    const result = await this.graph<{ messages?: Array<{ id: string }> }>(
      `/${this.phoneNumberId}/messages`,
      'POST',
      payload,
    );
    this.recordSendTime(chatId);
    return { ok: true, platformMsgId: result?.messages?.[0]?.id };
  }

  private async sendMedia(chatId: string, reply: MediaReply): Promise<SendResult> {
    const kind: 'image' | 'video' | 'audio' | 'document' =
      reply.mediaType === 'photo' ? 'image'
        : reply.mediaType === 'video' ? 'video'
          : reply.mediaType === 'voice' ? 'audio'
            : 'document';

    const isUrl = /^https?:\/\//i.test(reply.filePath);
    const media: Record<string, unknown> = {};

    if (isUrl) {
      media.link = reply.filePath;
    } else {
      const mediaId = await this.uploadMedia(reply.filePath, kind);
      if (!mediaId) return { ok: false, error: 'media upload failed' };
      media.id = mediaId;
    }

    if (kind !== 'audio' && reply.caption) {
      media.caption = formatForWhatsApp(reply.caption).slice(0, 1024);
    }
    if (kind === 'document') {
      media.filename = path.basename(reply.filePath);
    }

    await this.waitForRateLimit(chatId);
    const payload: WASendPayload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: chatId,
      type: kind,
      [kind]: media,
      ...(reply.replyToMsgId ? { context: { message_id: reply.replyToMsgId } } : {}),
    };
    const result = await this.graph<{ messages?: Array<{ id: string }> }>(
      `/${this.phoneNumberId}/messages`,
      'POST',
      payload,
    );
    this.recordSendTime(chatId);
    return { ok: true, platformMsgId: result?.messages?.[0]?.id };
  }

  /** Upload a local file to Meta and return its media id. */
  private async uploadMedia(filePath: string, kind: 'image' | 'video' | 'audio' | 'document'): Promise<string | null> {
    const { readFile, stat } = await import('node:fs/promises');
    try {
      const info = await stat(filePath);
      const limitMb = MEDIA_LIMITS_MB[kind];
      if (info.size > limitMb * 1024 * 1024) return null;

      const data = await readFile(filePath);
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('file', new Blob([new Uint8Array(data)]), path.basename(filePath));

      const response = await proxyFetch(`${GRAPH_BASE}/${this.apiVersion}/${this.phoneNumberId}/media`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.accessToken}` },
        body: form,
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { id?: string };
      return body.id ?? null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Graph transport
  // ---------------------------------------------------------------------------

  private async graph<T = unknown>(
    pathname: string,
    method: string,
    body?: unknown,
  ): Promise<T> {
    const response = await proxyFetch(`${GRAPH_BASE}/${this.apiVersion}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      const error = parsed as { error?: { message?: string; code?: number } } | undefined;
      const detail = error?.error?.message ?? `HTTP ${response.status}`;
      const code = error?.error?.code ?? response.status;
      throw new Error(`WhatsApp Cloud API error (${code}): ${detail}`);
    }

    return parsed as T;
  }
}

new WhatsAppCloudAdapter();
