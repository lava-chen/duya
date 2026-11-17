/**
 * project-discord-runtime.test.ts — the multi-instance Discord transport.
 *
 * Everything here runs against a controlled local endpoint: a fake REST surface
 * and a fake WebSocket that speak the real wire shapes. No test reaches the
 * public internet, and the API origin override exists only in this file.
 *
 * The cases are the transport rows of the plan's acceptance matrix: two Bots in
 * one channel answer only the instance that was natively mentioned; echoes,
 * webhooks, DMs, and unmentioned messages are dropped; a replaced generation
 * cannot resurrect; sends never enable mentions; and "no evidence" never becomes
 * a `sent` receipt.
 */

import { describe, expect, it } from 'vitest';

import type {
  ProjectChannelInboundCallback,
  ProjectChannelRuntimeObservation,
  ProjectChannelTransportHandlers,
} from '@duya/agent-protocol/project-channels';

import { ProjectDiscordTransport, type ProjectDiscordTransportOptions } from './transport.js';
import type { ProjectChannelTransportFailure } from './errors.js';
import type { DiscordSocketLike } from './socket.js';

const API = 'https://discord.test/api/v10';
const GATEWAY = 'wss://gateway.test';

// ─── controlled platform ──────────────────────────────────────────────────────

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly token: string;
  readonly body: unknown;
}

class FakeSocket implements DiscordSocketLike {
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  readonly sent: unknown[] = [];
  closed: { code: number; reason: string } | null = null;

  constructor(
    readonly url: string,
    private readonly harness: FakeDiscord,
  ) {}

  send(data: string): void {
    const payload = JSON.parse(data) as { op: number; d?: Record<string, unknown> };
    this.sent.push(payload);
    this.harness.handleClientSend(this, payload);
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = { code, reason };
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }

  /** Server -> client dispatch. */
  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  ops(): number[] {
    return this.sent.map((payload) => (payload as { op: number }).op);
  }
}

class FakeDiscord {
  readonly sockets: FakeSocket[] = [];
  readonly requests: RecordedRequest[] = [];
  /** token -> Bot user id. */
  readonly bots = new Map<string, string>();
  /** channel id -> channel shape returned by GET /channels/:id. */
  readonly channels = new Map<string, { type: number; guild_id: string }>();
  sendResponse: (request: RecordedRequest, attempt: number) => Response | Promise<Response> =
    () => jsonResponse(200, { id: 'platform-message-1' });
  /** Every POST /channels/:id/messages this run attempted. */
  sendAttempts = 0;

  createSocket = (url: string): DiscordSocketLike => {
    const socket = new FakeSocket(url, this);
    this.sockets.push(socket);
    return socket;
  };

  fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    const auth = headers.get('authorization') ?? '';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const request: RecordedRequest = {
      url,
      method: init?.method ?? 'GET',
      token: auth.replace(/^Bot\s+/i, ''),
      body,
    };
    this.requests.push(request);

    if (request.method === 'POST' && url.endsWith('/messages')) {
      this.sendAttempts += 1;
      return this.sendResponse(request, this.sendAttempts);
    }
    return this.defaultResponse(request);
  };

  private defaultResponse(request: RecordedRequest): Response {
    const path = new URL(request.url).pathname.replace('/api/v10', '');
    const botId = this.bots.get(request.token);

    if (!botId) return jsonResponse(401, { message: 'invalid token' });
    if (path === '/users/@me') return jsonResponse(200, { id: botId, username: 'bot' });
    if (path === '/gateway/bot') return jsonResponse(200, { url: GATEWAY });

    const channelMatch = /^\/channels\/(\d+)$/.exec(path);
    if (channelMatch) {
      const channel = this.channels.get(channelMatch[1]!);
      return channel ? jsonResponse(200, channel) : jsonResponse(404, { message: 'unknown channel' });
    }

    const guildMatch = /^\/guilds\/(\d+)$/.exec(path);
    if (guildMatch) {
      return jsonResponse(200, { id: guildMatch[1] });
    }

    return jsonResponse(404, { message: 'unknown route' });
  }

  handleClientSend(socket: FakeSocket, payload: { op: number; d?: Record<string, unknown> }): void {
    if (payload.op === 2) {
      const botId = this.bots.get(String(payload.d?.['token'] ?? '')) ?? 'unknown-bot';
      socket.receive({
        op: 0,
        s: 1,
        t: 'READY',
        d: {
          session_id: 'session-1',
          resume_gateway_url: `${GATEWAY}/resume`,
          user: { id: botId, username: 'bot' },
        },
      });
    } else if (payload.op === 6) {
      socket.receive({ op: 0, s: 2, t: 'RESUMED', d: {} });
    }
  }

  hello(socket: FakeSocket, heartbeatInterval = 45_000): void {
    socket.receive({ op: 10, d: { heartbeat_interval: heartbeatInterval } });
  }

  connect(socket: FakeSocket, heartbeatInterval = 45_000): void {
    socket.onopen?.({});
    this.hello(socket, heartbeatInterval);
  }

  lastSocket(): FakeSocket {
    const socket = this.sockets.at(-1);
    if (!socket) throw new Error('no socket was opened');
    return socket;
  }
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function settlement(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Poll until the transport has produced the expected effect. Microtask draining
 * alone is not enough: a reconnect is scheduled through a real `setTimeout`, so
 * asserting on a fixed number of ticks would make the test depend on Node's
 * timers/check ordering instead of on the behaviour under test.
 */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** One ordinary send against the connection every case sets up as `c1`. */
function sendOnce(transport: ProjectDiscordTransport, overrides: Partial<{
  deliveryId: string;
  connectionId: string;
  generation: number;
  guildId: string;
  channelId: string;
  text: string;
}> = {}): Promise<unknown> {
  return transport.send({
    deliveryId: 'd1',
    connectionId: 'c1',
    generation: 1,
    guildId: GUILD,
    channelId: CHANNEL,
    text: 'hello',
    ...overrides,
  });
}

const GUILD = '100000000000000001';
const CHANNEL = '200000000000000002';

function message(overrides: {
  id: string;
  botId: string;
  authorId?: string;
  content?: string;
  authorIsBot?: boolean;
  webhook?: boolean;
  guildId?: string | null;
  mentionIds?: string[];
}): Record<string, unknown> {
  const mentionIds = overrides.mentionIds ?? [overrides.botId];
  return {
    id: overrides.id,
    channel_id: CHANNEL,
    ...(overrides.guildId === null
      ? {}
      : { guild_id: overrides.guildId ?? GUILD }),
    author: {
      id: overrides.authorId ?? '300000000000000003',
      username: 'member',
      ...(overrides.authorIsBot ? { bot: true } : {}),
    },
    ...(overrides.webhook ? { webhook_id: '400000000000000004' } : {}),
    content: overrides.content ?? `<@${overrides.botId}> what is in flight?`,
    timestamp: new Date(0).toISOString(),
    mentions: mentionIds.map((id) => ({ id })),
  };
}

interface Harness {
  readonly platform: FakeDiscord;
  readonly transport: ProjectDiscordTransport;
  readonly inbound: ProjectChannelInboundCallback[];
  readonly observations: ProjectChannelRuntimeObservation[];
  connect(connectionId: string, generation: number, token: string): Promise<ProjectChannelRuntimeObservation>;
}

function harness(
  tokens: Record<string, string>,
  options: Partial<ProjectDiscordTransportOptions> = {},
): Harness {
  const platform = new FakeDiscord();
  for (const [token, botId] of Object.entries(tokens)) platform.bots.set(token, botId);
  platform.channels.set(CHANNEL, { type: 0, guild_id: GUILD });

  const inbound: ProjectChannelInboundCallback[] = [];
  const observations: ProjectChannelRuntimeObservation[] = [];
  const transport = new ProjectDiscordTransport({
    fetchImpl: platform.fetchImpl,
    createSocket: platform.createSocket,
    apiBaseUrl: API,
    gatewayUrl: GATEWAY,
    minSendIntervalMs: 0,
    startSettleTimeoutMs: 2000,
    reconnect: { baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
    log: () => {},
    ...options,
  });

  return {
    platform,
    transport,
    inbound,
    observations,
    async connect(connectionId, generation, token) {
      const starting = transport.start({
        connectionId,
        generation,
        token,
        handlers: {
          onInbound: async (event) => {
            inbound.push(event);
            return `inbound-${event.platformMessageId}`;
          },
          onObservation: (observation) => observations.push(observation),
        },
      });
      await settlement();
      platform.connect(platform.lastSocket());
      return starting;
    },
  };
}

// ─── identity, discovery, observation ─────────────────────────────────────────

describe('project channel discord transport: identity and lifecycle', () => {
  it('verifies the Bot user over REST and inspects a guild text channel', async () => {
    const h = harness({ 'token-a': '900000000000000001' });

    const identity = await h.transport.verifyIdentity({ connectionId: 'c1', token: 'token-a' });
    expect(identity.botUserId).toBe('900000000000000001');

    const inspection = await h.transport.inspectChannel({
      connectionId: 'c1',
      token: 'token-a',
      guildId: GUILD,
      channelId: CHANNEL,
    });
    expect(inspection).toMatchObject({ guildId: GUILD, channelId: CHANNEL, isTextChannel: true, isThread: false });
  });

  it('rejects a channel that belongs to another guild, a non-text channel, and a non-snowflake id', async () => {
    const h = harness({ 'token-a': '900000000000000001' });
    h.platform.channels.set('500000000000000005', { type: 2, guild_id: GUILD });

    await expect(
      h.transport.inspectChannel({
        connectionId: 'c1',
        token: 'token-a',
        guildId: '100000000000000009',
        channelId: CHANNEL,
      }),
    ).rejects.toMatchObject({ code: 'invalid_target' });

    await expect(
      h.transport.inspectChannel({
        connectionId: 'c1',
        token: 'token-a',
        guildId: GUILD,
        channelId: '500000000000000005',
      }),
    ).rejects.toMatchObject({ code: 'invalid_target' });

    await expect(
      h.transport.inspectChannel({
        connectionId: 'c1',
        token: 'token-a',
        guildId: GUILD,
        channelId: 'not-a-snowflake',
      }),
    ).rejects.toMatchObject({ code: 'invalid_target' });
  });

  it('discovers the gateway url and reports connected only after READY', async () => {
    const h = harness({ 'token-a': '900000000000000001' }, { gatewayUrl: undefined });

    const starting = h.transport.start({
      connectionId: 'c1',
      generation: 1,
      token: 'token-a',
      handlers: { onInbound: async () => 'inbound', onObservation: () => {} },
    });
    await settlement();

    expect(h.platform.requests.some((r) => r.url.endsWith('/gateway/bot'))).toBe(true);
    expect(h.platform.lastSocket().url).toBe(`${GATEWAY}?v=10&encoding=json`);

    h.platform.connect(h.platform.lastSocket());
    const observation = await starting;

    expect(observation).toMatchObject({
      connectionId: 'c1',
      generation: 1,
      state: 'connected',
      observedBotUserId: '900000000000000001',
      errorCode: null,
    });
    expect(h.transport.observe('c1')).toEqual(observation);
  });

  it('rejects a credential the platform refuses and records the error observation', async () => {
    const h = harness({ 'token-a': '900000000000000001' });

    await expect(
      h.transport.start({
        connectionId: 'c1',
        generation: 1,
        token: 'token-revoked',
        handlers: { onInbound: async () => 'inbound', onObservation: () => {} },
      }),
    ).rejects.toMatchObject({ code: 'credential_invalid' });

    expect(h.transport.observe('c1')).toMatchObject({ state: 'error', errorCode: 'credential_invalid' });
    expect(h.platform.sockets).toHaveLength(0);
  });

  it('stops a connection and keeps the disconnected observation', async () => {
    const h = harness({ 'token-a': '900000000000000001' });
    await h.connect('c1', 1, 'token-a');
    const socket = h.platform.lastSocket();

    await h.transport.stop('c1', 1);

    expect(socket.closed?.code).toBe(1000);
    expect(h.transport.observe('c1')).toMatchObject({ state: 'disconnected', errorCode: null });
    expect(h.transport.observe('c1')?.generation).toBe(1);
  });

  it('pushes every runtime state change to the observation handler', async () => {
    const h = harness({ 'token-a': '900000000000000001' });
    await h.connect('c1', 1, 'token-a');
    await h.transport.stop('c1', 1);

    expect(h.observations.map((observation) => observation.state)).toEqual([
      'disconnected',
      'connected',
      'disconnected',
    ]);
  });

  it('returns a disconnected observation when the platform never finishes the handshake', async () => {
    const h = harness({ 'token-a': '900000000000000001' }, { startSettleTimeoutMs: 20 });

    const starting = h.transport.start({
      connectionId: 'c1',
      generation: 1,
      token: 'token-a',
      handlers: { onInbound: async () => 'inbound', onObservation: () => {} },
    });
    await settlement();
    // Socket opened but HELLO never arrived: the transport must not claim it is
    // online, and must not hang `start` on a platform that never answers.
    h.platform.lastSocket().onopen?.({});

    const observation = await starting;
    expect(observation).toMatchObject({
      state: 'disconnected',
      errorCode: null,
      observedBotUserId: '900000000000000001',
    });
  });
});

// ─── inbound filtering ────────────────────────────────────────────────────────

describe('project channel discord transport: inbound filtering', () => {
  it('accepts a native mention with structured source facts', async () => {
    const h = harness({ 'token-a': '900000000000000001' });
    await h.connect('c1', 1, 'token-a');

    h.platform.lastSocket().receive({
      op: 0,
      s: 2,
      t: 'MESSAGE_CREATE',
      d: message({ id: '500000000000000001', botId: '900000000000000001', content: 'hi <@900000000000000001>' }),
    });
    await settlement();

    expect(h.inbound).toHaveLength(1);
    expect(h.inbound[0]).toMatchObject({
      connectionId: 'c1',
      generation: 1,
      guildId: GUILD,
      channelId: CHANNEL,
      senderId: '300000000000000003',
      authorIsBot: false,
      authorIsWebhook: false,
      mentionIds: ['900000000000000001'],
      text: 'hi',
    });
  });

  it('drops echoes, other bots, webhooks, DMs, unmentioned messages, and duplicates', async () => {
    const h = harness({ 'token-a': '900000000000000001' });
    await h.connect('c1', 1, 'token-a');
    const socket = h.platform.lastSocket();
    const botId = '900000000000000001';

    const dispatch = (payload: Record<string, unknown>): void => {
      socket.receive({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: payload });
    };

    dispatch(message({ id: '600000000000000001', botId, authorIsBot: true }));
    dispatch(message({ id: '600000000000000002', botId, authorId: '700000000000000007', authorIsBot: true }));
    dispatch(message({ id: '600000000000000003', botId, webhook: true }));
    dispatch(message({ id: '600000000000000004', botId, guildId: null }));
    dispatch(message({ id: '600000000000000005', botId, mentionIds: ['800000000000000008'] }));
    dispatch(message({ id: '600000000000000006', botId, content: '/help' , mentionIds: [] }));
    dispatch(message({ id: '600000000000000007', botId }));
    dispatch(message({ id: '600000000000000007', botId }));
    await settlement();

    expect(h.inbound).toHaveLength(1);
    expect(h.inbound[0]?.platformMessageId).toBe('600000000000000007');
  });

  it('marks an attachment-only mention as omitted instead of reading the file', async () => {
    const h = harness({ 'token-a': '900000000000000001' });
    await h.connect('c1', 1, 'token-a');
    const botId = '900000000000000001';

    h.platform.lastSocket().receive({
      op: 0,
      s: 2,
      t: 'MESSAGE_CREATE',
      d: {
        ...message({ id: '610000000000000001', botId, content: `<@${botId}>` }),
        attachments: [{ id: '1', url: 'https://cdn.test/a.png', filename: 'a.png' }],
      },
    });
    await settlement();

    expect(h.inbound).toHaveLength(1);
    expect(h.inbound[0]?.text).toContain('attachment omitted');
  });

  it('serializes inbound delivery so two questions cannot interleave', async () => {
    const order: string[] = [];
    const platform = new FakeDiscord();
    platform.bots.set('token-a', '900000000000000001');
    const transport = new ProjectDiscordTransport({
      fetchImpl: platform.fetchImpl,
      createSocket: platform.createSocket,
      apiBaseUrl: API,
      gatewayUrl: GATEWAY,
      minSendIntervalMs: 0,
      reconnect: { baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
      log: () => {},
    });

    const starting = transport.start({
      connectionId: 'c1',
      generation: 1,
      token: 'token-a',
      handlers: {
        onInbound: async (event) => {
          order.push(`start:${event.text}`);
          await settlement();
          order.push(`end:${event.text}`);
          return `inbound-${event.platformMessageId}`;
        },
        onObservation: () => {},
      },
    });
    await settlement();
    platform.connect(platform.lastSocket());

    const socket = platform.lastSocket();
    for (const [id, text] of [['620000000000000001', 'first'], ['620000000000000002', 'second']] as const) {
      socket.receive({
        op: 0,
        s: 2,
        t: 'MESSAGE_CREATE',
        d: message({ id, botId: '900000000000000001', content: `<@900000000000000001> ${text}` }),
      });
    }
    await waitFor(() => order.length === 4, 'both deliveries to finish');

    expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
    await starting;
  });
});

// ─── two Projects, one channel ────────────────────────────────────────────────

describe('project channel discord transport: connection isolation', () => {
  it('answers only the Bot that was natively mentioned in a shared channel', async () => {
    const h = harness({ 'token-a': '900000000000000001', 'token-b': '900000000000000002' });
    await h.connect('project-a', 1, 'token-a');
    const socketA = h.platform.lastSocket();
    await h.connect('project-b', 1, 'token-b');
    const socketB = h.platform.lastSocket();

    socketA.receive({
      op: 0,
      s: 2,
      t: 'MESSAGE_CREATE',
      d: message({ id: '700000000000000001', botId: '900000000000000001', mentionIds: ['900000000000000001'] }),
    });
    socketB.receive({
      op: 0,
      s: 2,
      t: 'MESSAGE_CREATE',
      d: message({ id: '700000000000000001', botId: '900000000000000002', mentionIds: ['900000000000000001'] }),
    });
    await settlement();

    expect(h.inbound).toHaveLength(1);
    expect(h.inbound[0]?.connectionId).toBe('project-a');
  });

  it('fences a replaced generation: the old socket cannot deliver or stop the new one', async () => {
    const h = harness({ 'token-a': '900000000000000001' });
    await h.connect('c1', 1, 'token-a');
    const oldSocket = h.platform.lastSocket();

    await h.connect('c1', 2, 'token-a');
    const newSocket = h.platform.lastSocket();
    expect(newSocket).not.toBe(oldSocket);

    oldSocket.receive({
      op: 0,
      s: 9,
      t: 'MESSAGE_CREATE',
      d: message({ id: '710000000000000001', botId: '900000000000000001' }),
    });
    newSocket.receive({
      op: 0,
      s: 2,
      t: 'MESSAGE_CREATE',
      d: message({ id: '710000000000000002', botId: '900000000000000001' }),
    });
    await settlement();

    expect(h.inbound.map((event) => event.platformMessageId)).toEqual(['710000000000000002']);
    expect(h.inbound[0]?.generation).toBe(2);

    // A stale stop must not silence the live generation either.
    await h.transport.stop('c1', 1);
    expect(h.transport.observe('c1')).toMatchObject({ generation: 2, state: 'connected' });
  });

  it('refuses sends addressed to a superseded generation', async () => {
    const h = harness({ 'token-a': '900000000000000001' });
    await h.connect('c1', 2, 'token-a');

    const result = await h.transport.send({
      deliveryId: 'd1',
      connectionId: 'c1',
      generation: 1,
      guildId: GUILD,
      channelId: CHANNEL,
      text: 'hello',
    });

    expect(result).toMatchObject({ code: 'generation_stale', retryable: false });
    expect(h.platform.sendAttempts).toBe(0);
  });

  it('reports a rotated token that now belongs to another Bot as an identity conflict', async () => {
    const h = harness({ 'token-a': '900000000000000001' });
    await h.connect('c1', 1, 'token-a');

    h.platform.lastSocket().receive({
      op: 0,
      s: 3,
      t: 'READY',
      d: { session_id: 'session-2', user: { id: '900000000000000099', username: 'someone-else' } },
    });
    await settlement();

    expect(h.transport.observe('c1')).toMatchObject({
      state: 'error',
      errorCode: 'bot_identity_conflict',
      observedBotUserId: '900000000000000099',
    });
  });
});

// ─── outbound ────────────────────────────────────────────────────────────────

describe('project channel discord transport: outbound', () => {
  it('sends with mentions disabled and returns the platform receipt', async () => {
    const h = harness({ 'token-a': '900000000000000001' });
    await h.connect('c1', 1, 'token-a');

    const result = await h.transport.send({
      deliveryId: 'd1',
      connectionId: 'c1',
      generation: 1,
      guildId: GUILD,
      channelId: CHANNEL,
      text: 'Build is green. @everyone',
      replyToPlatformMessageId: '800000000000000008',
    });

    expect(result).toEqual({ platformMessageId: 'platform-message-1' });
    const posted = h.platform.requests.filter((request) => request.method === 'POST');
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toMatchObject({
      content: 'Build is green. @everyone',
      allowed_mentions: { parse: [], roles: [], users: [], replied_user: false },
      message_reference: { message_id: '800000000000000008', fail_if_not_exists: false },
    });
  });

  it('refuses an empty body, an oversized body, and a malformed target before any request', async () => {
    const h = harness({ 'token-a': '900000000000000001' });
    await h.connect('c1', 1, 'token-a');

    const base = {
      deliveryId: 'd1',
      connectionId: 'c1',
      generation: 1,
      guildId: GUILD,
      channelId: CHANNEL,
    };

    expect(await h.transport.send({ ...base, text: '   ' })).toMatchObject({
      code: 'invalid_request',
      retryable: false,
    });
    expect(await h.transport.send({ ...base, text: 'x'.repeat(2001) })).toMatchObject({
      code: 'invalid_request',
    });
    expect(await h.transport.send({ ...base, text: 'hi', channelId: 'not-an-id' })).toMatchObject({
      code: 'invalid_target',
    });
    expect(h.platform.sendAttempts).toBe(0);
  });

  it('refuses a send while the connection is not connected', async () => {
    const h = harness({ 'token-a': '900000000000000001' });

    const result = await h.transport.send({
      deliveryId: 'd1',
      connectionId: 'c1',
      generation: 1,
      guildId: GUILD,
      channelId: CHANNEL,
      text: 'hi',
    });

    expect(result).toMatchObject({ code: 'transport_unavailable', retryable: true });
    expect(h.platform.sendAttempts).toBe(0);
  });

  it('classifies platform answers: forbidden, server error, and no response', async () => {
    const h = harness({ 'token-a': '900000000000000001' });
    await h.connect('c1', 1, 'token-a');

    h.platform.sendResponse = () => jsonResponse(403, { message: 'missing access' });
    expect(await sendOnce(h.transport)).toMatchObject({ code: 'delivery_failed', retryable: false });

    h.platform.sendResponse = () => jsonResponse(500, { message: 'internal' });
    expect(await sendOnce(h.transport)).toMatchObject({ code: 'delivery_unknown', retryable: false });

    h.platform.sendResponse = () => {
      throw new TypeError('socket hang up');
    };
    expect(await sendOnce(h.transport)).toMatchObject({ code: 'delivery_unknown', retryable: false });
  });

  it('retries a short rate limit inline and hands a long one back to the caller', async () => {
    const h = harness({ 'token-a': '900000000000000001' });
    await h.connect('c1', 1, 'token-a');

    h.platform.sendResponse = (_request, attempt) =>
      attempt === 1
        ? jsonResponse(429, { retry_after: 0 }, { 'retry-after': '0' })
        : jsonResponse(200, { id: 'platform-message-retry' });
    expect(await sendOnce(h.transport)).toEqual({ platformMessageId: 'platform-message-retry' });
    expect(h.platform.sendAttempts).toBe(2);

    h.platform.sendAttempts = 0;
    h.platform.sendResponse = () => jsonResponse(429, { retry_after: 10 }, { 'retry-after': '10' });
    const limited = await sendOnce(h.transport);
    expect(limited).toMatchObject({ code: 'delivery_retryable', retryable: true, retryAfterMs: 10_000 });
    expect(h.platform.sendAttempts).toBe(1);
  });
});

// ─── reconnect ───────────────────────────────────────────────────────────────

describe('project channel discord transport: reconnect', () => {
  it('resumes the existing session after a drop', async () => {
    const h = harness({ 'token-a': '900000000000000001' });
    await h.connect('c1', 1, 'token-a');
    const first = h.platform.lastSocket();

    first.close(4000, 'test drop');
    await waitFor(() => h.platform.sockets.length === 2, 'a reconnect socket');

    const resumed = h.platform.lastSocket();
    expect(resumed).not.toBe(first);
    expect(resumed.url).toBe(`${GATEWAY}/resume?v=10&encoding=json`);

    h.platform.connect(resumed);
    await settlement();

    const resumeOp = resumed.sent.find((payload) => (payload as { op: number }).op === 6);
    expect(resumeOp).toMatchObject({ d: { session_id: 'session-1', seq: 1 } });
    expect(h.transport.observe('c1')).toMatchObject({ state: 'connected' });
  });

  it('drops a session whose heartbeat is never acknowledged instead of resuming it', async () => {
    const h = harness({ 'token-a': '900000000000000001' });
    await h.connect('c1', 1, 'token-a');
    // The harness opens sockets with a 45s heartbeat by default; re-handshake
    // this one with a short interval so the zombie path is reachable.
    const socket = h.platform.lastSocket();
    h.platform.hello(socket, 5);
    await new Promise((resolve) => setTimeout(resolve, 40));

    const next = h.platform.lastSocket();
    expect(next).not.toBe(socket);
    h.platform.connect(next);
    await settlement();

    const ops = next.ops();
    expect(ops).toContain(2);
    expect(ops).not.toContain(6);
  });
});
