/**
 * bot-channels.test.ts — unit tests for the agent-scoped channel binding
 * HTTP handlers (plan 488): GET/POST /v1/agents/:agentId/channels*.
 *
 * The './extra' helpers (sendJson / readJsonBody / recordAudit) are mocked so
 * no Electron app, filesystem, or audit log is touched. The domain stores are
 * mocked the same way.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  db: { get: vi.fn() },
  responses: [] as Array<{ status: number; body: unknown }>,
  body: {} as Record<string, unknown>,
  audit: vi.fn(),
  channels: {
    listAgentChannels: vi.fn(),
    storeConnectorCredential: vi.fn(),
    disconnectChannel: vi.fn(),
  },
  store: { writeMetadata: vi.fn() },
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

vi.mock('../../ipc/db-handlers', () => ({
  getDatabase: () => ({
    prepare: () => ({ get: mocks.db.get }),
  }),
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

import {
  handleAgentChannelList,
  handleAgentChannelConnect,
  handleAgentChannelDisconnect,
} from '../handlers/bot-channels';

type FakeRes = Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.responses.length = 0;
  mocks.body = {};
  mocks.db.get.mockReset();
});

describe('handleAgentChannelList', () => {
  it('404s for an unknown agent', async () => {
    mocks.db.get.mockReturnValue(undefined);
    await handleAgentChannelList({} as FakeRes, {} as FakeRes, 'bot-x');
    expect(mocks.responses[0]?.status).toBe(404);
    expect((mocks.responses[0]?.body as { error: { code: string } }).error.code).toBe('agent_not_found');
  });

  it('returns the bound channels without credentials', async () => {
    mocks.db.get.mockReturnValue({ id: 'bot-x' });
    mocks.channels.listAgentChannels.mockReturnValue([
      { platform: 'discord', label: 'My Server', status: 'configured' },
    ]);
    await handleAgentChannelList({} as FakeRes, {} as FakeRes, 'bot-x');
    const { status, body } = mocks.responses[0]!;
    expect(status).toBe(200);
    const channels = (body as { channels: Array<{ platform: string; label: string }> }).channels;
    expect(channels).toEqual([{ platform: 'discord', label: 'My Server', status: 'configured', displayName: 'Discord' }]);
  });
});

describe('handleAgentChannelConnect', () => {
  const req = {} as FakeRes;
  const res = {} as FakeRes;

  it('rejects an invalid JSON body', async () => {
    mocks.body = Promise.reject(new Error('bad json')) as unknown as Record<string, unknown>;
    await handleAgentChannelConnect(req, res, undefined, 'bot-x');
    expect(mocks.responses[0]?.status).toBe(400);
  });

  it('404s for an unknown agent', async () => {
    mocks.body = { platform: 'discord', credential: 'tok' };
    mocks.db.get.mockReturnValue(undefined);
    await handleAgentChannelConnect(req, res, undefined, 'bot-x');
    expect(mocks.responses[0]?.status).toBe(404);
  });

  it('rejects an unknown platform', async () => {
    mocks.body = { platform: 'telegram', credential: 'tok' };
    mocks.db.get.mockReturnValue({ id: 'bot-x' });
    await handleAgentChannelConnect(req, res, undefined, 'bot-x');
    expect(mocks.responses[0]?.status).toBe(400);
    expect((mocks.responses[0]?.body as { error: { code: string } }).error.code).toBe('unknown_platform');
  });

  it('rejects a missing credential', async () => {
    mocks.body = { platform: 'discord' };
    mocks.db.get.mockReturnValue({ id: 'bot-x' });
    await handleAgentChannelConnect(req, res, undefined, 'bot-x');
    expect(mocks.responses[0]?.status).toBe(400);
    expect((mocks.responses[0]?.body as { error: { code: string } }).error.code).toBe('missing_credential');
  });

  it('stores the credential, writes metadata, and audits', async () => {
    mocks.body = { platform: 'discord', credential: 'tok-1', label: 'Main' };
    mocks.db.get.mockReturnValue({ id: 'bot-x' });
    await handleAgentChannelConnect(req, res, 'corr-1', 'bot-x');
    expect(mocks.responses[0]?.status).toBe(200);
    expect(mocks.channels.storeConnectorCredential).toHaveBeenCalledWith('bot-x', 'discord', 'token', 'tok-1');
    expect(mocks.store.writeMetadata).toHaveBeenCalledWith('discord', 'Main');
    expect(mocks.audit).toHaveBeenCalledWith(req, 'corr-1', 'channel.connect', 'bot-x:discord', expect.any(String));
  });
});

describe('handleAgentChannelDisconnect', () => {
  const req = {} as FakeRes;
  const res = {} as FakeRes;

  it('rejects an unknown platform', async () => {
    mocks.body = { platform: 'irc' };
    mocks.db.get.mockReturnValue({ id: 'bot-x' });
    await handleAgentChannelDisconnect(req, res, undefined, 'bot-x');
    expect(mocks.responses[0]?.status).toBe(400);
  });

  it('disconnects and audits', async () => {
    mocks.body = { platform: 'slack' };
    mocks.db.get.mockReturnValue({ id: 'bot-x' });
    await handleAgentChannelDisconnect(req, res, undefined, 'bot-x');
    expect(mocks.responses[0]?.status).toBe(200);
    expect(mocks.channels.disconnectChannel).toHaveBeenCalledWith('bot-x', 'slack');
    expect(mocks.audit).toHaveBeenCalledWith(req, undefined, 'channel.disconnect', 'bot-x:slack');
  });
});
