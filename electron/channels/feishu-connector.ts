/**
 * feishu-connector.ts — inbound Feishu connector for a single bot (plan 488,
 * grok-form). Reuses the deep gateway `FeishuChannel` class directly instead of
 * re-writing the Feishu WebSocket/webhook protocol: heartbeat/reconnect,
 * dedup, text/media batching, stream cards and DM pairing all stay inside the
 * channel. This glue layer only wires per-bot credentials in, maps inbound
 * callbacks to `ChannelInboundEnvelope`s for the wake pipeline, and re-exposes
 * the channel for outbound via the SAME live instance (`sendReply`).
 */

import type { ChannelInboundEnvelope } from '../../packages/agent/src/channels/types';
import { getLogger, LogComponent } from '../logging/logger';
import {
  FeishuChannel,
  createFeishuChannel,
} from './gateway-adapters';
import type { FeishuAdapterOptions, FeishuConfig } from './gateway-adapters';
import { getConnectorCredential } from './agent-session-channels';

const logger = getLogger();

export interface FeishuConnectorOptions {
  agentId: string;
  onInbound: (agentId: string, envelope: ChannelInboundEnvelope) => void;
}

/**
 * Per-bot Feishu connector. Owns a `FeishuChannel` (WebSocket gateway by
 * default) and hands every inbound message/reaction to the wake pipeline as a
 * `ChannelInboundEnvelope`.
 */
export class FeishuChannelConnector {
  private readonly agentId: string;
  private readonly onInbound: (agentId: string, envelope: ChannelInboundEnvelope) => void;
  private channel: FeishuChannel | null = null;
  private running = false;

  constructor(opts: FeishuConnectorOptions) {
    this.agentId = opts.agentId;
    this.onInbound = opts.onInbound;
  }

  get platform(): string {
    return 'feishu';
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** The live Feishu channel — outbound uses its `sendReply` (same instance). */
  getChannel(): FeishuChannel {
    if (!this.channel) {
      throw new Error('FeishuChannelConnector: channel not started yet');
    }
    return this.channel;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.doStart();
  }

  private async doStart(): Promise<void> {
    const appId = getConnectorCredential(this.agentId, 'feishu', 'appId');
    const appSecret = getConnectorCredential(this.agentId, 'feishu', 'appSecret');
    if (!appId || !appSecret) {
      logger.warn(
        'Feishu connector: missing appId/appSecret credentials, not starting',
        { agentId: this.agentId },
        LogComponent.Gateway,
      );
      this.running = false;
      return;
    }

    const config: FeishuConfig = {
      platform: 'feishu',
      credentials: { appId, appSecret },
      options: {},
      appId,
      appSecret,
      domain: 'feishu',
      connectionMode: 'websocket',
      allowedUsers: undefined,
      groupPolicy: undefined,
      webhook: undefined,
      freeResponseChatIds: undefined,
      verbose: false,
    };

    const options: FeishuAdapterOptions = {
      config,
      onMessage: async (chatId, userId, text, msgId) => {
        this.inbound({
          address: { platform: 'feishu', chat: chatId },
          sender: userId,
          text,
          reaction: null,
        });
        void msgId;
      },
      onImageMessage: async (chatId, userId) => {
        this.inbound({ address: { platform: 'feishu', chat: chatId }, sender: userId, text: '[image]', reaction: null });
      },
      onFileMessage: async (chatId, userId, _fileKey, fileName) => {
        this.inbound({ address: { platform: 'feishu', chat: chatId }, sender: userId, text: `[file: ${fileName}]`, reaction: null });
      },
      onAudioMessage: async (chatId, userId) => {
        this.inbound({ address: { platform: 'feishu', chat: chatId }, sender: userId, text: '[voice]', reaction: null });
      },
      onPostMessage: async (chatId, userId, title) => {
        const text = title?.trim() ? title.trim() : '[rich text]';
        this.inbound({ address: { platform: 'feishu', chat: chatId }, sender: userId, text, reaction: null });
      },
      onCardAction: async () => {},
      onReactionAdded: async (messageId, emojiType, userId, chatId) => {
        this.inbound({
          address: { platform: 'feishu', chat: chatId },
          sender: userId,
          text: '',
          reaction: { emoji: emojiType, messageQuote: null },
        });
        void messageId;
      },
      onReactionRemoved: async () => {},
      onMemberAdded: async () => {},
      onMemberRemoved: async () => {},
      onMessageRecalled: async () => {},
    } as unknown as FeishuAdapterOptions;

    this.channel = createFeishuChannel(options);
    try {
      await this.channel.start();
      logger.info('Feishu connector started', {
        agentId: this.agentId,
        mode: config.connectionMode,
      }, LogComponent.Gateway);
    } catch (err) {
      this.running = false;
      logger.error(
        'Feishu connector failed to start',
        err instanceof Error ? err : new Error(String(err)),
        { agentId: this.agentId },
        LogComponent.Gateway,
      );
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.channel) {
      await this.channel.stop();
      this.channel = null;
    }
  }

  private inbound(envelope: ChannelInboundEnvelope): void {
    logger.info('Feishu connector: inbound message', {
      agentId: this.agentId,
      chat: envelope.address.chat,
      sender: envelope.sender,
      hasReaction: Boolean(envelope.reaction),
    }, LogComponent.Gateway);
    this.onInbound(this.agentId, envelope);
  }
}