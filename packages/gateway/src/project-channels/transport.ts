/**
 * transport.ts — the neutral `ProjectChannelTransportPort` implementation.
 *
 * One instance holds many connections, keyed by `connectionId`. That keying is
 * the whole point of this slice: the legacy `GatewayManager` indexes adapters,
 * busy state, dedup, and send throttles by `PlatformType`, so two Projects with
 * two different Discords cannot share a process. Here every socket, heartbeat,
 * reconnect timer, dedup cache, and per-channel send throttle belongs to exactly
 * one connection, and a generation fences each one.
 *
 * This class does not know what a Project is, who may speak in a channel, or
 * whether a delivery was authorized — the Host owns all of that. It resolves no
 * credential and persists nothing: the token arrives already resolved, and
 * inbound receipts live in the Host's ledger.
 *
 * Dependency direction: this module imports only the neutral contract
 * (`@duya/agent-protocol/project-channels`) plus the Gateway's own Discord wire
 * helpers. It never reaches into the Host, Electron, or SQLite, so a Host-side
 * consumer can depend on the port without pulling a Gateway process into the
 * Host's process model.
 */

import type {
  InspectProjectChannelInput,
  ProjectChannelChannelInspection,
  ProjectChannelErrorCode,
  ProjectChannelIdentityVerification,
  ProjectChannelRuntimeObservation,
  ProjectChannelTransportPort,
  ProjectChannelTransportSendFailure,
  ProjectChannelTransportSendInput,
  StartProjectChannelTransportInput,
  VerifyProjectChannelIdentityInput,
} from '@duya/agent-protocol/project-channels';
import { isProjectChannelRetryable } from '@duya/agent-protocol/project-channels';

import { ProjectDiscordConnection } from './connection.js';
import { ProjectChannelTransportFailure, isProjectChannelTransportFailure } from './errors.js';
import { DiscordRestClient, DEFAULT_DISCORD_API_BASE, type DiscordRestOutcome } from './rest.js';
import { proxyFetch } from '../proxy-fetch.js';
import {
  DEFAULT_RECONNECT_POLICY,
  PROJECT_DISCORD_INTENTS,
  type DiscordSocketLike,
  type ReconnectPolicy,
} from './socket.js';
import { systemTimers, type DiscordTimers } from './timers.js';

const SNOWFLAKE = /^\d{5,25}$/;
const DEFAULT_MIN_SEND_INTERVAL_MS = 1000;
const DEFAULT_MAX_INLINE_RETRY_MS = 2000;

/** Text channel types this first version accepts: guild text and announcement. */
const TEXT_CHANNEL_TYPES: ReadonlySet<number> = new Set([0, 5]);
const THREAD_CHANNEL_TYPES: ReadonlySet<number> = new Set([11, 12]);

export interface ProjectDiscordTransportOptions {
  /** Injected for tests; production uses the proxy-aware global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injected for tests; production uses the process WebSocket. */
  readonly createSocket?: (url: string) => DiscordSocketLike;
  readonly timers?: DiscordTimers;
  readonly now?: () => number;
  /**
   * Test-only override for the REST origin. The controlled local endpoint in the
   * acceptance matrix points here; no model output, tool input, or inbound
   * channel message can reach this option.
   */
  readonly apiBaseUrl?: string;
  /** Test-only override that skips `/gateway/bot` discovery. */
  readonly gatewayUrl?: string;
  readonly requestTimeoutMs?: number;
  readonly minSendIntervalMs?: number;
  readonly maxInlineRetryMs?: number;
  readonly reconnect?: Partial<ReconnectPolicy>;
  readonly dedupCapacity?: number;
  readonly startSettleTimeoutMs?: number;
  /** Structural diagnostics only: never a token, body, or raw provider error. */
  readonly log?: (event: string, detail?: Record<string, unknown>) => void;
}

export class ProjectDiscordTransport implements ProjectChannelTransportPort {
  private readonly options: ProjectDiscordTransportOptions;
  private readonly rest: DiscordRestClient;
  private readonly connections = new Map<string, ProjectDiscordConnection>();
  private readonly observations = new Map<string, ProjectChannelRuntimeObservation>();
  private readonly now: () => number;
  private readonly timers: DiscordTimers;
  private readonly createSocket: (url: string) => DiscordSocketLike;
  private readonly policy: ReconnectPolicy;

  constructor(options: ProjectDiscordTransportOptions = {}) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.timers = options.timers ?? systemTimers;
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as unknown as DiscordSocketLike);
    this.policy = { ...DEFAULT_RECONNECT_POLICY, ...options.reconnect };
    this.rest = new DiscordRestClient({
      // Production keeps the Gateway's proxy-aware transport, so an operator
      // behind a proxy configures it once for every Discord surface.
      fetchImpl: options.fetchImpl ?? ((input, init) => proxyFetch(String(input), init)),
      apiBaseUrl: options.apiBaseUrl ?? DEFAULT_DISCORD_API_BASE,
      requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
      timers: this.timers,
    });
  }

  /** Intents this transport asks for. Exported for the operator-facing docs. */
  static readonly intents = PROJECT_DISCORD_INTENTS;

  async start(
    input: StartProjectChannelTransportInput,
  ): Promise<ProjectChannelRuntimeObservation> {
    if (input.token.trim().length === 0) {
      throw this.publishFailure(input.connectionId, input.generation, 'credential_not_configured', {
        message: 'no credential was resolved for this connection',
      });
    }

    // Verify before displacing anything: a failed rotation must not take down a
    // connection that is still working.
    let identity: ProjectChannelIdentityVerification;
    try {
      identity = await this.verifyIdentity({
        connectionId: input.connectionId,
        token: input.token,
      });
    } catch (error) {
      const failure = toTransportFailure(error, 'credential_invalid');
      throw this.publishFailure(input.connectionId, input.generation, failure.code, {
        message: failure.message,
      });
    }

    let gatewayUrl: string;
    try {
      gatewayUrl = this.options.gatewayUrl ?? (await this.discoverGatewayUrl(input.token));
    } catch (error) {
      const failure = toTransportFailure(error, 'transport_unavailable');
      throw this.publishFailure(input.connectionId, input.generation, failure.code, {
        message: failure.message,
      });
    }

    const previous = this.connections.get(input.connectionId);
    if (previous) {
      this.connections.delete(input.connectionId);
      await previous.stop();
    }

    const connection = new ProjectDiscordConnection({
      connectionId: input.connectionId,
      generation: input.generation,
      token: input.token,
      botUserId: identity.botUserId,
      gatewayUrl,
      handlers: input.handlers,
      rest: this.rest,
      createSocket: this.createSocket,
      timers: this.timers,
      now: this.now,
      policy: this.policy,
      minSendIntervalMs: this.options.minSendIntervalMs ?? DEFAULT_MIN_SEND_INTERVAL_MS,
      maxInlineRetryMs: this.options.maxInlineRetryMs ?? DEFAULT_MAX_INLINE_RETRY_MS,
      ...(this.options.dedupCapacity === undefined
        ? {}
        : { dedupCapacity: this.options.dedupCapacity }),
      ...(this.options.startSettleTimeoutMs === undefined
        ? {}
        : { startSettleTimeoutMs: this.options.startSettleTimeoutMs }),
      publish: (observation) => this.observations.set(observation.connectionId, observation),
      log: this.options.log ?? (() => {}),
    });

    this.connections.set(input.connectionId, connection);

    // The Bot identity is known from REST even before READY confirms it. The
    // socket layer still compares READY's user id, so a rotated token cannot
    // silently continue under the old Project.
    return connection.start().then((observation) => ({
      ...observation,
      observedBotUserId: observation.observedBotUserId ?? identity.botUserId,
    }));
  }

  async stop(connectionId: string, generation: number): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    if (connection.generation !== generation) {
      // A late stop for a superseded generation must not silence the live one.
      return;
    }
    this.connections.delete(connectionId);
    await connection.stop();
  }

  observe(connectionId: string): ProjectChannelRuntimeObservation | null {
    return this.observations.get(connectionId) ?? null;
  }

  /** Stop every connection. Used by the Host on shutdown and by tests. */
  async dispose(): Promise<void> {
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(connections.map((connection) => connection.stop()));
  }

  async verifyIdentity(
    input: VerifyProjectChannelIdentityInput,
  ): Promise<ProjectChannelIdentityVerification> {
    const outcome = await this.rest.get<{ id?: string }>(input.token, '/users/@me');
    if (outcome.kind === 'ok') {
      const id = outcome.value?.id;
      if (typeof id !== 'string' || id.length === 0) {
        throw new ProjectChannelTransportFailure({
          code: 'transport_unavailable',
          message: 'platform returned no Bot user id',
        });
      }
      return { botUserId: id, verifiedAt: this.now() };
    }
    throw this.restFailure(outcome, {
      unauthorized: 'credential_invalid',
      notFound: 'credential_invalid',
      message: 'Bot identity verification failed',
    });
  }

  async inspectChannel(
    input: InspectProjectChannelInput,
  ): Promise<ProjectChannelChannelInspection> {
    if (!SNOWFLAKE.test(input.guildId) || !SNOWFLAKE.test(input.channelId)) {
      throw new ProjectChannelTransportFailure({
        code: 'invalid_target',
        message: 'guild or channel id is not a Discord id',
      });
    }

    const channel = await this.rest.get<{ type?: number; guild_id?: string }>(
      input.token,
      `/channels/${input.channelId}`,
    );
    if (channel.kind !== 'ok') {
      throw this.restFailure(channel, {
        unauthorized: 'invalid_target',
        notFound: 'invalid_target',
        message: 'channel could not be inspected',
      });
    }

    if (channel.value?.guild_id !== input.guildId) {
      throw new ProjectChannelTransportFailure({
        code: 'invalid_target',
        message: 'channel does not belong to the claimed guild',
      });
    }

    const type = channel.value?.type ?? -1;
    const isTextChannel = TEXT_CHANNEL_TYPES.has(type);
    const isThread = THREAD_CHANNEL_TYPES.has(type);
    if (!isTextChannel && !isThread) {
      throw new ProjectChannelTransportFailure({
        code: 'invalid_target',
        message: 'channel type is not a text channel or thread',
      });
    }

    // The Bot must actually be in the guild: a channel it can read by id is not
    // the same thing as an invitation the operator accepted.
    const guild = await this.rest.get<{ id?: string }>(input.token, `/guilds/${input.guildId}`);
    if (guild.kind !== 'ok') {
      throw this.restFailure(guild, {
        unauthorized: 'invalid_target',
        notFound: 'invalid_target',
        message: 'Bot is not a member of the claimed guild',
      });
    }

    return {
      guildId: input.guildId,
      channelId: input.channelId,
      isTextChannel,
      isThread,
      inspectedAt: this.now(),
    };
  }

  async send(
    input: ProjectChannelTransportSendInput,
  ): Promise<{ readonly platformMessageId: string } | ProjectChannelTransportSendFailure> {
    const connection = this.connections.get(input.connectionId);
    if (!connection) {
      return failure('transport_unavailable', 'connection is not running');
    }
    if (connection.generation !== input.generation) {
      // The delivery belonged to a configuration that was replaced.
      return failure('generation_stale', 'connection generation is no longer current');
    }
    return connection.send(input);
  }

  private async discoverGatewayUrl(token: string): Promise<string> {
    const outcome = await this.rest.get<{ url?: string }>(token, '/gateway/bot');
    if (outcome.kind === 'ok' && typeof outcome.value?.url === 'string' && outcome.value.url) {
      return outcome.value.url;
    }
    if (outcome.kind === 'ok') {
      throw new ProjectChannelTransportFailure({
        code: 'transport_unavailable',
        message: 'platform returned no gateway url',
      });
    }
    throw this.restFailure(outcome, {
      unauthorized: 'credential_invalid',
      notFound: 'transport_unavailable',
      message: 'gateway discovery failed',
    });
  }

  private restFailure<T>(
    outcome: DiscordRestOutcome<T>,
    mapping: {
      readonly unauthorized: ProjectChannelErrorCode;
      readonly notFound: ProjectChannelErrorCode;
      readonly message: string;
    },
  ): ProjectChannelTransportFailure {
    if (outcome.kind === 'network') {
      return new ProjectChannelTransportFailure({
        code: 'transport_unavailable',
        message: outcome.timedOut
          ? `${mapping.message}: request timed out`
          : `${mapping.message}: no readable response`,
      });
    }
    if (outcome.kind === 'http') {
      const code =
        outcome.status === 401 || outcome.status === 403
          ? mapping.unauthorized
          : outcome.status === 404
            ? mapping.notFound
            : 'transport_unavailable';
      return new ProjectChannelTransportFailure({
        code,
        message: `${mapping.message} (status ${outcome.status})`,
        status: outcome.status,
        ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
      });
    }
    return new ProjectChannelTransportFailure({
      code: 'transport_unavailable',
      message: mapping.message,
    });
  }

  /**
   * Record the failure as an observation as well as throwing, so a Host that
   * only polls `observe()` still sees "configured, credential rejected" instead
   * of a connection that looks merely offline.
   */
  private publishFailure(
    connectionId: string,
    generation: number,
    code: ProjectChannelErrorCode,
    detail: { readonly message: string },
  ): ProjectChannelTransportFailure {
    this.observations.set(connectionId, {
      connectionId,
      generation,
      observedBotUserId: null,
      state: 'error',
      errorCode: code,
      observedAt: this.now(),
    });
    return new ProjectChannelTransportFailure({ code, message: detail.message });
  }
}

function failure(
  code: ProjectChannelErrorCode,
  message: string,
): ProjectChannelTransportSendFailure {
  return { code, message, retryable: isProjectChannelRetryable(code) };
}

function toTransportFailure(
  error: unknown,
  fallback: ProjectChannelErrorCode,
): ProjectChannelTransportFailure {
  if (isProjectChannelTransportFailure(error)) return error;
  return new ProjectChannelTransportFailure({ code: fallback, message: 'transport call failed' });
}

export function createProjectDiscordTransport(
  options: ProjectDiscordTransportOptions = {},
): ProjectChannelTransportPort {
  return new ProjectDiscordTransport(options);
}
