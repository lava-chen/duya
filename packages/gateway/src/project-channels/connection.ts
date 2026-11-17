/**
 * connection.ts — one Project's Discord connection: filters, receipts, sends.
 *
 * The authorization decisions live in the Host, not here. What this class does
 * is refuse to hand over anything the platform did not actually observe:
 *
 * - it drops Bot/webhook authors (including its own echo), DMs, and messages
 *   that do not natively mention THIS Bot, so an unbound channel or an
 *   unmentioned message can never become a project question;
 * - it reports the message's own `channel_id`, never a thread's parent, so a
 *   thread that was not bound on its own is simply not a bound channel;
 * - it forwards `authorIsBot` / `authorIsWebhook` as false only after filtering,
 *   so the Host can re-check instead of trusting this layer;
 * - its inbound handler is serialized per connection, because two questions
 *   arriving together must not race for one Coordinator;
 * - it refuses a send whose generation, connection state, or target shape is no
 *   longer valid, and never converts "no evidence" into `sent`.
 *
 * Nothing here persists anything: dedup is an in-process fast path, and the
 * durable ledger of inbound events and deliveries belongs to the Host.
 */

import type {
  ProjectChannelErrorCode,
  ProjectChannelInboundCallback,
  ProjectChannelRuntimeObservation,
  ProjectChannelRuntimeState,
  ProjectChannelTransportHandlers,
  ProjectChannelTransportSendFailure,
  ProjectChannelTransportSendInput,
} from '@duya/agent-protocol/project-channels';
import {
  isProjectChannelRetryable,
} from '@duya/agent-protocol/project-channels';

import { cleanContent } from '../adapters/discord/message-utils.js';
import type { DiscordRestClient, DiscordRestOutcome } from './rest.js';
import type { DiscordSocketLike, ReconnectPolicy } from './socket.js';
import { DiscordSocketSession } from './socket.js';
import type { DiscordTimers } from './timers.js';
import type { DiscordMessage } from './types.js';
import { redactSecrets } from './errors.js';

/** One Discord message. Longer bodies are refused, never silently split. */
const MAX_MESSAGE_LENGTH = 2000;
/** Snowflake shape. Anything else is not a Discord id and never reaches a URL. */
const SNOWFLAKE = /^\d{5,25}$/;
/** Placeholder when a mention carries an attachment but no text we can read. */
const OMITTED_ATTACHMENT_MARKER = '[attachment omitted: attachments are not accepted in project channels]';
const DEFAULT_DEDUP_CAPACITY = 500;
const DEFAULT_START_SETTLE_TIMEOUT_MS = 10_000;

export interface ProjectDiscordConnectionOptions {
  readonly connectionId: string;
  readonly generation: number;
  /** Host-resolved credential. Never logged, never stored by this class. */
  readonly token: string;
  /** Bot user id confirmed by REST before the socket opened. */
  readonly botUserId: string;
  readonly gatewayUrl: string;
  readonly handlers: ProjectChannelTransportHandlers;
  readonly rest: DiscordRestClient;
  readonly createSocket: (url: string) => DiscordSocketLike;
  readonly timers: DiscordTimers;
  readonly now: () => number;
  readonly policy: ReconnectPolicy;
  readonly minSendIntervalMs: number;
  /** Retry a 429 inline only when the platform's own budget is this small. */
  readonly maxInlineRetryMs: number;
  readonly dedupCapacity?: number;
  readonly startSettleTimeoutMs?: number;
  readonly publish: (observation: ProjectChannelRuntimeObservation) => void;
  readonly log: (event: string, detail?: Record<string, unknown>) => void;
}

export class ProjectDiscordConnection {
  readonly connectionId: string;
  readonly generation: number;

  private readonly options: ProjectDiscordConnectionOptions;
  private readonly dedupCapacity: number;
  private session: DiscordSocketSession | null = null;

  private state: ProjectChannelRuntimeState = 'disconnected';
  private errorCode: ProjectChannelErrorCode | null = null;
  private observedBotUserId: string | null = null;
  private observedAt: number;

  private stopped = false;
  private settled = false;
  private settleResolve: (() => void) | null = null;
  private settleTimer: unknown = null;

  /** Serializes inbound delivery so two questions cannot interleave. */
  private inboundChain: Promise<void> = Promise.resolve();
  private readonly seenMessageIds = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly lastSendAt = new Map<string, number>();

  constructor(options: ProjectDiscordConnectionOptions) {
    this.options = options;
    this.connectionId = options.connectionId;
    this.generation = options.generation;
    this.dedupCapacity = Math.max(1, options.dedupCapacity ?? DEFAULT_DEDUP_CAPACITY);
    this.observedAt = options.now();
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  async start(): Promise<ProjectChannelRuntimeObservation> {
    this.publishObservation('disconnected', null);

    const session = new DiscordSocketSession({
      connectionId: this.options.connectionId,
      generation: this.options.generation,
      token: this.options.token,
      gatewayUrl: this.options.gatewayUrl,
      createSocket: this.options.createSocket,
      timers: this.options.timers,
      policy: this.options.policy,
      onDispatch: (eventType, data) => this.handleDispatch(eventType, data),
      onState: (state, errorCode) => this.handleState(state, errorCode),
      isCurrent: () => !this.stopped,
    });
    this.session = session;
    session.start();

    await this.waitForFirstState(
      this.options.startSettleTimeoutMs ?? DEFAULT_START_SETTLE_TIMEOUT_MS,
    );
    return this.observation();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.markSettled();
    this.session?.stop();
    this.session = null;
    // The observation outlives the runtime on purpose: "configured but stopped"
    // is a different fact from "never configured", and the Host shows it.
    this.publishObservation('disconnected', null);
  }

  observation(): ProjectChannelRuntimeObservation {
    return {
      connectionId: this.connectionId,
      generation: this.generation,
      observedBotUserId: this.observedBotUserId,
      state: this.state,
      errorCode: this.errorCode,
      observedAt: this.observedAt,
    };
  }

  async send(
    input: ProjectChannelTransportSendInput,
  ): Promise<{ readonly platformMessageId: string } | ProjectChannelTransportSendFailure> {
    const text = input.text ?? '';
    if (text.trim().length === 0) {
      return this.sendFailure('invalid_request', 'text is empty');
    }
    if (text.length > MAX_MESSAGE_LENGTH) {
      // Not truncated: a split body needs every chunk and its receipt persisted
      // together, which this first version does not claim to do.
      return this.sendFailure(
        'invalid_request',
        `text exceeds ${MAX_MESSAGE_LENGTH} characters`,
      );
    }
    if (!SNOWFLAKE.test(input.channelId) || !SNOWFLAKE.test(input.guildId)) {
      return this.sendFailure('invalid_target', 'channel or guild id is not a Discord id');
    }
    if (this.stopped || this.state !== 'connected') {
      return this.sendFailure('transport_unavailable', 'connection is not connected');
    }

    const replyReference = input.replyToPlatformMessageId
      ? { message_id: input.replyToPlatformMessageId, fail_if_not_exists: false }
      : undefined;
    if (replyReference && !SNOWFLAKE.test(input.replyToPlatformMessageId ?? '')) {
      return this.sendFailure('invalid_target', 'reply target is not a Discord message id');
    }

    await this.reserveSendSlot(input.channelId);
    const outcome = await this.postMessage(input.channelId, text, replyReference);

    if (outcome.kind === 'http' && outcome.status === 429) {
      const retryAfterMs = outcome.retryAfterMs ?? 1000;
      // A 429 is the platform saying "definitely not applied", so one bounded
      // inline retry cannot duplicate a message. Anything longer is the Host's
      // call, with the budget handed over rather than guessed.
      if (retryAfterMs <= this.options.maxInlineRetryMs) {
        await this.delay(retryAfterMs);
        return this.classifySendOutcome(
          await this.postMessage(input.channelId, text, replyReference),
        );
      }
      return this.sendFailure('delivery_retryable', 'platform rate limited the send', {
        retryAfterMs,
      });
    }

    return this.classifySendOutcome(outcome);
  }

  // ─── send plumbing ──────────────────────────────────────────────────────────

  private postMessage(
    channelId: string,
    content: string,
    replyReference: { message_id: string; fail_if_not_exists: boolean } | undefined,
  ): Promise<DiscordRestOutcome<{ id?: string }>> {
    return this.options.rest.post<{ id?: string }>(
      this.options.token,
      `/channels/${channelId}/messages`,
      {
        content,
        // Both the parse list and `replied_user` are off: model-authored text
        // must not ping @everyone, another bot, or the original author.
        allowed_mentions: { parse: [], roles: [], users: [], replied_user: false },
        ...(replyReference ? { message_reference: replyReference } : {}),
      },
    );
  }

  private classifySendOutcome(
    outcome: DiscordRestOutcome<{ id?: string }>,
  ): { readonly platformMessageId: string } | ProjectChannelTransportSendFailure {
    if (outcome.kind === 'ok') {
      const id = outcome.value?.id;
      if (typeof id === 'string' && id.length > 0) return { platformMessageId: id };
      // 2xx without a readable id: the platform may well have accepted it.
      return this.sendFailure('delivery_unknown', 'platform acknowledged without a message id');
    }

    if (outcome.kind === 'network') {
      // Transport error, timeout, or unparseable body. No evidence either way.
      return this.sendFailure(
        'delivery_unknown',
        outcome.timedOut ? 'send timed out' : 'send ended without a readable response',
      );
    }

    const status = outcome.status;
    if (status === 401) {
      return this.sendFailure('credential_invalid', 'platform rejected the Bot credential', {
        status,
      });
    }
    if (status === 403) {
      return this.sendFailure('delivery_failed', 'Bot lacks permission in this channel', {
        status,
      });
    }
    if (status === 404) {
      return this.sendFailure('delivery_failed', 'channel no longer exists', { status });
    }
    if (status >= 400 && status < 500) {
      return this.sendFailure('delivery_failed', 'platform rejected the message body', {
        status,
      });
    }
    // 5xx: the platform may have applied the request before failing to answer.
    return this.sendFailure('delivery_unknown', 'platform failed while sending', { status });
  }

  private sendFailure(
    code: ProjectChannelErrorCode,
    message: string,
    extra?: { readonly retryAfterMs?: number; readonly status?: number },
  ): ProjectChannelTransportSendFailure {
    const detail =
      extra?.status === undefined ? message : `${message} (status ${extra.status})`;
    const failure: ProjectChannelTransportSendFailure = {
      code,
      message: redactSecrets(detail, [this.options.token]),
      retryable: isProjectChannelRetryable(code),
    };
    if (extra?.retryAfterMs === undefined) {
      return failure;
    }
    return { ...failure, retryAfterMs: extra.retryAfterMs };
  }

  private async reserveSendSlot(channelId: string): Promise<void> {
    const spacing = this.options.minSendIntervalMs;
    if (spacing <= 0) return;

    const last = this.lastSendAt.get(channelId);
    if (last !== undefined) {
      const wait = last + spacing - this.options.now();
      if (wait > 0) await this.delay(wait);
    }
    this.lastSendAt.set(channelId, this.options.now());
  }

  private delay(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.options.timers.setTimeout(resolve, ms);
    });
  }

  // ─── inbound plumbing ───────────────────────────────────────────────────────

  private handleState(
    state: 'connected' | 'disconnected' | 'error',
    errorCode: ProjectChannelErrorCode | null,
  ): void {
    if (this.stopped) return;

    if (state === 'connected') {
      // READY/RESUMED confirms the socket, not the identity; READY's user id is
      // compared separately in handleReady.
      this.observedBotUserId = this.observedBotUserId ?? this.options.botUserId;
      this.publishObservation('connected', null);
    } else if (state === 'error') {
      this.publishObservation('error', errorCode);
    } else {
      this.publishObservation('disconnected', errorCode);
    }
    this.markSettled();
  }

  private handleDispatch(eventType: string, data: unknown): void {
    if (this.stopped) return;

    switch (eventType) {
      case 'READY':
        this.handleReady(data);
        break;
      case 'MESSAGE_CREATE':
        this.enqueueMessage(data as DiscordMessage);
        break;
      default:
        // Resume, interactions, edits, deletes, reactions: not this surface. A
        // channel message is not an approval channel.
        break;
    }
  }

  private handleReady(data: unknown): void {
    const ready = data as { user?: { id?: string } } | undefined;
    const reported = ready?.user?.id ?? '';
    if (reported === '') return;

    if (reported !== this.options.botUserId) {
      // The token now belongs to a different Bot. Continuing would answer for a
      // Project with someone else's identity.
      this.observedBotUserId = reported;
      this.publishObservation('error', 'bot_identity_conflict');
      this.session?.stop();
      this.options.log('project-channel.identity-conflict', {
        connectionId: this.connectionId,
        generation: this.generation,
      });
      return;
    }
    this.observedBotUserId = reported;
  }

  private enqueueMessage(message: DiscordMessage): void {
    const accepted = this.acceptMessage(message);
    if (accepted === null) return;

    this.inboundChain = this.inboundChain
      .then(() => this.deliver(message, accepted))
      .catch(() => {
        // A rejected handler must not poison the chain for the next message.
        this.options.log('project-channel.inbound-handler-failed', {
          connectionId: this.connectionId,
          platformMessageId: message.id,
        });
      });
  }

  /**
   * Returns the text to deliver, or null when this message is not a project
   * question. Every rejection is a fail-closed rule from the plan, not a
   * heuristic: unidentified author, unknown source, or no native mention.
   */
  private acceptMessage(message: DiscordMessage): string | null {
    const author = message.author;
    if (!author?.id || author.bot === true || !message.guild_id) {
      return null;
    }
    if (message.webhook_id) {
      return null;
    }
    // Native mention of this exact Bot. `checkMention` is not reused: it treats
    // any `/command` as a mention and accepts configured name patterns.
    const mentions = message.mentions ?? [];
    if (!mentions.some((mention) => mention.id === this.options.botUserId)) {
      return null;
    }

    const text = cleanContent(message.content ?? '');
    if (text.length === 0) {
      // An empty body with MESSAGE_CONTENT enabled means a non-text message.
      // Attachments are out of scope for this version; a sticker-only mention
      // carries nothing to answer, so neither is forwarded as a question.
      const hasAttachment = (message.attachments?.length ?? 0) > 0;
      if (!hasAttachment) return null;
      if (this.isDuplicate(message.id)) return null;
      return OMITTED_ATTACHMENT_MARKER;
    }

    if (this.isDuplicate(message.id)) return null;
    return text;
  }

  private isDuplicate(messageId: string): boolean {
    if (this.seenMessageIds.has(messageId)) return true;

    this.seenMessageIds.add(messageId);
    this.seenOrder.push(messageId);
    while (this.seenOrder.length > this.dedupCapacity) {
      const evicted = this.seenOrder.shift();
      if (evicted !== undefined) this.seenMessageIds.delete(evicted);
    }
    return false;
  }

  private async deliver(message: DiscordMessage, text: string): Promise<void> {
    if (this.stopped) return;

    const guildId = message.guild_id ?? '';
    const event: ProjectChannelInboundCallback = {
      connectionId: this.connectionId,
      generation: this.generation,
      platformMessageId: message.id,
      guildId,
      channelId: message.channel_id,
      senderId: message.author.id,
      // Only ever true for messages that survived the filters above, which drop
      // bots and webhooks; the Host re-checks rather than trusting this.
      authorIsBot: message.author.bot === true,
      authorIsWebhook: Boolean(message.webhook_id),
      mentionIds: (message.mentions ?? []).map((mention) => mention.id),
      text,
      observedAt: this.options.now(),
    };

    const inboundId = await this.options.handlers.onInbound(event);
    this.options.log('project-channel.inbound-accepted', {
      connectionId: this.connectionId,
      generation: this.generation,
      inboundId,
    });
  }

  // ─── observation and settle plumbing ────────────────────────────────────────

  private publishObservation(
    state: ProjectChannelRuntimeState,
    errorCode: ProjectChannelErrorCode | null,
  ): void {
    this.state = state;
    this.errorCode = errorCode;
    this.observedAt = this.options.now();
    const observation = this.observation();
    this.options.publish(observation);
    try {
      this.options.handlers.onObservation(observation);
    } catch {
      // A subscriber that throws is a subscriber bug, not a transport failure.
      this.options.log('project-channel.observation-handler-failed', {
        connectionId: this.connectionId,
        generation: this.generation,
      });
    }
  }

  private waitForFirstState(timeoutMs: number): Promise<void> {
    if (this.settled) return Promise.resolve();
    return new Promise((resolve) => {
      this.settleResolve = resolve;
      this.settleTimer = this.options.timers.setTimeout(() => {
        // A platform that never answers must not hang `start` forever. The
        // observation stays `disconnected` and the socket keeps trying.
        this.options.log('project-channel.start-settle-timeout', {
          connectionId: this.connectionId,
          generation: this.generation,
        });
        this.markSettled();
      }, timeoutMs);
    });
  }

  private markSettled(): void {
    if (this.settled) return;
    this.settled = true;
    if (this.settleTimer !== null) {
      this.options.timers.clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    const resolve = this.settleResolve;
    this.settleResolve = null;
    resolve?.();
  }
}
