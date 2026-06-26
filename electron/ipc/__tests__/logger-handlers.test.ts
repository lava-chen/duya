/**
 * logger-handlers.test.ts — Unit tests for the logger:* IPC channels.
 *
 * The handlers are tiny wrappers around the structured logger:
 *   - logger:export          → reads log buffer as a string
 *   - logger:export-to-file  → writes log buffer to a user-specified path
 *   - logger:get-path        → returns log path/dir/size
 *   - logger:clear           → clears the log buffer/file
 *
 * We mock the logger module so we can drive it deterministically and
 * observe error paths that would be hard to trigger in a real run.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// All mock state lives in vi.hoisted so the vi.mock factory closure
// (also hoisted) and the test bodies see the same singleton.
const mocks = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    exportLogs: vi.fn(() => 'mock log content\n'),
    exportLogsToFile: vi.fn(() => true),
    getLogPath: vi.fn(() => '/tmp/duya-test/app.log'),
    getLogDir: vi.fn(() => '/tmp/duya-test'),
    getLogSize: vi.fn(() => 1024),
    getLogSizeFormatted: vi.fn(() => '1.0 KB'),
    clearLogs: vi.fn(() => true),
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

// Test file is at electron/ipc/__tests__/; logger is at
// electron/logging/logger.ts — so the path is '../../logging/logger'.
vi.mock('../../logging/logger', () => ({
  initLogger: vi.fn(),
  getLogger: () => mocks.logger,
  LogComponent: new Proxy({}, { get: (_t, p) => String(p) }),
}));

async function invokeHandler(
  channel: string,
  event: unknown = {},
  ...args: unknown[]
): Promise<unknown> {
  const handler = mocks.captured.handle.get(channel);
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`);
  return await handler(event, ...args);
}

import { registerLoggerHandlers } from '../logger-handlers';

describe('logger-handlers', () => {
  beforeEach(() => {
    // Clear call history (mockReturnValue defaults are preserved by
    // mockClear — only call records are wiped).
    mocks.logger.exportLogs.mockClear();
    mocks.logger.exportLogsToFile.mockClear();
    mocks.logger.clearLogs.mockClear();
    mocks.logger.getLogPath.mockClear();
    mocks.logger.getLogDir.mockClear();
    mocks.logger.getLogSize.mockClear();
    mocks.logger.getLogSizeFormatted.mockClear();
    mocks.logger.error.mockClear();
    mocks.captured.handle.clear();
    registerLoggerHandlers();
  });

  describe('logger:export', () => {
    it('returns success with logs on happy path', async () => {
      mocks.logger.exportLogs.mockReturnValueOnce('Hello\nWorld\n');
      const result = await invokeHandler('logger:export');
      expect(result).toEqual({ success: true, logs: 'Hello\nWorld\n' });
      expect(mocks.logger.exportLogs).toHaveBeenCalledOnce();
    });

    it('returns error envelope when exportLogs throws', async () => {
      mocks.logger.exportLogs.mockImplementationOnce(() => {
        throw new Error('disk full');
      });
      const result = await invokeHandler('logger:export');
      expect(result).toEqual({ success: false, error: 'Error: disk full' });
      expect(mocks.logger.error).toHaveBeenCalledOnce();
    });
  });

  describe('logger:export-to-file', () => {
    it('forwards targetPath to exportLogsToFile and returns success', async () => {
      mocks.logger.exportLogsToFile.mockReturnValueOnce(true);
      const result = await invokeHandler('logger:export-to-file', {}, '/tmp/my-export.log');
      expect(result).toEqual({ success: true });
      expect(mocks.logger.exportLogsToFile).toHaveBeenCalledWith('/tmp/my-export.log');
    });

    it('returns success: false when exportLogsToFile returns false', async () => {
      mocks.logger.exportLogsToFile.mockReturnValueOnce(false);
      const result = await invokeHandler('logger:export-to-file', {}, '/read-only-path');
      expect(result).toEqual({ success: false });
    });

    it('rejects empty targetPath', async () => {
      const result = await invokeHandler('logger:export-to-file', {}, '');
      expect(result).toEqual({ success: false, error: 'Invalid target path' });
      expect(mocks.logger.exportLogsToFile).not.toHaveBeenCalled();
    });

    it('rejects non-string targetPath', async () => {
      const result = await invokeHandler('logger:export-to-file', {}, 12345);
      expect(result).toEqual({ success: false, error: 'Invalid target path' });
      expect(mocks.logger.exportLogsToFile).not.toHaveBeenCalled();
    });

    it('rejects null targetPath', async () => {
      const result = await invokeHandler('logger:export-to-file', {}, null);
      expect(result).toEqual({ success: false, error: 'Invalid target path' });
    });

    it('rejects undefined targetPath', async () => {
      const result = await invokeHandler('logger:export-to-file', {}, undefined);
      expect(result).toEqual({ success: false, error: 'Invalid target path' });
    });

    it('returns error envelope when exportLogsToFile throws', async () => {
      mocks.logger.exportLogsToFile.mockImplementationOnce(() => {
        throw new Error('permission denied');
      });
      const result = await invokeHandler('logger:export-to-file', {}, '/tmp/x.log');
      expect(result).toEqual({ success: false, error: 'Error: permission denied' });
      expect(mocks.logger.error).toHaveBeenCalledOnce();
    });
  });

  describe('logger:get-path', () => {
    it('returns the four log metadata fields', async () => {
      mocks.logger.getLogPath.mockReturnValueOnce('/var/log/duya/app.log');
      mocks.logger.getLogDir.mockReturnValueOnce('/var/log/duya');
      mocks.logger.getLogSize.mockReturnValueOnce(2048);
      mocks.logger.getLogSizeFormatted.mockReturnValueOnce('2.0 KB');
      const result = await invokeHandler('logger:get-path');
      expect(result).toEqual({
        logPath: '/var/log/duya/app.log',
        logDir: '/var/log/duya',
        size: 2048,
        sizeFormatted: '2.0 KB',
      });
    });
  });

  describe('logger:clear', () => {
    it('clears logs and reports success', async () => {
      mocks.logger.clearLogs.mockReturnValueOnce(true);
      const result = await invokeHandler('logger:clear');
      expect(result).toEqual({ success: true });
      expect(mocks.logger.clearLogs).toHaveBeenCalledOnce();
    });

    it('returns success: false when clearLogs returns false', async () => {
      mocks.logger.clearLogs.mockReturnValueOnce(false);
      const result = await invokeHandler('logger:clear');
      expect(result).toEqual({ success: false });
    });

    it('returns error envelope when clearLogs throws', async () => {
      mocks.logger.clearLogs.mockImplementationOnce(() => {
        throw new Error('still writing');
      });
      const result = await invokeHandler('logger:clear');
      expect(result).toEqual({ success: false, error: 'Error: still writing' });
      expect(mocks.logger.error).toHaveBeenCalledOnce();
    });
  });
});
