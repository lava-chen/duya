/**
 * Signal adapter — `signal-cli` HTTP daemon (JSON-RPC 2.0 + SSE).
 *
 * Why the daemon and not an SDK: signal-cli owns the encryption/session state
 * for one registered phone number, so the gateway only needs two channels:
 * - outbound: `POST /api/v1/rpc` JSON-RPC calls (`send`, `sendTyping`,
 *   `sendReaction`),
 * - inbound: `GET /api/v1/events?account=…` server-sent events.
 *
 * Platform behaviours encoded here:
 * - one instance per phone number: two adapters on the same account would fight
 *   over the daemon's receive queue (the daemon does not multiplex),
 * - `textStyle` offsets are UTF-16 code units, computed in `format.ts`,
 * - the server rate limit is a token bucket; `rate-limit.ts` mirrors it and
 *   recalibrates on a real 429,
 * - a message timestamp identifies an inbound message for quotes and reactions,
 *   so reactions must be answered against the last inbound (author, timestamp).
 */

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
import { cacheMediaBytes, readMediaSource } from '../shared/media-cache.js';
import { markdownToSignal, splitSignalMessage } from './format.js';
import { TokenBucket, tokenCostForAttachments } from './rate-limit.js';

const CHAT_RATE_LIMIT_MS = 1000;
const SSE_BASE_DELAY_MS = 2000;
const SSE_MAX_DELAY_MS = 60_000;
const MAX_MESSAGE_LENGTH = 8000;

interface SignalAccountOptions {
  dm_policy?: 'open' | 'allowlist' | 'pairing' | 'disabled';
  allow_from?: string[];
  group_policy?: 'open' | 'allowlist' | 'pairing' | 'disabled';
  group_allow_from?: string[];
  require_mention?: boolean;
  mention_patterns?: string[];
  free_response_chats?: string[];
  attachment_max_mb?: number;
}

interface SignalAttachment {
  id?: string;
  contentType?: string;
  filename?: string;
  size?: number;
}

interface SignalDataMessage {
  timestamp?: number;
  message?: string;
  attachments?: SignalAttachment[];
  quote?: { id?: number; text?: string; author?: string };
  groupInfo?: { groupId?: string; groupName?: string };
}

interface SignalEnvelope {
  source?: string;
  sourceNumber?: string;
  sourceName?: string;
  timestamp?: number;
  dataMessage?: SignalDataMessage;
  reaction?: { emoji?: string; targetAuthor?: string; targetSentTimestamp?: number; isRemove?: boolean; targetAuthorNumber?: string };
  typingMessage?: { action?: string };
  receiptMessage?: unknown;
}

interface SignalRpcError {
  code?: number;
  message?: string;
  data?: { response?: { body?: string } };
}

export class SignalAdapter extends BaseAdapter {
  readonly platform = 'signal' as const;

  private httpUrl = '';
  private account = '';
  private gating: GatingOptions = parseGatingOptions();
  private attachmentMaxMb = 100;

  private rpcSeq = 0;
  private readonly bucket = new TokenBucket();
  private readonly seen = new BoundedIdSet({ capacity: 2000, ttlMs: 10 * 60_000 });
  /** Last inbound (author, timestamp) per chat — the target of a reaction. */
  private lastInbound = new Map<string, { author: string; timestamp: number }>();

  private sseAbort: AbortController | null = null;
  private sseLoop: Promise<void> | null = null;

  constructor() {
    super({ rateLimitMs: CHAT_RATE_LIMIT_MS, maxRetries: 2 });
    registerAdapterFactory('signal', () => new SignalAdapter());
  }

  async start(config: PlatformConfig): Promise<void> {
    if (this.running) return;

    this.httpUrl = (config.credentials['http_url'] ?? '').trim().replace(/\/+$/, '');
    this.account = (config.credentials['account'] ?? '').trim();
    if (!this.httpUrl || !this.account) {
      throw new Error('Signal requires `http_url` and `account` credentials');
    }

    const options = (config.options ?? {}) as SignalAccountOptions;
    this.gating = parseGatingOptions(config.options);
    this.attachmentMaxMb = Math.max(1, options.attachment_max_mb ?? 100);
    this.config = config;

    // Fail fast on a daemon that is not reachable / not registered: a silent
    // adapters that never receives anything is worse than a startup error.
    await this.rpc('listAccounts', {}).catch((err) => {
      throw new Error(`signal-cli daemon unreachable at ${this.httpUrl}: ${err instanceof Error ? err.message : String(err)}`);
    });

    this.running = true;
    this.updateHealthConnected();
    this.setBotUsername(this.account);
    this.sseLoop = this.consumeEvents();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.health.connected = false;
    this.sseAbort?.abort();
    this.sseAbort = null;
    await this.sseLoop?.catch(() => undefined);
    this.sseLoop = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  // ---------------------------------------------------------------------------
  // Inbound: SSE stream
  // ---------------------------------------------------------------------------

  private async consumeEvents(): Promise<void> {
    let delay = SSE_BASE_DELAY_MS;

    while (this.running) {
      const controller = new AbortController();
      this.sseAbort = controller;
      try {
        const url = `${this.httpUrl}/api/v1/events?account=${encodeURIComponent(this.account)}`;
        const response = await proxyFetch(url, {
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`SSE handshake failed: HTTP ${response.status}`);
        }

        this.updateHealthConnected();
        delay = SSE_BASE_DELAY_MS;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            this.handleFrame(frame);
            boundary = buffer.indexOf('\n\n');
          }
        }
      } catch (err) {
        if (!this.running) return;
        this.updateHealthError(err);
      }

      if (!this.running) return;
      // Jittered backoff: a daemon restart must not produce a thundering herd.
      const jittered = delay * (0.8 + Math.random() * 0.4);
      await new Promise((resolve) => setTimeout(resolve, jittered));
      delay = Math.min(Math.round(delay * 1.6), SSE_MAX_DELAY_MS);
    }
  }

  private handleFrame(frame: string): void {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;

    let envelope: SignalEnvelope;
    try {
      envelope = JSON.parse(data) as SignalEnvelope;
    } catch {
      return;
    }

    void this.handleEnvelope(envelope).catch((err) => this.updateHealthError(err));
  }

  private async handleEnvelope(envelope: SignalEnvelope): Promise<void> {
    const sender = envelope.sourceNumber ?? envelope.source ?? '';
    if (!sender) return;
    if (envelope.reaction?.emoji) {
      this.forwardReaction(envelope, sender);
      return;
    }
    if (!envelope.dataMessage) return;

    const data = envelope.dataMessage;
    const groupId = data.groupInfo?.groupId;
    const isGroup = Boolean(groupId);
    const chatId = groupId ?? sender;
    const timestamp = data.timestamp ?? envelope.timestamp ?? Date.now();

    const dedupKey = `${sender}:${chatId}:${timestamp}`;
    if (!this.seen.add(dedupKey)) return;

    const text = data.message ?? '';
    const accountBare = this.account.replace(/^\+/, '');

    const verdict = evaluateGating(this.gating, {
      senderId: sender,
      chatId,
      isGroup,
      text,
      botMentioned: Boolean(accountBare && text.includes(accountBare)),
    });
    if (verdict === 'deny') return;

    this.incrementMessageCount();
    this.lastInbound.set(chatId, { author: sender, timestamp });

    const media = await this.downloadAttachments(data.attachments ?? [], String(timestamp));

    const normalized: NormalizedMessage = {
      platform: 'signal',
      platformUserId: sender,
      platformChatId: chatId,
      platformMsgId: String(timestamp),
      ...(text ? { text } : {}),
      ...(media.imagePaths.length ? { imagePaths: media.imagePaths } : {}),
      ...(media.voicePaths.length ? { voicePaths: media.voicePaths } : {}),
      ...(media.videoPaths.length ? { videoPaths: media.videoPaths } : {}),
      ...(media.filePaths.length ? { filePaths: media.filePaths } : {}),
      ...(data.quote?.id ? { replyToMsgId: String(data.quote.id) } : {}),
      ...(data.quote?.text ? { replyToText: data.quote.text } : {}),
      ts: timestamp,
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

  private forwardReaction(envelope: SignalEnvelope, sender: string): void {
    const emoji = envelope.reaction?.emoji ?? '';
    if (!emoji || envelope.reaction?.isRemove) return;
    const ipc = this.ipc();
    if (!ipc) return;
    const chatId = envelope.sourceNumber ?? envelope.source ?? sender;
    void (async () => {
      let sessionId: string | null = null;
      try {
        const result = (await ipc.request('db:request', {
          action: 'gateway_user:getMapping',
          platform: 'signal',
          chatId,
        })) as { sessionId?: string } | null;
        sessionId = result?.sessionId ?? null;
      } catch {
        sessionId = null;
      }
      ipc.send({
        type: 'gateway:reaction',
        sessionId: sessionId ?? '',
        platform: 'signal',
        platformChatId: chatId,
        platformMsgId: String(envelope.reaction?.targetSentTimestamp ?? ''),
        emoji,
        userId: sender,
      });
    })();
  }

  private ipc(): { send: (msg: object) => void; request: (channel: string, data: object) => Promise<unknown> } | null {
    const getter = (this as unknown as {
      getIpcClient?: () => { send: (msg: object) => void; request: (channel: string, data: object) => Promise<unknown> };
    }).getIpcClient;
    return getter ? getter.call(this) : null;
  }

  private async downloadAttachments(
    attachments: SignalAttachment[],
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
    const maxBytes = this.attachmentMaxMb * 1024 * 1024;

    for (const attachment of attachments) {
      if (!attachment.id) continue;
      try {
        const response = await proxyFetch(`${this.httpUrl}/api/v1/attachments/${attachment.id}`, {
          headers: { Accept: '*/*' },
        });
        if (!response.ok) continue;
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > maxBytes) continue;

        const mime = attachment.contentType ?? 'application/octet-stream';
        const cached = cacheMediaBytes('signal', buffer, mime, {
          ...(attachment.filename ? { nameHint: attachment.filename } : {}),
          idHint: `${messageId}-${attachment.id}`,
        });

        switch (cached.category) {
          case 'image': result.imagePaths.push(cached.path); break;
          case 'voice': result.voicePaths.push(cached.path); break;
          case 'video': result.videoPaths.push(cached.path); break;
          default: result.filePaths.push({ name: cached.name, path: cached.path }); break;
        }
      } catch {
        // A single unreadable attachment must not drop the message.
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
          const lines = [reply.text, '', ...reply.buttons.map((b) => `• ${b.text} (${b.callbackData})`)];
          return await this.sendText(chatId, lines.join('\n'));
        }

        case 'inline_keyboard': {
          const lines = [reply.text, '', ...reply.rows.flat().map((b) => `• ${b.text} (${b.callbackData})`)];
          return await this.sendText(chatId, lines.join('\n'));
        }

        case 'media':
          return await this.sendMedia(chatId, reply);

        case 'error':
          return await this.sendText(chatId, `⚠️ ${reply.message}`);

        default:
          return { ok: false, error: 'Unsupported reply type for Signal' };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    if (!this.running) return;
    try {
      await this.rpc('sendTyping', { account: this.account, recipient: [chatId] });
    } catch {
      // Cosmetic only.
    }
  }

  /** Emoji reaction on the last inbound message of this chat. */
  async setMessageReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    const target = this.lastInbound.get(chatId);
    const timestamp = Number(messageId) || target?.timestamp;
    if (!timestamp) return;
    try {
      await this.rpc('sendReaction', {
        account: this.account,
        emoji,
        targetAuthor: target?.author ?? chatId,
        targetTimestamp: timestamp,
        recipient: [chatId],
      });
    } catch {
      // Reactions are best-effort.
    }
  }

  private async sendText(chatId: string, input: string): Promise<SendResult> {
    const chunks = splitSignalMessage(input ?? '', MAX_MESSAGE_LENGTH);
    if (chunks.length === 0) return { ok: false, error: 'empty message' };

    let lastTimestamp: number | undefined;
    for (const chunk of chunks) {
      await this.waitForRateLimit(chatId);
      await this.bucket.acquire(1);
      const result = await this.rpc<{ timestamp?: number }>('send', {
        account: this.account,
        recipient: [chatId],
        message: chunk.text,
        ...(chunk.textStyle.length ? { textStyle: chunk.textStyle } : {}),
      });
      lastTimestamp = result?.timestamp ?? lastTimestamp;
      this.recordSendTime(chatId);
    }

    return { ok: true, ...(lastTimestamp ? { platformMsgId: String(lastTimestamp) } : {}) };
  }

  private async sendMedia(chatId: string, reply: MediaReply): Promise<SendResult> {
    const buffer = await readMediaSource(reply.filePath, this.attachmentMaxMb * 1024 * 1024);
    if (!buffer) return { ok: false, error: 'media source unreadable or too large' };

    const mime = guessMime(reply.filePath);
    const dataUri = `data:${mime};base64,${buffer.toString('base64')}`;
    const caption = reply.caption ? markdownToSignal(reply.caption) : null;

    await this.waitForRateLimit(chatId);
    await this.bucket.acquire(tokenCostForAttachments(1));
    const result = await this.rpc<{ timestamp?: number }>('send', {
      account: this.account,
      recipient: [chatId],
      ...(caption ? { message: caption.text, ...(caption.textStyle.length ? { textStyle: caption.textStyle } : {}) } : {}),
      base64_attachments: [dataUri],
    });
    this.recordSendTime(chatId);
    return { ok: true, ...(result?.timestamp ? { platformMsgId: String(result.timestamp) } : {}) };
  }

  // ---------------------------------------------------------------------------
  // JSON-RPC transport
  // ---------------------------------------------------------------------------

  private async rpc<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    this.rpcSeq += 1;
    const response = await proxyFetch(`${this.httpUrl}/api/v1/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: `duya-${this.rpcSeq}`, method, params }),
    });

    const text = await response.text();
    let body: { result?: T; error?: SignalRpcError } | undefined;
    try {
      body = text ? (JSON.parse(text) as { result?: T; error?: SignalRpcError }) : undefined;
    } catch {
      body = undefined;
    }

    if (body?.error) {
      const message = body.error.message ?? 'unknown error';
      const retryAfter = parseRetryAfter(message);
      if (body.error.code === -5 || /429|rate limit/i.test(message)) {
        this.bucket.feedback(retryAfter ?? 10, 1);
      }
      throw new Error(`signal-cli ${method} failed: ${message}`);
    }

    if (!response.ok) {
      throw new Error(`signal-cli ${method} failed: HTTP ${response.status}`);
    }

    return body?.result as T;
  }
}

function parseRetryAfter(message: string): number | null {
  const match = message.match(/retry after (\d+)/i);
  return match ? Number(match[1]) : null;
}

function guessMime(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
  };
  return map[ext] ?? 'application/octet-stream';
}

new SignalAdapter();
