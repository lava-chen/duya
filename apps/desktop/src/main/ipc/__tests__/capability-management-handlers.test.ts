/**
 * capability-management-handlers.test.ts — Unit tests for
 * `capability-management:snapshot` IPC.
 *
 * This is the renderer-facing read of the Capability Inventory: a
 * capability-management "page" in the Settings UI subscribes via
 * SSE on the gateway and also fetches the snapshot on demand.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  snapshotReturn: { items: [], total: 0, generatedAt: 0 },
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
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp'),
    getAppPath: vi.fn(() => '/tmp'),
    getVersion: vi.fn(() => '0.0.0-test'),
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
    getLocale: vi.fn(() => 'en-US'),
    getLocaleCountryCode: vi.fn(() => 'US'),
  },
}));

vi.mock('../../logging/logger', () => ({
  initLogger: vi.fn(),
  getLogger: () => mocks.logger,
  LogComponent: new Proxy({}, { get: (_t, p) => String(p) }),
}));

vi.mock('../../services/capability-management', () => ({
  getCapabilityManagementService: () => ({
    buildSnapshot: () => Promise.resolve(mocks.snapshotReturn),
  }),
}));

async function invokeHandler(channel: string, event: unknown = {}): Promise<unknown> {
  const handler = mocks.captured.handle.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return await handler(event);
}

import { registerCapabilityManagementHandlers } from '../capability-management-handlers';

describe('capability-management-handlers', () => {
  beforeEach(() => {
    mocks.snapshotReturn = { items: [], total: 0, generatedAt: 0 };
    mocks.logger.info.mockClear();
    mocks.captured.handle.clear();
    registerCapabilityManagementHandlers();
  });

  it('registers the capability-management:snapshot channel', () => {
    expect(mocks.captured.handle.has('capability-management:snapshot')).toBe(true);
  });

  it('returns the live snapshot on invocation', async () => {
    mocks.snapshotReturn = {
      items: [{ id: 'cap1', name: 'first' }, { id: 'cap2', name: 'second' }],
      total: 2,
      generatedAt: 1700000000000,
    };
    const result = await invokeHandler('capability-management:snapshot');
    // The handler wraps the snapshot in a { success, data, error } envelope.
    expect(result).toEqual({ success: true, data: mocks.snapshotReturn });
  });

  it('returns the empty snapshot if no items are registered', async () => {
    const result = await invokeHandler('capability-management:snapshot');
    // The shape is an envelope; the inner snapshot is whatever the
    // inventory returns. We just verify the envelope is successful and
    // the inner payload is an object.
    expect(result).toMatchObject({ success: true });
    expect((result as { data: unknown }).data).toBeDefined();
  });
});
