/**
 * electron/automation/Scheduler.test.ts
 *
 * Regression tests for the cron scheduler runtime hardening:
 *   - resolveCronProvider: picks the provider whose enabled models contain
 *     the cron's model, then falls back to the default provider, then to any
 *     configured provider with an API key, and finally throws a useful error.
 *   - runInSession sends a complete init payload (workingDirectory,
 *     defaultWorkspaceDirectory, systemPrompt, systemLocation,
 *     browserBackendMode) and an acquire timeout is applied so a saturated
 *     pool cannot hang the run in 'running' forever.
 *
 * better-sqlite3 is mocked so these tests do not depend on the native
 * binding's Node ABI version.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('better-sqlite3', () => {
  class FakeDB {
    prepare() {
      return {
        run: () => ({ changes: 1 }),
        get: () => undefined,
        all: () => [],
      };
    }
  }
  return { default: FakeDB };
});

vi.mock('electron', () => ({
  app: {
    getLocale: () => 'en-US',
    getLocaleCountryCode: () => 'US',
  },
}));

const configManagerMock = {
  getAllProviders: vi.fn(),
  getDefaultProvider: vi.fn(),
  getConfig: vi.fn(() => ({ defaultProviderId: null })),
  onConfigChange: vi.fn(() => () => {}),
};
vi.mock('../config/manager', () => ({
  getConfigManager: () => configManagerMock,
  toLLMProvider: (t: string) => (t === 'anthropic' ? 'anthropic' : 'openai'),
}));

const poolMock = {
  acquire: vi.fn(),
  waitForReady: vi.fn(),
  send: vi.fn(),
  onMessage: vi.fn(),
  removeMessageHandler: vi.fn(),
  release: vi.fn(),
};
vi.mock('../agents/process-pool/agent-process-pool', () => ({
  getAgentProcessPool: () => poolMock,
}));

vi.mock('../ipc/db-handlers', () => ({
  getDatabase: () => null,
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    time: vi.fn(),
    timeAsync: vi.fn(),
  }),
  LogComponent: { Automation: 'Automation' },
}));

import { resolveCronProvider, AutomationScheduler } from './Scheduler';

const fakeDb = {
  prepare: () => ({
    run: () => ({ changes: 1 }),
    get: () => undefined,
    all: () => [],
  }),
};

const makeProvider = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1',
  providerType: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  options: {},
  ...overrides,
});

describe('resolveCronProvider', () => {
  beforeEach(() => {
    configManagerMock.getAllProviders.mockReset();
    configManagerMock.getDefaultProvider.mockReset();
  });

  it('prefers the provider whose enabled_models contains the cron model', () => {
    const a = makeProvider({ id: 'a', options: { enabled_models: ['one', 'two'] } });
    const b = makeProvider({ id: 'b', options: { enabled_models: ['three'] } });
    configManagerMock.getAllProviders.mockReturnValue({ a, b });
    configManagerMock.getDefaultProvider.mockReturnValue(a);

    const { provider, model } = resolveCronProvider({ model: 'two' } as never);
    expect(provider.id).toBe('a');
    expect(model).toBe('two');
  });

  it('falls back to the default provider when no provider lists the model', () => {
    const a = makeProvider({ id: 'a', options: { enabled_models: ['one'] } });
    const b = makeProvider({ id: 'b', options: { enabled_models: ['other'] } });
    configManagerMock.getAllProviders.mockReturnValue({ a, b });
    configManagerMock.getDefaultProvider.mockReturnValue(b);

    const { provider } = resolveCronProvider({ model: 'unlisted' } as never);
    expect(provider.id).toBe('b');
  });

  it('falls back to any provider with an API key when no default is set', () => {
    const a = makeProvider({ id: 'a', options: { enabled_models: [] }, apiKey: '' });
    const b = makeProvider({ id: 'b', options: { enabled_models: [] }, apiKey: 'sk-b' });
    configManagerMock.getAllProviders.mockReturnValue({ a, b });
    configManagerMock.getDefaultProvider.mockReturnValue(undefined);

    const { provider } = resolveCronProvider({ model: 'x' } as never);
    expect(provider.id).toBe('b');
  });

  it('throws a useful error when no provider is configured', () => {
    configManagerMock.getAllProviders.mockReturnValue({});
    configManagerMock.getDefaultProvider.mockReturnValue(undefined);
    expect(() => resolveCronProvider({ model: 'x' } as never)).toThrow('no active provider configured');
  });
});

describe('AutomationScheduler.runInSession', () => {
  beforeEach(() => {
    poolMock.acquire.mockReset();
    poolMock.waitForReady.mockReset();
    poolMock.send.mockReset();
    poolMock.onMessage.mockReset();
    poolMock.removeMessageHandler.mockReset();
    poolMock.release.mockReset();
  });

  it('sends a complete init payload (workingDirectory, systemPrompt, systemLocation, browserBackendMode)', async () => {
    const provider = makeProvider({ providerType: 'anthropic' });
    configManagerMock.getAllProviders.mockReturnValue({ p1: provider });
    configManagerMock.getDefaultProvider.mockReturnValue(provider);

    poolMock.acquire.mockResolvedValue({ isNew: true });
    poolMock.waitForReady.mockResolvedValue(undefined);
    let initSent: Record<string, unknown> | undefined;
    poolMock.send.mockImplementation((_sid: string, msg: Record<string, unknown>) => {
      if (msg.type === 'init') initSent = msg;
      if (msg.type === 'chat:start') {
        setImmediate(() => {
          // Simulate the worker streaming a reply and completing.
          (poolMock.onMessage.mock.calls[0][1] as (m: Record<string, unknown>) => void)({ type: 'chat:text', content: 'hello world' });
          (poolMock.onMessage.mock.calls[0][1] as (m: Record<string, unknown>) => void)({ type: 'chat:done' });
        });
      }
      return true;
    });

    const scheduler = new AutomationScheduler(fakeDb as never);
    const result = await scheduler['runInSession']({ model: 'claude', concurrency_policy: 'skip' } as never, 'cron:test:1:r1');

    expect(initSent).toBeDefined();
    expect(initSent!.type).toBe('init');
    expect(initSent!.workingDirectory).toBeTruthy();
    expect(initSent!.defaultWorkspaceDirectory).toBeTruthy();
    expect(initSent!.systemPrompt).toBe('');
    expect((initSent!.systemLocation as Record<string, unknown>).locale).toBe('en-US');
    expect(initSent!.browserBackendMode).toBe('auto');
    expect(initSent!.providerConfig).toMatchObject({ model: 'claude', provider: 'anthropic' });
    expect(result).toBe('hello world');
  });

  it('times out when the pool never frees a slot instead of hanging forever', async () => {
    vi.useFakeTimers();
    try {
      const provider = makeProvider({ providerType: 'anthropic' });
      configManagerMock.getAllProviders.mockReturnValue({ p1: provider });
      configManagerMock.getDefaultProvider.mockReturnValue(provider);
      // acquire never resolves: the slot is saturated by other sessions.
      poolMock.acquire.mockReturnValue(new Promise(() => {}));

      const scheduler = new AutomationScheduler(fakeDb as never);
      const promise = scheduler['runInSession']({ model: 'claude', concurrency_policy: 'skip' } as never, 'cron:test:1:r1');
      // Mark the rejection as handled so vitest does not report an unhandled
      // rejection while the fake timer fires the 30s acquire timeout.
      promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(promise).rejects.toThrow('timed out waiting for a free agent process');
    } finally {
      vi.useRealTimers();
    }
  });
});