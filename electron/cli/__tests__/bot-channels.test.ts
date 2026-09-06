/**
 * bot-channels.test.ts — unit tests for the agent-scoped channel binding
 * HTTP handlers (plan 488 grok-form): GET/POST /v1/agents/:agentId/channels*.
 *
 * The './extra' helpers (sendJson / readJsonBody / recordAudit) and the
 * channel stores are mocked so no Electron app, filesystem, or audit log is
 * touched.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  agentLookup: vi.fn(),
  responses: [] as Array<{ status: number; body: unknown }>,
  body: {} as Record<string, unknown>,
  audit: vi.fn(),
  channels: {
    listAgentChannels: vi.fn(),
    storeConnectorCredential: vi.fn(),
    disconnectChannel: vi.fn(),
  },
  store: { writeMetadata: vi.fn() },
  connectorManager: { sync: vi.fn() },
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

vi.mock('../../channels/agent-session-channels', () => ({
  listAgentChannels: mocks.channels.listAgentChannels,
  storeConnectorCredential: mocks.channels.storeConnectorCredential,
  disconnectChannel: mocks.channels.disconnectChannel,
}));

vi.mock('../../channels/channel-store', () => ({
  openChannelStore: () => mocks.store,
}));

vi.mock('../../channels/connector-runtime', () => ({
  getBotConnectorManager: () => mocks.connectorManager,
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

  it('returns the bound channels without credentials', async () => {
    mocks.agentLookup.mockReturnValue({ id: 'bot-x' });
    mocks.channels.listAgentChannels.mockReturnValue([
      { platform: 'telegram', label: 'My Bot', status: 'configured' },
    ]);
    await handleAgentChannelList({} as unknown as FakeReq, {} as unknown as FakeRes, 'bot-x');
    const { status, body } = mocks.responses[0]!;
    expect(status).toBe(200);
    const channels = (body as { channels: Array<{ platform: string; label: string }> }).channels;
    expect(channels).toEqual([{ platform: 'telegram', label: 'My Bot', status: 'configured', displayName: 'Telegram' }]);
  });
});

describe('handleAgentChannelConnect', () => {
  const req = {} as unknown as FakeReq;
  const res = {} as unknown as FakeRes;

  it('rejects an invalid JSON body', async () => {
    mocks.body = Promise.reject(new Error('bad json')) as unknown as Record<string, unknown>;
    await handleAgentChannelConnect(req, res, undefined, 'bot-x');
    expect(mocks.responses[0]?.status).toBe(400);
  });

  it('404s for an unknown agent', async () => {
    mocks.body = { platform: 'telegram', credential: 'tok' };
    mocks.agentLookup.mockReturnValue(undefined);
    await handleAgentChannelConnect(req, res, undefined, 'bot-x');
    expect(mocks.responses[0]?.status).toBe(404);
  });

  it('rejects an unknown platform', async () => {
    mocks.body = { platform: 'irc', credential: 'tok' };
    mocks.agentLookup.mockReturnValue({ id: 'bot-x' });
    await handleAgentChannelConnect(req, res, undefined, 'bot-x');
    expect(mocks.responses[0]?.status).toBe(400);
    expect((mocks.responses[0]?.body as { error: { code: string } }).error.code).toBe('unknown_platform');
  });

  it('rejects a missing credential', async () => {
    mocks.body = { platform: 'telegram' };
    mocks.agentLookup.mockReturnValue({ id: 'bot-x' });
    await handleAgentChannelConnect(req, res, undefined, 'bot-x');
    expect(mocks.responses[0]?.status).toBe(400);
    expect((mocks.responses[0]?.body as { error: { code: string } }).error.code).toBe('missing_credential');
  });

  it('stores the credential, writes metadata, syncs connectors, and audits', async () => {
    mocks.body = { platform: 'telegram', credential: 'tok-1', label: 'Main' };
    mocks.agentLookup.mockReturnValue({ id: 'bot-x' });
    await handleAgentChannelConnect(req, res, 'corr-1', 'bot-x');
    expect(mocks.responses[0]?.status).toBe(200);
    expect(mocks.channels.storeConnectorCredential).toHaveBeenCalledWith('bot-x', 'telegram', 'token', 'tok-1');
    expect(mocks.store.writeMetadata).toHaveBeenCalledWith('telegram', 'Main');
    expect(mocks.connectorManager.sync).toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(req, 'corr-1', 'channel.connect', 'bot-x:telegram', expect.any(String));
  });
});

describe('handleAgentChannelDisconnect', () => {
  const req = {} as unknown as FakeReq;
  const res = {} as unknown as FakeRes;

  it('rejects an unknown platform', async () => {
    mocks.body = { platform: 'irc' };
    mocks.agentLookup.mockReturnValue({ id: 'bot-x' });
    await handleAgentChannelDisconnect(req, res, undefined, 'bot-x');
    expect(mocks.responses[0]?.status).toBe(400);
  });

  it('disconnects, syncs connectors, and audits', async () => {
    mocks.body = { platform: 'telegram' };
    mocks.agentLookup.mockReturnValue({ id: 'bot-x' });
    await handleAgentChannelDisconnect(req, res, undefined, 'bot-x');
    expect(mocks.responses[0]?.status).toBe(200);
    expect(mocks.channels.disconnectChannel).toHaveBeenCalledWith('bot-x', 'telegram');
    expect(mocks.connectorManager.sync).toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(req, undefined, 'channel.disconnect', 'bot-x:telegram');
  });
});
