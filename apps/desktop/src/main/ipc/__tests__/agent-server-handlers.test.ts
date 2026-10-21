/**
 * agent-server-handlers.test.ts — Unit tests for `agent-server:*` IPC.
 *
 * Two channels, both pure passthroughs to `getAgentServerPort()`:
 *   - agent-server:getPort → returns the port number (or 0)
 *   - agent-server:getUrl  → returns `http://127.0.0.1:${port}` or null
 *
 * The handler module also logs an info message at registration time,
 * which we cover with a smoke assertion.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  port: 0, // 0 = uninitialised
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
  captured: {
    handle: new Map<string, (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>>(),
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (c: string, fn: (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>) => {
      mocks.captured.handle.set(c, fn);
    },
  },
}));

vi.mock('../../logging/logger', () => ({
  initLogger: vi.fn(),
  getLogger: () => mocks.logger,
  LogComponent: new Proxy({}, { get: (_t, p) => String(p) }),
}));

// We control the port returned by getAgentServerPort() through this mock.
vi.mock('../../agents/agent-server-lifecycle', () => ({
  getAgentServerPort: () => mocks.port,
}));

async function invokeHandler(channel: string, event: unknown = {}): Promise<unknown> {
  const handler = mocks.captured.handle.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return await handler(event);
}

import { registerAgentServerHandlers } from '../agent-server-handlers';

describe('agent-server-handlers', () => {
  beforeEach(() => {
    mocks.port = 0;
    mocks.logger.info.mockClear();
    mocks.captured.handle.clear();
    registerAgentServerHandlers();
  });

  describe('agent-server:getPort', () => {
    it('returns the live port number when initialized', async () => {
      mocks.port = 41234;
      const result = await invokeHandler('agent-server:getPort');
      expect(result).toBe(41234);
    });

    it('returns 0 when the port is not yet set', async () => {
      mocks.port = 0;
      const result = await invokeHandler('agent-server:getPort');
      expect(result).toBe(0);
    });
  });

  describe('agent-server:getUrl', () => {
    it('returns a full http:// URL when port is set', async () => {
      mocks.port = 51500;
      const result = await invokeHandler('agent-server:getUrl');
      expect(result).toBe('http://127.0.0.1:51500');
    });

    it('returns null when port is 0 (server not started)', async () => {
      mocks.port = 0;
      const result = await invokeHandler('agent-server:getUrl');
      expect(result).toBeNull();
    });
  });

  describe('registration', () => {
    it('emits an info log at registration time', () => {
      expect(mocks.logger.info).toHaveBeenCalledOnce();
    });
  });
});
