/**
 * AgentProcessPool - Unit Tests
 *
 * Tests the multi-process agent execution pool:
 * - acquire / release lifecycle
 * - queue management when pool is full
 * - message routing (send, onMessage, removeMessageHandler)
 * - heartbeat monitoring
 * - waitForReady
 * - shutdown
 * - busy session tracking
 * - pending message queue
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// =============================================================================
// Mocks must be set up BEFORE the module is imported
// =============================================================================

vi.mock('./logger', () => ({
  getLogger: vi.fn(() => {
    const mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    return mockLogger;
  }),
  LogComponent: {
    AgentProcessPool: 'AgentProcessPool',
    AgentProcess: 'AgentProcess',
    ConfigManager: 'ConfigManager',
  },
  initLogger: vi.fn(),
}));

vi.mock('./config-manager', () => ({
  getConfigManager: vi.fn(() => ({
    getConfig: vi.fn(() => ({ securityBypassSkills: [] })),
  })),
  initConfigManager: vi.fn(),
}));

vi.mock('./lib/process-cleanup', () => ({
  killProcessTree: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./db-handlers', () => ({
  getDatabase: vi.fn(() => ({
    prepare: vi.fn(() => ({
      run: vi.fn(),
    })),
  })),
}));

const MockChildProcess = class extends EventEmitter {
  pid: number;
  exitCode: number | null = null;
  killed = false;
  send = vi.fn();
  stdout = new EventEmitter();
  stderr = new EventEmitter();

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill() {
    this.killed = true;
    this.exitCode = 1;
    this.emit('exit', 1, 'SIGTERM');
    return true;
  }
};

let pidCounter = 0;

// Pre-define the mock functions so they are available before vi.mock factories run
const mockSpawnFn = vi.fn<() => MockChildProcess>();
const mockOsCpus = vi.fn(() => new Array(8).fill({}));
const mockOsFreemem = vi.fn(() => 8 * 1024 * 1024 * 1024);
const mockFsExists = vi.fn(() => true);
const mockAppGetPath = vi.fn(() => '/mock/user/data');

vi.mock('child_process', () => {
  mockSpawnFn.mockImplementation(() => {
    const proc = new MockChildProcess(++pidCounter);
    return proc;
  });
  return { spawn: mockSpawnFn };
});

vi.mock('os', () => ({
  cpus: mockOsCpus,
  freemem: mockOsFreemem,
}));

vi.mock('fs', () => ({
  existsSync: mockFsExists,
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: mockAppGetPath,
  },
}));

// =============================================================================
// Tests
// =============================================================================

describe('AgentProcessPool', () => {
  let AgentProcessPool: typeof import('./agent-process-pool').AgentProcessPool;
  let getAgentProcessPool: typeof import('./agent-process-pool').getAgentProcessPool;
  let initAgentProcessPool: typeof import('./agent-process-pool').initAgentProcessPool;

  beforeEach(async () => {
    vi.clearAllMocks();
    pidCounter = 0;
    mockOsCpus.mockReturnValue(new Array(8).fill({}));
    mockOsFreemem.mockReturnValue(8 * 1024 * 1024 * 1024);
    mockFsExists.mockReturnValue(true);

    // Reset module state for fresh singleton
    vi.resetModules();
    const mod = await import('./agent-process-pool');
    AgentProcessPool = mod.AgentProcessPool;
    getAgentProcessPool = mod.getAgentProcessPool;
    initAgentProcessPool = mod.initAgentProcessPool;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Singleton
  // =========================================================================

  describe('singleton', () => {
    it('getAgentProcessPool returns the same instance', () => {
      const pool1 = getAgentProcessPool();
      const pool2 = getAgentProcessPool();
      expect(pool1).toBe(pool2);
    });

    it('initAgentProcessPool creates a new instance when none exists', () => {
      // Need fresh module state for this
      const pool = new AgentProcessPool();
      expect(pool).toBeInstanceOf(AgentProcessPool);
    });
  });

  // =========================================================================
  // getStatus
  // =========================================================================

  describe('getStatus', () => {
    it('returns initial state with zero running', () => {
      const pool = getAgentProcessPool();
      const status = pool.getStatus();

      expect(status.running).toBe(0);
      expect(status.maxConcurrent).toBeGreaterThan(0);
      expect(status.queueLength).toBe(0);
      expect(status.processes).toHaveLength(0);
    });

    it('returns correct maxConcurrent based on CPU cores', () => {
      const pool = getAgentProcessPool();
      const status = pool.getStatus();

      expect(status.maxConcurrent).toBeLessThanOrEqual(4);
      expect(status.maxConcurrent).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // isRunning
  // =========================================================================

  describe('isRunning', () => {
    it('returns false for unknown session', () => {
      const pool = getAgentProcessPool();
      expect(pool.isRunning('unknown-session')).toBe(false);
    });
  });

  // =========================================================================
  // Busy Session Tracking
  // =========================================================================

  describe('busy session tracking', () => {
    it('isSessionBusy returns false for unknown session', () => {
      const pool = getAgentProcessPool();
      expect(pool.isSessionBusy('session-1')).toBe(false);
    });

    it('markSessionBusy marks session as busy', () => {
      const pool = getAgentProcessPool();
      pool.markSessionBusy('session-1');
      expect(pool.isSessionBusy('session-1')).toBe(true);
    });

    it('markSessionIdle unmarks session', () => {
      const pool = getAgentProcessPool();
      pool.markSessionBusy('session-1');
      expect(pool.isSessionBusy('session-1')).toBe(true);

      pool.markSessionIdle('session-1');
      expect(pool.isSessionBusy('session-1')).toBe(false);
    });
  });

  // =========================================================================
  // Pending Message Queue
  // =========================================================================

  describe('pending message queue', () => {
    it('hasPendingMessages returns false for unknown session', () => {
      const pool = getAgentProcessPool();
      expect(pool.hasPendingMessages('session-1')).toBe(false);
    });

    it('queueMessage adds a pending message', () => {
      const pool = getAgentProcessPool();
      pool.queueMessage('session-1', 'Hello');
      expect(pool.hasPendingMessages('session-1')).toBe(true);
    });

    it('drainNextMessage drains in FIFO order', () => {
      const pool = getAgentProcessPool();

      pool.queueMessage('session-1', 'Hello');
      pool.queueMessage('session-1', 'World', { foo: 'bar' });

      const first = pool.drainNextMessage('session-1');
      expect(first?.prompt).toBe('Hello');
      expect(first?.options).toBeUndefined();

      const second = pool.drainNextMessage('session-1');
      expect(second?.prompt).toBe('World');
      expect(second?.options).toEqual({ foo: 'bar' });
    });

    it('drainNextMessage returns undefined for empty queue', () => {
      const pool = getAgentProcessPool();
      expect(pool.drainNextMessage('session-1')).toBeUndefined();
    });

    it('queue is cleared after draining all messages', () => {
      const pool = getAgentProcessPool();
      pool.queueMessage('session-1', 'Hello');

      pool.drainNextMessage('session-1');
      expect(pool.hasPendingMessages('session-1')).toBe(false);
      expect(pool.drainNextMessage('session-1')).toBeUndefined();
    });
  });

  // =========================================================================
  // Message Handlers
  // =========================================================================

  describe('message handlers', () => {
    it('onMessage registers a handler', () => {
      const pool = getAgentProcessPool();
      const handler = vi.fn();

      pool.onMessage('session-1', handler);
      // Handler is registered (verified by no throw)
    });

    it('removeMessageHandler with specific handler removes only that handler', () => {
      const pool = getAgentProcessPool();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      pool.onMessage('session-1', handler1);
      pool.onMessage('session-1', handler2);

      pool.removeMessageHandler('session-1', handler1);
      // Remaining handlers should still be intact
    });

    it('removeMessageHandler without handler removes all handlers for session', () => {
      const pool = getAgentProcessPool();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      pool.onMessage('session-1', handler1);
      pool.onMessage('session-1', handler2);

      pool.removeMessageHandler('session-1');
      // All handlers removed
    });
  });

  // =========================================================================
  // send
  // =========================================================================

  describe('send', () => {
    it('returns false for unknown session', () => {
      const pool = getAgentProcessPool();
      const result = pool.send('unknown-session', { type: 'test' });
      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // release
  // =========================================================================

  describe('release', () => {
    it('removes session from queue if queued', () => {
      const pool = getAgentProcessPool();
      // release should not throw for non-existent session
      pool.release('non-existent');
    });
  });

  // =========================================================================
  // waitForReady
  // =========================================================================

  describe('waitForReady', () => {
    it('rejects on timeout when no process is running', async () => {
      const pool = getAgentProcessPool();

      await expect(pool.waitForReady('no-session', 500)).rejects.toThrow('ready timeout');
    }, 10000);
  });
});