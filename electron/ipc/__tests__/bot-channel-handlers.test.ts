/**
 * bot-channel-handlers.test.ts — unit tests for the botChannels:* IPC
 * channels (per-bot channel bindings, plan 488).
 *
 * The handlers wrap the agent-scoped channel store + connector secret store.
 * Both are mocked here so no filesystem access happens in tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  captured: {
    handle: new Map<string, (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>>(),
  },
  agentLookup: vi.fn(),
  responses: [],
  channels: {
    listAgentChannels: vi.fn(),
    storeConnectorCredential: vi.fn(),
    disconnectChannel: vi.fn(),
  },
  store: {
    writeMetadata: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (c: string, fn: (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>) => {
      mocks.captured.handle.set(c, fn);
    },
  },
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

import { registerBotChannelHandlers } from '../bot-channel-handlers';

async function invokeHandler(
  channel: string,
  event: unknown = {},
  ...args: unknown[]
): Promise<unknown> {
  const handler = mocks.captured.handle.get(channel);
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`);
  return await handler(event, ...args);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.agentLookup.mockReset();
  registerBotChannelHandlers();
});

describe('botChannels:manifests', () => {
  it('returns the connector manifests', async () => {
    const res = (await invokeHandler('botChannels:manifests')) as { manifests: Array<{ platform: string }> };
    expect(res.manifests.map((m) => m.platform)).toEqual(['discord', 'slack']);
  });
});

describe('botChannels:list', () => {
  it('rejects an empty agentId', async () => {
    const res = (await invokeHandler('botChannels:list', {}, '')) as { error?: string };
    expect(res.error).toBe('invalid_agent');
  });

  it('reports agent_not_found for an unknown agent', async () => {
    mocks.agentLookup.mockReturnValue(undefined);
    const res = (await invokeHandler('botChannels:list', {}, 'bot-x')) as { error?: string };
    expect(res.error).toBe('agent_not_found');
  });

  it('returns the agent channel connections', async () => {
    mocks.agentLookup.mockReturnValue({ id: 'bot-x' });
    mocks.channels.listAgentChannels.mockReturnValue([
      { platform: 'discord', label: 'Discord', status: 'configured' },
    ]);
    const res = (await invokeHandler('botChannels:list', {}, 'bot-x')) as {
      channels: Array<{ platform: string }>;
    };
    expect(res.channels).toHaveLength(1);
    expect(res.channels[0].platform).toBe('discord');
  });
});

describe('botChannels:connect', () => {
  it('rejects an unknown platform', async () => {
    mocks.agentLookup.mockReturnValue({ id: 'bot-x' });
    const res = (await invokeHandler('botChannels:connect', {}, 'bot-x', {
      platform: 'telegram',
      credential: 'tok',
    })) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toBe('unknown_platform');
  });

  it('rejects a missing credential', async () => {
    mocks.agentLookup.mockReturnValue({ id: 'bot-x' });
    const res = (await invokeHandler('botChannels:connect', {}, 'bot-x', {
      platform: 'discord',
      credential: '   ',
    })) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toBe('missing_credential');
  });

  it('stores the credential and writes metadata on success', async () => {
    mocks.agentLookup.mockReturnValue({ id: 'bot-x' });
    const res = (await invokeHandler('botChannels:connect', {}, 'bot-x', {
      platform: 'discord',
      label: 'My Server',
      credential: 'tok-123',
    })) as { ok: boolean; platform?: string };
    expect(res.ok).toBe(true);
    expect(mocks.channels.storeConnectorCredential).toHaveBeenCalledWith('bot-x', 'discord', 'token', 'tok-123');
    expect(mocks.store.writeMetadata).toHaveBeenCalledWith('discord', 'My Server');
  });

  it('falls back to the manifest display name when no label is given', async () => {
    mocks.agentLookup.mockReturnValue({ id: 'bot-x' });
    await invokeHandler('botChannels:connect', {}, 'bot-x', {
      platform: 'slack',
      credential: 'tok',
    });
    expect(mocks.store.writeMetadata).toHaveBeenCalledWith('slack', 'Slack');
  });
});

describe('botChannels:disconnect', () => {
  it('rejects an unknown platform', async () => {
    mocks.agentLookup.mockReturnValue({ id: 'bot-x' });
    const res = (await invokeHandler('botChannels:disconnect', {}, 'bot-x', 'telegram')) as {
      ok: boolean;
      error?: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toBe('unknown_platform');
  });

  it('calls disconnectChannel on success', async () => {
    mocks.agentLookup.mockReturnValue({ id: 'bot-x' });
    const res = (await invokeHandler('botChannels:disconnect', {}, 'bot-x', 'discord')) as {
      ok: boolean;
    };
    expect(res.ok).toBe(true);
    expect(mocks.channels.disconnectChannel).toHaveBeenCalledWith('bot-x', 'discord');
  });
});
