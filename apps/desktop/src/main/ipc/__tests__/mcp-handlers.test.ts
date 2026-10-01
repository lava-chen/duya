/**
 * mcp-handlers.test.ts
 *
 * Unit tests for the `mcp:reload` IPC handler.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// AGENTS.md rule: all mock state lives inside vi.hoisted so the
// vi.mock factory (also hoisted) and the test bodies share one
// singleton.
const mocks = vi.hoisted(() => ({
  notifyMcpConfigChanged: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  ipcMain: mocks.ipcMain,
}));

vi.mock('../../services/mcp-write-reload', () => ({
  notifyMcpConfigChanged: mocks.notifyMcpConfigChanged,
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => mocks.logger,
}));

import { handleMcpReload } from '../mcp-handlers';

describe('mcp-handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handleMcpReload calls notifyMcpConfigChanged and reports success', async () => {
    mocks.notifyMcpConfigChanged.mockResolvedValue(undefined);
    const result = await handleMcpReload();
    expect(mocks.notifyMcpConfigChanged).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ reloaded: true });
  });

  it('still reports success when notifyMcpConfigChanged rejects (best-effort)', async () => {
    mocks.notifyMcpConfigChanged.mockRejectedValue(new Error('agent server down'));
    await expect(handleMcpReload()).resolves.toEqual({ reloaded: true });
    expect(mocks.logger.warn).toHaveBeenCalled();
  });
});
