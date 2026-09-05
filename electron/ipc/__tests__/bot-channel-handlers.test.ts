/**
 * bot-channel-handlers.test.ts — unit tests for the botChannels:* IPC
 * channels (per-bot channel bindings = gateway profile routes).
 *
 * The profile-route store is mocked so no config.toml access happens here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  captured: {
    handle: new Map<string, (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>>(),
  },
  agentLookup: vi.fn(),
  routes: {
    listGatewayPlatforms: vi.fn(),
    listBotProfileRoutes: vi.fn(),
    addBotProfileRoute: vi.fn(),
    removeBotProfileRoute: vi.fn(),
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

vi.mock('../../channels/profile-routes', () => ({
  listGatewayPlatforms: mocks.routes.listGatewayPlatforms,
  listBotProfileRoutes: mocks.routes.listBotProfileRoutes,
  addBotProfileRoute: mocks.routes.addBotProfileRoute,
  removeBotProfileRoute: mocks.routes.removeBotProfileRoute,
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
  it('returns the configured gateway platforms', async () => {
    mocks.routes.listGatewayPlatforms.mockReturnValue([
      { platform: 'telegram', enabled: true, hasCredentials: true },
    ]);
    const res = (await invokeHandler('botChannels:manifests')) as {
      platforms: Array<{ platform: string }>;
    };
    expect(res.platforms).toEqual([{ platform: 'telegram', enabled: true, hasCredentials: true }]);
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

  it('returns the agent profile routes', async () => {
    mocks.agentLookup.mockReturnValue({ id: 'bot-x' });
    mocks.routes.listBotProfileRoutes.mockReturnValue([
      { platform: 'telegram', profile: 'bot-x' },
    ]);
    const res = (await invokeHandler('botChannels:list', {}, 'bot-x')) as {
      routes: Array<{ platform: string }>;
    };
    expect(res.routes).toHaveLength(1);
    expect(res.routes[0].platform).toBe('telegram');
  });
});

describe('botChannels:connect', () => {
  it('rejects a missing platform', async () => {
    mocks.agentLookup.mockReturnValue({ id: 'bot-x' });
    const res = (await invokeHandler('botChannels:connect', {}, 'bot-x', {
      chatId: '123',
    })) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toBe('unknown_platform');
  });

  it('delegates to addBotProfileRoute with chat scoping', async () => {
    mocks.agentLookup.mockReturnValue({ id: 'bot-x' });
    mocks.routes.addBotProfileRoute.mockReturnValue({ ok: true });
    const res = (await invokeHandler('botChannels:connect', {}, 'bot-x', {
      platform: 'telegram',
      chatId: '  12345  ',
      label: 'ops group',
    })) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(mocks.routes.addBotProfileRoute).toHaveBeenCalledWith(
      'bot-x',
      'telegram',
      '12345',
      undefined,
      'ops group',
    );
  });

  it('propagates the store error', async () => {
    mocks.agentLookup.mockReturnValue({ id: 'bot-x' });
    mocks.routes.addBotProfileRoute.mockReturnValue({ ok: false, error: 'unknown_platform' });
    const res = (await invokeHandler('botChannels:connect', {}, 'bot-x', {
      platform: 'irc',
    })) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toBe('unknown_platform');
  });
});

describe('botChannels:disconnect', () => {
  it('rejects an unknown platform', async () => {
    mocks.agentLookup.mockReturnValue({ id: 'bot-x' });
    const res = (await invokeHandler('botChannels:disconnect', {}, 'bot-x', '')) as {
      ok: boolean;
      error?: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toBe('unknown_platform');
  });

  it('calls removeBotProfileRoute on success', async () => {
    mocks.agentLookup.mockReturnValue({ id: 'bot-x' });
    mocks.routes.removeBotProfileRoute.mockReturnValue({ ok: true });
    const res = (await invokeHandler('botChannels:disconnect', {}, 'bot-x', 'telegram', '123')) as {
      ok: boolean;
    };
    expect(res.ok).toBe(true);
    expect(mocks.routes.removeBotProfileRoute).toHaveBeenCalledWith('bot-x', 'telegram', '123');
  });
});
