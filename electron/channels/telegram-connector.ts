/**
 * telegram-connector.ts — inbound Telegram connector (plan 488 P6, grok-form).
 *
 * One connector instance per (bot, platform) binding: long-polls the Telegram
 * Bot API `getUpdates` with the BOT'S OWN token and turns each text message
 * into a `ChannelInboundEnvelope` handed to the wake pipeline, which runs a
 * hidden `[inbound]` turn in that bot's persistent session (`bot:<agentId>`).
 *
 * Long polling (no webhook) keeps the connector dependency-free and works
 * behind NAT — the same tradeoff grok-bot's desktop host makes.
 */

import type { ChannelInboundEnvelope } from '../../packages/agent/src/channels/types';
import { getLogger, LogComponent } from '../logging/logger';

const logger = getLogger();

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    from?: { username?: string; first_name?: string };
    chat?: { id?: number | string };
  };
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
          this.offset = update.update_id + 1;
          this.handleUpdate(update);
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
      `https://api.telegram.org/bot${this.opts.token}/getUpdates` +
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

  private handleUpdate(update: TelegramUpdate): void {
    const msg = update.message;
    if (!msg?.text || msg.chat?.id === undefined) return;
    const envelope: ChannelInboundEnvelope = {
      address: { platform: 'telegram', chat: String(msg.chat.id) },
      sender: msg.from?.username ?? msg.from?.first_name ?? 'unknown',
      text: msg.text,
      reaction: null,
    };
    logger.info('Telegram connector: inbound message', {
      agentId: this.opts.agentId,
      chat: envelope.address.chat,
      sender: envelope.sender,
    }, LogComponent.Gateway);
    this.opts.onInbound(this.opts.agentId, envelope);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
