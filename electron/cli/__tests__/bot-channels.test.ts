/**
 * bot-channels.test.ts — unit tests for the agent-scoped channel binding
 * HTTP handlers: GET/POST /v1/agents/:agentId/channels*.
 *
 * A binding is a gateway profile route (platform[, chatId] → bot config-agent
 * id). The './extra' helpers and the profile-route store are mocked so no
 * Electron app, config.toml, or audit log is touched.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  agentLookup: vi.fn(),
  responses: [] as Array<{ status: number; body: unknown }>,
  body: {} as Record<string, unknown>,
  audit: vi.fn(),
  routes: {
    listGatewayPlatforms: vi.fn(),
    listBotProfileRoutes: vi.fn(),
    addBotProfileRoute: vi.fn(),
    removeBotProfileRoute: vi.fn(),
  },
}));

function sendJson(res: unknown, status: number, body: unknown): void {
  mocks.responses.push({ status, body });
}

async function readJsonBody(): Promise<Record<string, unknown>> {
  return mocks.body;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

vi.mock('../handlers/extra', () => ({
  sendJson,
  readJsonBody,
  asString,
  recordAudit: mocks.audit,
}));

vi.mock('../../config/agents', () => ({
  getLiveConfigAgent: (id: string) => mocks.agentLookup(id),
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => mocks.logger,
  LogComponent: new Proxy({}, { get: (_t, p) => String(p) }),
}));

vi.mock('../../channels/profile-routes', () => ({
  listGatewayPlatforms: mocks.routes.listGatewayPlatforms,
  listBotProfileRoutes: mocks.routes.listBotProfileRoutes,
  addBotProfileRoute: mocks.routes.addBotProfileRoute,
  removeBotProfileRoute: mocks.routes.removeBotProfileRoute,
}));

import {
  handleAgentChannelList,
  handleAgentChannelConnect,
  handleAgentChannelDisconnect,
} from '../handlers/bot-channels';

type FakeReq = IncomingMessage;
type FakeRes = ServerResponse;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.responses.length = 0;
  mocks.body = {};
  mocks.agentLookup.mockReset();
});

describe('handleAgentChannelList', () => {
  it('404s for an unknown agent', async () => {
    mocks.agentLookup.mockReturnValue(undefined);
    await handleAgentChannelList({} as unknown as FakeReq, {} as unknown as FakeRes, 'bot-x');
    expect(mocks.responses[0]?.status).toBe(404);
    expect((mocks.responses[0]?.body as { error: { code: string } }).error.code).toBe('agent_not_found');
  });

  it('returns the bound channels', async () => {
    mocks.agentLookup.mockReturnValue({ id: 'bot-x' });
    mocks.routes.listBotProfileRoutes.mockReturnValue([
      { platform: 'telegram', profile: 'bot-x', chatId: '123' },
    ]);
    await handleAgentChannelList({} as unknown as FakeReq, {} as unknown as FakeRes, 'bot-x');
    const { status, body } = mocks.responses[0]!;
    expect(status).toBe(200);
    const channels = (body as { channels: Array<{ platform: string; chatId?: string }> }).channels;
    expect(channels).toEqual([{ platform: 'telegram', profile: 'bot-x', chatId: '123' }]);
  });
});

describe('handleAgentChannelConnect', () => {
  const req = {} as unknown as FakeReq;
  const res = {} as unknown as FakeRes;

  it('404s for an unknown agent', async () => {
    mocks.body = { platform: 'telegram' };
    mocks.agentLookup.mockReturnValue(undefined);
    await handleAgentChannelConnect(req, res, undefined, 'bot-x');
    expect(mocks.responses[0]?.status).toBe(404);
  });

  it('rejects a platform with no gateway adapter', async () => {
    mocks.body = { platform: 'irc' };
    mocks.agentLookup.mockReturnValue({ id: 'bot-x' });
    mocks.routes.listGatewayPlatforms.mockReturnValue([
      { platform: 'telegram', enabled: true, hasCredentials: true },
    ]);
    await handleAgentChannelConnect(req, res, undefined, 'bot-x');
    expect(mocks.responses[0]?.status).toBe(400);
    expect((mocks.responses[0]?.body as { error: { code: string } }).error.code).toBe('unknown_platform');
  });

  it('binds and audits', async () => {
    mocks.body = { platform: 'telegram', chatId: '123', label: 'ops' };
    mocks.agentLookup.mockReturnValue({ id: 'bot-x' });
    mocks.routes.listGatewayPlatforms.mockReturnValue([
      { platform: 'telegram', enabled: true, hasCredentials: true },
    ]);
    mocks.routes.addBotProfileRoute.mockReturnValue({ ok: true });
    await handleAgentChannelConnect(req, res, 'corr-1', 'bot-x');
    expect(mocks.responses[0]?.status).toBe(200);
    expect(mocks.routes.addBotProfileRoute).toHaveBeenCalledWith('bot-x', 'telegram', '123', undefined, 'ops');
    expect(mocks.audit).toHaveBeenCalledWith(req, 'corr-1', 'channel.connect', 'bot-x:telegram:123');
  });

  it('maps store failures to 502', async () => {
    mocks.body = { platform: 'telegram' };
    mocks.agentLookup.mockReturnValue({ id: 'bot-x' });
    mocks.routes.listGatewayPlatforms.mockReturnValue([
      { platform: 'telegram', enabled: true, hasCredentials: true },
    ]);
    mocks.routes.addBotProfileRoute.mockReturnValue({ ok: false, error: 'store_failed' });
    await handleAgentChannelConnect(req, res, undefined, 'bot-x');
    expect(mocks.responses[0]?.status).toBe(502);
  });
});

describe('handleAgentChannelDisconnect', () => {
  const req = {} as unknown as FakeReq;
  const res = {} as unknown as FakeRes;

  it('rejects a missing platform', async () => {
    mocks.body = {};
    mocks.agentLookup.mockReturnValue({ id: 'bot-x' });
    await handleAgentChannelDisconnect(req, res, undefined, 'bot-x');
    expect(mocks.responses[0]?.status).toBe(400);
  });

  it('unbinds and audits', async () => {
    mocks.body = { platform: 'telegram', chatId: '123' };
    mocks.agentLookup.mockReturnValue({ id: 'bot-x' });
    mocks.routes.removeBotProfileRoute.mockReturnValue({ ok: true });
    await handleAgentChannelDisconnect(req, res, undefined, 'bot-x');
    expect(mocks.responses[0]?.status).toBe(200);
    expect(mocks.routes.removeBotProfileRoute).toHaveBeenCalledWith('bot-x', 'telegram', '123');
    expect(mocks.audit).toHaveBeenCalledWith(req, undefined, 'channel.disconnect', 'bot-x:telegram:123');
  });

  it('maps not_found to 404', async () => {
    mocks.body = { platform: 'telegram' };
    mocks.agentLookup.mockReturnValue({ id: 'bot-x' });
    mocks.routes.removeBotProfileRoute.mockReturnValue({ ok: false, error: 'not_found' });
    await handleAgentChannelDisconnect(req, res, undefined, 'bot-x');
    expect(mocks.responses[0]?.status).toBe(404);
  });
});
