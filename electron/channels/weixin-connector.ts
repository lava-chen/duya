/**
 * weixin-connector.ts — inbound WeChat connector for a single bot (plan 488,
 * grok-form). Reuses the deep gateway `WeixinAdapter` class directly instead of
 * re-writing the iLink long-poll / CDN media / context_token / rate-limit code.
 *
 * After the `wxApi` instance-level refactor, each connector owns its own
 * `WeixinAdapter` + `WxApiClient`, so multiple WeChat bots can coexist in one
 * process. Inbound `onMessage` is mapped to a `ChannelInboundEnvelope` for the
 * wake pipeline; outbound goes through the SAME adapter's `sendReply` (inherits
 * chunk-splitting, context_token session continuity, rate-limit circuit).
 *
 * Media the adapter already downloaded to its temp cache (imagePaths /
 * voicePaths / filePaths / videoPaths) is persisted to the stable attachment
 * store (plan 507 P2.3) and rides the envelope as `attachments`; entries the
 * store skipped surface as `[attachment skipped: ...]` notes in the text.
 */

import * as path from 'node:path';

import type {
  ChannelInboundAttachment,
  ChannelInboundEnvelope,
} from '../../packages/agent/src/channels/types';
import { getLogger, LogComponent } from '../logging/logger';
import {
  WeixinAdapter,
} from './gateway-adapters';
import type { NormalizedMessage, PlatformConfig } from './gateway-adapters';
import { persistInboundAttachments } from './attachment-store';
import type { AttachmentSource } from './attachment-store';
import { getConnectorCredential } from './agent-session-channels';
import { getSharedAgentsRoot } from '../config/agent-paths';

const logger = getLogger();

export interface WeixinConnectorOptions {
  agentId: string;
  onInbound: (agentId: string, envelope: ChannelInboundEnvelope) => void;
  /** Injectable client factory for tests (defaults to WeixinAdapter). */
  createAdapter?: () => WeixinAdapter;
}

/** Resolve the per-agent state directory so each WeChat bot persists its own
 * context_token/sync_buf without colliding with other bots or the gateway.
 * Shared root (plan 526): `~/.duya/agents/<agentId>/gateway/weixin`. */
function resolveAgentStateDir(agentId: string): string {
  return path.join(getSharedAgentsRoot(), agentId, 'gateway', 'weixin');
}

/**
 * Per-bot WeChat connector. Owns a `WeixinAdapter` (iLink long-poll) and hands
 * every inbound message to the wake pipeline as a `ChannelInboundEnvelope`.
 */
export class WeixinConnector {
  private readonly agentId: string;
  private readonly onInbound: (agentId: string, envelope: ChannelInboundEnvelope) => void;
  private adapter: WeixinAdapter | null = null;
  private running = false;

  constructor(opts: WeixinConnectorOptions) {
    this.agentId = opts.agentId;
    this.onInbound = opts.onInbound;
  }

  get platform(): string {
    return 'weixin';
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** The live WeChat adapter — outbound uses its `sendReply` (same instance). */
  getAdapter(): WeixinAdapter {
    if (!this.adapter) {
      throw new Error('WeixinConnector: adapter not started yet');
    }
    return this.adapter;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.doStart();
  }

  private async doStart(): Promise<void> {
    const botToken = getConnectorCredential(this.agentId, 'weixin', 'botToken');
    const ilinkBotId = getConnectorCredential(this.agentId, 'weixin', 'ilinkBotId');
    if (!botToken) {
      logger.warn('Weixin connector: missing botToken credential, not starting', {
        agentId: this.agentId,
      }, LogComponent.Gateway);
      this.running = false;
      return;
    }

    const adapter = new WeixinAdapter({ stateDir: resolveAgentStateDir(this.agentId) });
    adapter.onMessage((msg) => {
      // The Weixin adapter invokes its message handler without awaiting it
      // (BaseAdapter keeps a void-returning callback), so attachment
      // persistence is fire-and-forget from the adapter's perspective. Route
      // only after the copies land so attachments ride the same envelope, and
      // swallow rejections so a failed copy never surfaces as an unhandled
      // rejection inside the adapter's poll loop.
      void this.handleInbound(msg).catch((err) => {
        logger.error(
          'Weixin connector: failed to handle inbound message',
          err instanceof Error ? err : new Error(String(err)),
          { agentId: this.agentId },
          LogComponent.Gateway,
        );
      });
    });
    this.adapter = adapter;

    const credentials: Record<string, string> = {};
    if (botToken) credentials.botToken = botToken;
    if (ilinkBotId) credentials.ilinkBotId = ilinkBotId;

    try {
      await adapter.start({ platform: 'weixin', credentials } satisfies PlatformConfig);
      logger.info('Weixin connector started', { agentId: this.agentId }, LogComponent.Gateway);
    } catch (err) {
      this.running = false;
      logger.error(
        'Weixin connector failed to start',
        err instanceof Error ? err : new Error(String(err)),
        { agentId: this.agentId },
        LogComponent.Gateway,
      );
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.adapter) {
      await this.adapter.stop();
      this.adapter = null;
    }
  }

  private inbound(envelope: ChannelInboundEnvelope): void {
    logger.info('Weixin connector: inbound message', {
      agentId: this.agentId,
      chat: envelope.address.chat,
      sender: envelope.sender,
    }, LogComponent.Gateway);
    this.onInbound(this.agentId, envelope);
  }

  /**
   * Persist the adapter's temp-cache media to the stable attachment store,
   * then route the envelope (text + attachments + skipped notes) to the wake
   * pipeline. Called fire-and-forget from onMessage — must never reject.
   */
  private async handleInbound(msg: NormalizedMessage): Promise<void> {
    const entries: Array<{ source: AttachmentSource; name: string }> = [];
    for (const file of msg.filePaths ?? []) {
      entries.push({ source: { kind: 'path', path: file.path }, name: file.name });
    }
    for (const imagePath of msg.imagePaths ?? []) {
      entries.push({
        source: { kind: 'path', path: imagePath },
        name: `photo${cacheExt(imagePath, '.jpg')}`,
      });
    }
    for (const voicePath of msg.voicePaths ?? []) {
      entries.push({
        source: { kind: 'path', path: voicePath },
        name: `voice${cacheExt(voicePath, '.mp3')}`,
      });
    }
    for (const videoPath of msg.videoPaths ?? []) {
      entries.push({
        source: { kind: 'path', path: videoPath },
        name: `video${cacheExt(videoPath, '.mp4')}`,
      });
    }

    let text = msg.text ?? '';
    let attachments: ChannelInboundAttachment[] | undefined;

    if (entries.length > 0) {
      const results = await persistInboundAttachments(this.agentId, 'weixin', entries);
      const persisted: ChannelInboundAttachment[] = [];
      const skippedNotes: string[] = [];
      for (const result of results) {
        if (result.attachment) {
          persisted.push(result.attachment);
        } else {
          skippedNotes.push(`[attachment skipped: ${result.skippedReason}]`);
        }
      }
      if (persisted.length > 0) attachments = persisted;
      if (skippedNotes.length > 0) {
        const notes = skippedNotes.join('\n');
        text = text ? `${text}\n${notes}` : notes;
      }
    }

    this.inbound({
      address: { platform: 'weixin', chat: msg.platformChatId },
      sender: msg.platformUserId,
      text,
      reaction: null,
      ...(attachments ? { attachments } : {}),
    });
  }
}

/**
 * Extension (with dot) derived from an adapter cache path, falling back to the
 * format the Weixin adapter downloads that media kind as (voice is cached as
 * MP3, images as JPEG, videos as MP4).
 */
function cacheExt(cachePath: string, fallback: string): string {
  const ext = path.extname(cachePath).toLowerCase();
  return ext || fallback;
}