/**
 * electron/automation/Scheduler.test.ts
 *
 * Regression tests for the cron scheduler runtime:
 *   - runInSession resolves the active provider from the ProviderStore via
 *     `getDefaultLlmProvider()`, throws a useful error when none is configured,
 *     and sends a complete init payload (providerConfig, workingDirectory,
 *     systemPrompt).
 *
 * The legacy `resolveCronProvider` helper was removed during
 * the ProviderStore migration (plan 334 Phase 6a); the remaining tests target
 * the current `AutomationScheduler.runInSession` behavior.
 *
 * better-sqlite3 is mocked so these tests do not depend on the native
 * binding's Node ABI version.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const providerStoreMock = {
  getDefaultLlmProvider: vi.fn(),
  listLlmProviders: vi.fn(() => []),
};
vi.mock('../services/providers/provider-store-electron', () => ({
  getProviderStore: () => providerStoreMock,
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

vi.mock('../db/core-connection', () => ({
  getCoreStores: () => ({ sessions: { create: vi.fn() } }),
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

import { AutomationScheduler } from './Scheduler';
import type { LlmProvider } from '../../src/lib/providers/types';

const fakeDb = {
  prepare: () => ({
    run: () => ({ changes: 1 }),
    get: () => undefined,
    all: () => [],
  }),
};

// A minimal LlmProvider that `toLegacyApiProvider` can round-trip back to the
// legacy ApiProvider shape (requires `meta`, `endpoints.baseUrl`, `auth`).
const makeLlmProvider = (overrides: Record<string, unknown> = {}): LlmProvider => ({
  id: 'p1',
  name: 'p1',
  category: 'official',
  apiFormat: 'openai-chat',
  auth: { type: 'api-key', apiKey: 'sk-test' },
  endpoints: { baseUrl: 'https://api.openai.com/v1' },
  ui: {},
  meta: { createdAt: 0, updatedAt: 0, sortIndex: 0 },
  options: {},
  ...overrides,
}) as LlmProvider;

describe('AutomationScheduler.runInSession', () => {
  beforeEach(() => {
    providerStoreMock.getDefaultLlmProvider.mockReset();
    providerStoreMock.listLlmProviders.mockReset();
    providerStoreMock.listLlmProviders.mockReturnValue([]);
    poolMock.acquire.mockReset();
    poolMock.waitForReady.mockReset();
    poolMock.send.mockReset();
    poolMock.onMessage.mockReset();
    poolMock.removeMessageHandler.mockReset();
    poolMock.release.mockReset();
  });

  it('throws when no active provider is configured', async () => {
    providerStoreMock.getDefaultLlmProvider.mockReturnValue(undefined);

    const scheduler = new AutomationScheduler(fakeDb as never);
    await expect(
      scheduler['runInSession']({ model: 'claude', concurrency_policy: 'skip' } as never, 'cron:test:1:r1'),
    ).rejects.toThrow('no active provider configured');
  });

  it('throws when the cron model is not configured', async () => {
    providerStoreMock.getDefaultLlmProvider.mockReturnValue(makeLlmProvider());

    const scheduler = new AutomationScheduler(fakeDb as never);
    await expect(
      scheduler['runInSession']({ model: '', concurrency_policy: 'skip' } as never, 'cron:test:1:r1'),
    ).rejects.toThrow('cron model is not configured');
  });

  it('sends a complete init payload (providerConfig, workingDirectory, systemPrompt)', async () => {
    providerStoreMock.getDefaultLlmProvider.mockReturnValue(makeLlmProvider({ apiFormat: 'anthropic' }));

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
    expect(initSent!.systemPrompt).toBe('');
    expect(initSent!.providerConfig).toMatchObject({ model: 'claude', provider: 'anthropic' });
    expect(result).toBe('hello world');
  });
});