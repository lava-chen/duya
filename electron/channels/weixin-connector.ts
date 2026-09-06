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
 */

import * as path from 'node:path';
import { app } from 'electron';

import type { ChannelInboundEnvelope } from '../../packages/agent/src/channels/types';
import { getLogger, LogComponent } from '../logging/logger';
import {
  WeixinAdapter,
} from './gateway-adapters';
import type { PlatformConfig } from './gateway-adapters';
import { getConnectorCredential } from './agent-session-channels';

const logger = getLogger();

export interface WeixinConnectorOptions {
  agentId: string;
  onInbound: (agentId: string, envelope: ChannelInboundEnvelope) => void;
  /** Injectable client factory for tests (defaults to WeixinAdapter). */
  createAdapter?: () => WeixinAdapter;
}

/** Resolve the per-agent state directory so each WeChat bot persists its own
 * context_token/sync_buf without colliding with other bots or the gateway. */
function resolveAgentStateDir(agentId: string): string {
  return path.join(app.getPath('userData'), 'agents', agentId, 'gateway', 'weixin');
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
      this.inbound({
        address: { platform: 'weixin', chat: msg.platformChatId },
        sender: msg.platformUserId,
        text: msg.text ?? '',
        reaction: null,
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
}