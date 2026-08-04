/**
 * electron/agents/process-pool/agent-process-pool.test.ts
 *
 * Regression tests for waitForReady:
 *   - The worker sends `ready` with `status:'error'` when init fails
 *     (e.g. bad provider/model). waitForReady must surface that real error
 *     instead of resolving and letting the caller proceed to a misleading
 *     "Agent not initialized" / timeout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getLocale: () => 'en-US', getLocaleCountryCode: () => 'US' },
}));

vi.mock('../../logging/logger', () => ({
  initLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    time: vi.fn(), timeAsync: vi.fn(),
  }),
  getLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    time: vi.fn(), timeAsync: vi.fn(),
  }),
  LogComponent: { AgentProcessPool: 'AgentProcessPool' },
}));

const configManagerMock = {
  getAllProviders: () => ({}),
  getConfig: () => ({ defaultProviderId: null, securityBypassSkills: [] }),
  getDefaultProvider: () => undefined,
  onConfigChange: () => () => {},
};
vi.mock('../../config/manager', () => ({
  getConfigManager: () => configManagerMock,
  toLLMProvider: (t: string) => (t === 'anthropic' ? 'anthropic' : 'openai'),
}));

vi.mock('../../ipc/db-handlers', () => ({
  getDatabase: () => null,
}));

vi.mock('../../lib/process-cleanup', () => ({
  killProcessTree: vi.fn(),
}));

vi.mock('../../services/performance-monitor', () => ({
  getPerformanceMonitor: () => ({ recordTurnMemory: vi.fn() }),
}));

vi.mock('./process-manager', () => ({
  calculateMaxConcurrent: () => 4,
  getAgentProcessPath: () => 'agent.js',
  getAgentRuntimeCommand: () => ({ command: 'node', args: [], env: {} }),
}));

import { AgentProcessPool } from './agent-process-pool';

describe('AgentProcessPool.waitForReady', () => {
  let pool: AgentProcessPool;

  beforeEach(() => {
    pool = new AgentProcessPool();
  });

  afterEach(async () => {
    await pool.shutdown();
  });

  it('resolves when the worker emits ready without an error', async () => {
    const ready = pool.waitForReady('sess-ok');
    pool.router.broadcast('sess-ok', { type: 'ready', sessionId: 'sess-ok' });
    await expect(ready).resolves.toBeUndefined();
  });

  it('rejects with the real init error when ready carries status:error', async () => {
    const ready = pool.waitForReady('sess-err');
    pool.router.broadcast('sess-err', {
      type: 'ready',
      sessionId: 'sess-err',
      status: 'error',
      error: 'Model "foo" is not available on this provider',
    });
    await expect(ready).rejects.toThrow('Model "foo" is not available on this provider');
  });
});