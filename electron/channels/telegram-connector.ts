/**
 * telegram-connector.ts — inbound Telegram connector (plan 488 P6, grok-form).
 *
 * One connector instance per (bot, platform) binding: long-polls the Telegram
 * Bot API `getUpdates` with the BOT'S OWN token and turns each message into a
 * `ChannelInboundEnvelope` handed to the wake pipeline, which runs a hidden
 * `[inbound]` turn in that bot's persistent session (`bot:<agentId>`).
 *
 * Long polling (no webhook) keeps the connector dependency-free and works
 * behind NAT — the same tradeoff grok-bot's desktop host makes.
 *
 * Media messages (photo/document/video/voice/audio/sticker, plan 507 P2.5)
 * are downloaded via getFile + the file endpoint and persisted to the stable
 * attachment store. All documents — including small .md/.txt — are treated as
 * uploaded files (this per-bot connector does not inject text content; the
 * deep gateway adapter owns that behaviour). No extension whitelist — the bot
 * has a tool chain, so xlsx/pdf/etc. are all accepted; only a size cap applies.
 */

import * as path from 'node:path';

import type {
  ChannelInboundAttachment,
  ChannelInboundEnvelope,
} from '../../packages/agent/src/channels/types';
import { getLogger, LogComponent } from '../logging/logger';
import { persistInboundAttachment } from './attachment-store';

const logger = getLogger();

const TELEGRAM_API_BASE = 'https://api.telegram.org';
/**
 * Bot API cloud download cap via getFile. A local Bot API server (which lifts
 * the cap to ~2GB) is not supported on the connector path, so files above
 * this size are skipped before getFile is even called.
 */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

interface TelegramPhotoSize {
  file_id: string;
  file_size?: number;
  width: number;
  height: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    /** Caption accompanying a media message (Bot API). */
    caption?: string;
    from?: { username?: string; first_name?: string };
    chat?: { id?: number | string };
    photo?: TelegramPhotoSize[];
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
    video?: { file_id: string; file_size?: number };
    voice?: { file_id: string; file_size?: number };
    audio?: { file_id: string; file_name?: string; file_size?: number };
    sticker?: { file_id: string; file_size?: number };
  };
}

/** The one media entry a message carries, normalized for the download flow. */
interface MediaPick {
  fileId: string;
  /** Platform-reported size, when present. */
  fileSize?: number;
  /** Explicit original file name, when the platform sends one. */
  fileName?: string;
  /** Base name used when no explicit file name exists ('photo', 'document'). */
  baseName: string;
  /** Extension used when neither an explicit name nor file_path carries one. */
  defaultExt: string;
}

/** Result of the media download + persist flow for a single message. */
interface MediaOutcome {
  /** Persisted attachment record, when the copy landed. */
  attachment?: ChannelInboundAttachment;
  /** Skip note appended to the message text (e.g. too large, download failed). */
  skippedNote?: string;
}

export interface TelegramConnectorOptions {
  agentId: string;
  /** The bot's own token (from the per-agent connector-secret store). */
  token: string;
  onInbound: (agentId: string, envelope: ChannelInboundEnvelope) => void;
  /** Injectable fetch for tests. Defaults to globalThis.fetch. */
  fetchFn?: typeof fetch;
  /** Telegram long-poll timeout in seconds. */
  pollTimeoutSec?: number;
  /** Sleep after a failed poll before retrying. */
  errorBackoffMs?: number;
}

export class TelegramChannelConnector {
  private readonly opts: Required<Pick<TelegramConnectorOptions, 'agentId' | 'token' | 'onInbound'>> &
    TelegramConnectorOptions;
  private running = false;
  private offset = 0;
  private loopPromise: Promise<void> | null = null;
  private abortController: AbortController | null = null;

  constructor(opts: TelegramConnectorOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
    if (this.loopPromise) {
      await this.loopPromise.catch(() => undefined);
      this.loopPromise = null;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  private async runLoop(): Promise<void> {
    const backoffMs = this.opts.errorBackoffMs ?? 5_000;
    while (this.running) {
      this.abortController = new AbortController();
      try {
        const updates = await this.getUpdates(
          this.abortController.signal,
          this.opts.pollTimeoutSec ?? 25,
        );
        for (const update of updates) {
          // Advance the offset before (possibly async) handling so a slow
          // media download can never cause a re-fetch of the same update.
          this.offset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (err) {
        if (!this.running || this.abortController.signal.aborted) break;
        logger.warn(
          `Telegram connector poll failed, backing off: ${err instanceof Error ? err.message : String(err)}`,
          { agentId: this.opts.agentId, backoffMs },
          LogComponent.Gateway,
        );
        await this.sleep(backoffMs);
      }
      // Yield to the macrotask queue. Long polling against a stubbed or very
      // fast endpoint otherwise resolves purely in microtasks and starves
      // timers (stop() would never run).
      await this.sleep(0);
    }
  }

  private async getUpdates(signal: AbortSignal, timeoutSec: number): Promise<TelegramUpdate[]> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const url =
      `${TELEGRAM_API_BASE}/bot${this.opts.token}/getUpdates` +
      `?offset=${this.offset}&timeout=${timeoutSec}&allowed_updates=%5B%22message%22%5D`;
    const res = await fetchFn(url, { signal });
    if (!res.ok) {
      throw new Error(`Telegram getUpdates failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { ok?: boolean; result?: TelegramUpdate[] };
    if (!body.ok || !Array.isArray(body.result)) {
      throw new Error('Telegram getUpdates returned a non-ok payload');
    }
    return body.result;
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const msg = update.message;
    if (!msg || msg.chat?.id === undefined) return;

    const media = this.pickMedia(msg);
    let text = msg.text ?? msg.caption ?? '';
    // Route text messages as before; route media messages even when the
    // caption is empty (the attachments carry the payload).
    if (!text && !media) return;

    const attachments: ChannelInboundAttachment[] = [];
    if (media) {
      const outcome = await this.downloadMediaAttachment(media);
      if (outcome.attachment) attachments.push(outcome.attachment);
      if (outcome.skippedNote) {
        text = text ? `${text}\n${outcome.skippedNote}` : outcome.skippedNote;
      }
    }

    const envelope: ChannelInboundEnvelope = {
      address: { platform: 'telegram', chat: String(msg.chat.id) },
      sender: msg.from?.username ?? msg.from?.first_name ?? 'unknown',
      text,
      reaction: null,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
    logger.info('Telegram connector: inbound message', {
      agentId: this.opts.agentId,
      chat: envelope.address.chat,
      sender: envelope.sender,
    }, LogComponent.Gateway);
    this.opts.onInbound(this.opts.agentId, envelope);
  }

  /**
   * Pick the single media entry a message carries. Telegram sends one media
   * per message; precedence document > photo > video > voice > audio follows
   * the deep adapter's download order. Photos arrive as ascending sizes —
   * pick the largest.
   */
  private pickMedia(msg: NonNullable<TelegramUpdate['message']>): MediaPick | null {
    if (msg.document) {
      return {
        fileId: msg.document.file_id,
        fileSize: msg.document.file_size,
        fileName: msg.document.file_name,
        baseName: 'document',
        defaultExt: '',
      };
    }
    if (msg.photo?.length) {
      const largest = msg.photo.reduce((best, cur) =>
        cur.width * cur.height > best.width * best.height ? cur : best,
      );
      return {
        fileId: largest.file_id,
        fileSize: largest.file_size,
        baseName: 'photo',
        defaultExt: '.jpg',
      };
    }
    if (msg.video) {
      return {
        fileId: msg.video.file_id,
        fileSize: msg.video.file_size,
        baseName: 'video',
        defaultExt: '.mp4',
      };
    }
    if (msg.voice) {
      return {
        fileId: msg.voice.file_id,
        fileSize: msg.voice.file_size,
        baseName: 'voice',
        defaultExt: '.ogg',
      };
    }
    if (msg.audio) {
      return {
        fileId: msg.audio.file_id,
        fileSize: msg.audio.file_size,
        fileName: msg.audio.file_name,
        baseName: 'audio',
        defaultExt: '.mp3',
      };
    }
    if (msg.sticker) {
      return {
        fileId: msg.sticker.file_id,
        fileSize: msg.sticker.file_size,
        baseName: 'sticker',
        defaultExt: '.webp',
      };
    }
    return null;
  }

  /**
   * Download one media entry (getFile → file endpoint) and persist it to the
   * stable attachment store. Expected failures (oversize, HTTP errors) never
   * throw — they come back as a skipped note so the message still routes.
   */
  private async downloadMediaAttachment(pick: MediaPick): Promise<MediaOutcome> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const skipName = pick.fileName ?? `${pick.baseName}${pick.defaultExt}`;

    // Early guard: do not even call getFile for files the Bot API cannot serve.
    if (pick.fileSize !== undefined && pick.fileSize > MAX_DOWNLOAD_BYTES) {
      return { skippedNote: `[attachment skipped: ${skipName} exceeds the 20 MB download limit]` };
    }

    let filePath: string | undefined;
    let serverSize: number | undefined;
    try {
      const res = await fetchFn(
        `${TELEGRAM_API_BASE}/bot${this.opts.token}/getFile?file_id=${encodeURIComponent(pick.fileId)}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        ok?: boolean;
        result?: { file_path?: string; file_size?: number };
      };
      if (!body.ok || !body.result) throw new Error('non-ok getFile payload');
      filePath = body.result.file_path;
      serverSize = body.result.file_size;
    } catch {
      return { skippedNote: `[attachment skipped: ${skipName} download failed]` };
    }

    if (!filePath) {
      return { skippedNote: `[attachment skipped: ${skipName} download failed]` };
    }
    if (serverSize !== undefined && serverSize > MAX_DOWNLOAD_BYTES) {
      return { skippedNote: `[attachment skipped: ${skipName} exceeds the 20 MB download limit]` };
    }

    let buffer: Buffer;
    try {
      const res = await fetchFn(
        `${TELEGRAM_API_BASE}/file/bot${this.opts.token}/${filePath}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buffer = Buffer.from(await res.arrayBuffer());
    } catch {
      return { skippedNote: `[attachment skipped: ${skipName} download failed]` };
    }

    const pathExt = path.extname(filePath).toLowerCase();
    const name = pick.fileName ?? `${pick.baseName}${pathExt || pick.defaultExt}`;

    const result = await persistInboundAttachment(
      this.opts.agentId,
      'telegram',
      { kind: 'buffer', buffer },
      name,
    );
    if (result.attachment) return { attachment: result.attachment };
    return { skippedNote: `[attachment skipped: ${result.skippedReason}]` };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
