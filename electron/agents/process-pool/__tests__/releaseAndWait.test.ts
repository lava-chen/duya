import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

// Hoisted mock state — shared between vi.mock factories and test bodies.
const mocks = vi.hoisted(() => ({
  logger: {
    initLogger: vi.fn(() => mocks.logger),
    getLogger: vi.fn(() => mocks.logger),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  killProcessTree: vi.fn().mockResolvedValue(undefined),
  configStore: {
    getByPath: vi.fn().mockImplementation((key: string) => {
      if (key === 'model.provider') return null;
      if (key === 'agent.security_bypass_skills') return [];
      return undefined;
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
  },
  providerStore: {
    listLlmProviders: vi.fn().mockReturnValue([]),
    getLlmProvider: vi.fn().mockReturnValue(undefined),
    getDefaultLlmProvider: vi.fn().mockReturnValue(null),
  },
  performanceMonitor: {
    recordProcessStart: vi.fn(),
    recordProcessEnd: vi.fn(),
  },
}));

vi.mock('../../../logging/logger', () => ({
  initLogger: () => mocks.logger,
  getLogger: () => mocks.logger,
  LogComponent: {
    AgentProcessPool: 'AgentProcessPool',
    DB: 'DB',
    DBMigration: 'DBMigration',
  },
}));

vi.mock('../../../config/store-instance', () => ({
  getConfigStore: () => mocks.configStore,
}));

vi.mock('../../../services/providers/provider-store-electron', () => ({
  getProviderStore: () => mocks.providerStore,
}));

vi.mock('../../../ipc/db-handlers', () => ({
  getDatabase: vi.fn().mockReturnValue(null),
}));

vi.mock('../../../lib/process-cleanup', () => ({
  killProcessTree: mocks.killProcessTree,
}));

vi.mock('../../../services/performance-monitor', () => ({
  getPerformanceMonitor: () => mocks.performanceMonitor,
}));

vi.mock('electron', () => ({
  app: { isPackaged: false },
}));

import { AgentProcessPool } from '../agent-process-pool';

/**
 * Create a mock ChildProcess using EventEmitter so we can emit 'exit'
 * at will. The pool's startProcess attaches child.on('exit', ...), so
 * we inject the mock directly into the running map.
 */
function createMockChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  // @ts-expect-error — mock fields not on EventEmitter type
  child.pid = 12345;
  // @ts-expect-error — mock fields
  child.exitCode = null;
  // @ts-expect-error — mock method
  child.send = vi.fn();
  // @ts-expect-error — mock stderr/stdout
  child.stderr = new EventEmitter();
  // @ts-expect-error — mock stdout
  child.stdout = new EventEmitter();
  // @ts-expect-error — mock kill
  child.kill = vi.fn();
  return child;
}

/**
 * Inject a mock RunningProcess into the pool's private running map.
 * This bypasses startProcess so we control the child lifecycle exactly.
 */
function injectMockProcess(pool: AgentProcessPool, sessionId: string, child: ChildProcess): void {
  (pool as unknown as { running: Map<string, unknown> }).running.set(sessionId, {
    child,
    startTime: Date.now(),
    lastPong: Date.now(),
    sessionId,
    providerId: null,
  });
}

function getProcess(pool: AgentProcessPool, sessionId: string): unknown | undefined {
  return (pool as unknown as { running: Map<string, unknown> }).running.get(sessionId);
}

describe('releaseAndWait', () => {
  let pool: AgentProcessPool;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.killProcessTree.mockResolvedValue(undefined);
    pool = new AgentProcessPool();
  });

  afterEach(() => {
    // The pool's heartbeat interval prevents clean exit; stop it.
    (pool as unknown as { heartbeatInterval: NodeJS.Timeout | null }).heartbeatInterval = null;
  });

  it('1. graceful exit within gracefulMs — no force kill, resolves after exit', async () => {
    const child = createMockChild();
    const sessionId = 'sess-graceful';
    injectMockProcess(pool, sessionId, child);

    // Emit 'exit' after 50ms (well within the 500ms gracefulMs).
    setTimeout(() => child.emit('exit', 0, null), 50);

    await pool.releaseAndWait(sessionId, { gracefulMs: 500 });

    // killProcessTree was NOT called (graceful exit).
    expect(mocks.killProcessTree).not.toHaveBeenCalled();

    // Pool slot is released.
    expect(getProcess(pool, sessionId)).toBeUndefined();
  });

  it('2. timeout — force kill invoked, then resolves on exit', async () => {
    const child = createMockChild();
    const sessionId = 'sess-timeout';
    injectMockProcess(pool, sessionId, child);

    // Force kill resolves, then emit 'exit' to unblock the wait.
    mocks.killProcessTree.mockImplementation(() => {
      // Simulate the process dying after force kill.
      setTimeout(() => child.emit('exit', null, 'SIGKILL'), 10);
      return Promise.resolve();
    });

    // Use a short gracefulMs so the test doesn't wait 10s.
    // The process never exits gracefully, so we hit the timeout.
    await pool.releaseAndWait(sessionId, { gracefulMs: 100 });

    // killProcessTree WAS called with force: true.
    expect(mocks.killProcessTree).toHaveBeenCalledWith(
      expect.objectContaining({ exitCode: null }),
      { force: true }
    );

    // Pool slot is released.
    expect(getProcess(pool, sessionId)).toBeUndefined();
  });

  it('3. already released (not in running map) — resolves immediately', async () => {
    // No process injected — the session is not in the running map.
    await expect(pool.releaseAndWait('sess-gone')).resolves.not.toThrow();
    expect(mocks.killProcessTree).not.toHaveBeenCalled();
  });

  it('4. process already exited (exitCode set) — resolves without force kill', async () => {
    const child = createMockChild();
    // @ts-expect-error — set exitCode to simulate already-dead process
    child.exitCode = 0;
    const sessionId = 'sess-already-dead';
    injectMockProcess(pool, sessionId, child);

    await pool.releaseAndWait(sessionId, { gracefulMs: 500 });

    // No force kill needed — process already exited.
    expect(mocks.killProcessTree).not.toHaveBeenCalled();
    expect(getProcess(pool, sessionId)).toBeUndefined();
  });
});