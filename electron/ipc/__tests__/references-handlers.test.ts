/**
 * references-handlers.test.ts — Unit tests for the `references:*` IPC channels.
 *
 * Channels under test:
 *   - references:list    → { success, data, error }
 *   - references:add     → { success, data, error }
 *   - references:delete  → { success, error }
 *   - references:open    → { success, error }
 *
 * The handler module is a thin wrapper around `fs` + `electron.dialog` /
 * `electron.shell`. We mock both to drive the handler through happy and
 * error paths. Path-traversal protection is the most important behavior
 * under test.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const fsState = {
    existsSync: vi.fn(() => true),
    statSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    mkdirSync: vi.fn(),
    copyFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    rmSync: vi.fn(),
  };
  return {
    fs: fsState,
    dialog: {
      showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [] })),
    },
    shell: {
      openPath: vi.fn(async () => ''),
    },
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    captured: {
      handle: new Map<string, (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>>(),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (c: string, fn: (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>) => {
      mocks.captured.handle.set(c, fn);
    },
  },
  dialog: mocks.dialog,
  shell: mocks.shell,
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp'),
    getAppPath: vi.fn(() => '/tmp'),
    getVersion: vi.fn(() => '0.0.0-test'),
  },
}));

vi.mock('../../logging/logger', () => ({
  initLogger: vi.fn(),
  getLogger: () => mocks.logger,
  LogComponent: new Proxy({}, { get: (_t, p) => String(p) }),
}));

vi.mock('../../core/window-manager', () => ({
  getMainWindow: vi.fn(() => ({})),
}));

vi.mock('fs', () => mocks.fs);

async function invokeHandler(
  channel: string,
  event: unknown = {},
  ...args: unknown[]
): Promise<unknown> {
  const handler = mocks.captured.handle.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return await handler(event, ...args);
}

import { registerReferencesHandlers } from '../references-handlers';

describe('references-handlers', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks.fs)) fn.mockReset();
    mocks.fs.existsSync.mockReturnValue(true);
    mocks.fs.statSync.mockReturnValue({ isDirectory: () => true, isFile: () => false, mtimeMs: 1000, size: 0 });
    mocks.fs.readdirSync.mockReturnValue([]);
    mocks.dialog.showOpenDialog.mockReset();
    mocks.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [] });
    mocks.shell.openPath.mockReset();
    mocks.shell.openPath.mockResolvedValue('');
    mocks.logger.warn.mockClear();
    mocks.captured.handle.clear();
    registerReferencesHandlers();
  });

  describe('references:list', () => {
    it('rejects an empty working directory', async () => {
      const result = await invokeHandler('references:list', {}, '');
      expect(result).toEqual({ success: false, error: 'Invalid working directory' });
    });

    it('returns empty list when references dir does not exist', async () => {
      mocks.fs.existsSync.mockReturnValue(false);
      const result = await invokeHandler('references:list', {}, '/proj');
      expect(result).toEqual({ success: true, data: [] });
    });

    it('walks a flat directory and returns entries', async () => {
      mocks.fs.readdirSync.mockReturnValue([
        { name: 'api.md', isDirectory: () => false, isFile: () => true },
        { name: 'schema.json', isDirectory: () => false, isFile: () => true },
      ]);
      // statSync is called once for the root (must be a directory), then
      // once per entry. mockReturnValueOnce values are consumed in call order.
      mocks.fs.statSync
        .mockReturnValueOnce({ isDirectory: () => true, isFile: () => false, mtimeMs: 1000, size: 0 })
        .mockReturnValueOnce({ isDirectory: () => false, isFile: () => true, mtimeMs: 2000, size: 1024 })
        .mockReturnValueOnce({ isDirectory: () => false, isFile: () => true, mtimeMs: 3000, size: 2048 });
      const result = await invokeHandler('references:list', {}, '/proj') as {
        success: boolean;
        data?: Array<{ name: string; relativePath: string; isDirectory: boolean }>;
      };
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
      expect(result.data?.[0].name).toBe('api.md');
      expect(result.data?.[1].name).toBe('schema.json');
    });
  });

  describe('references:delete — path traversal', () => {
    it('rejects a relative path that escapes the references root', async () => {
      const result = await invokeHandler('references:delete', {}, '/proj', '../../etc/passwd');
      expect(result).toEqual({ success: false, error: 'Path traversal denied' });
    });

    it('rejects an absolute path', async () => {
      const result = await invokeHandler('references:delete', {}, '/proj', '/etc/passwd');
      expect(result).toEqual({ success: false, error: 'Path traversal denied' });
    });

    it('rejects a path with null bytes', async () => {
      const result = await invokeHandler('references:delete', {}, '/proj', 'foo\0bar');
      expect(result).toEqual({ success: false, error: 'Path traversal denied' });
    });

    it('accepts a simple file name and calls unlinkSync', async () => {
      mocks.fs.existsSync.mockReturnValue(true);
      mocks.fs.statSync.mockReturnValue({ isDirectory: () => false, isFile: () => true });
      const result = await invokeHandler('references:delete', {}, '/proj', 'api.md');
      expect(result).toEqual({ success: true });
      expect(mocks.fs.unlinkSync).toHaveBeenCalledTimes(1);
      expect(mocks.fs.rmSync).not.toHaveBeenCalled();
    });

    it('uses rmSync for directories', async () => {
      mocks.fs.existsSync.mockReturnValue(true);
      mocks.fs.statSync.mockReturnValue({ isDirectory: () => true, isFile: () => false });
      const result = await invokeHandler('references:delete', {}, '/proj', 'subdir');
      expect(result).toEqual({ success: true });
      expect(mocks.fs.rmSync).toHaveBeenCalledTimes(1);
      expect(mocks.fs.unlinkSync).not.toHaveBeenCalled();
    });
  });

  describe('references:add', () => {
    it('rejects an empty working directory', async () => {
      const result = await invokeHandler('references:add', {}, '', ['/src/file.md']);
      expect(result).toEqual({ success: false, error: 'Invalid working directory' });
    });

    it('rejects an empty filePaths array', async () => {
      const result = await invokeHandler('references:add', {}, '/proj', []);
      expect(result).toEqual({ success: false, error: 'No files provided' });
    });

    it('creates the references dir if missing and copies files', async () => {
      // existsSync is called for two purposes:
      //   1. Source-file existence check: must return true for /src/* paths.
      //   2. Destination collision check inside resolveCollisionName:
      //      must return false so the original name is used as-is.
      mocks.fs.existsSync.mockImplementation((p: string) =>
        String(p).includes('.duya') ? false : true,
      );
      mocks.fs.statSync.mockReturnValue({ isDirectory: () => false, isFile: () => true });
      const result = await invokeHandler('references:add', {}, '/proj', ['/src/a.md', '/src/b.md']) as {
        success: boolean;
        data?: string[];
      };
      expect(result.success).toBe(true);
      expect(result.data).toEqual(['a.md', 'b.md']);
      expect(mocks.fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('.duya'), { recursive: true });
      expect(mocks.fs.copyFileSync).toHaveBeenCalledTimes(2);
    });

    it('skips source files that do not exist', async () => {
      // Source existence check returns true for /src/* paths; collision
      // check (inside .duya) returns false. The statSync mock returns
      // isFile:true for the first source and isFile:false for the second,
      // so only the second source is skipped.
      mocks.fs.existsSync.mockImplementation((p: string) =>
        String(p).includes('.duya') ? false : true,
      );
      mocks.fs.statSync
        .mockReturnValueOnce({ isDirectory: () => false, isFile: () => true }) // a.md source ok
        .mockReturnValueOnce({ isDirectory: () => false, isFile: () => false }); // b.md source not a file
      const result = await invokeHandler('references:add', {}, '/proj', ['/src/a.md', '/src/b.md']) as {
        success: boolean;
        data?: string[];
      };
      expect(result.success).toBe(true);
      expect(result.data).toEqual(['a.md']);
      expect(mocks.fs.copyFileSync).toHaveBeenCalledTimes(1);
    });
  });

  describe('references:open', () => {
    it('rejects a path traversal attempt', async () => {
      const result = await invokeHandler('references:open', {}, '/proj', '../../etc/passwd');
      expect(result).toEqual({ success: false, error: 'Path traversal denied' });
      expect(mocks.shell.openPath).not.toHaveBeenCalled();
    });

    it('refuses to open a directory', async () => {
      mocks.fs.existsSync.mockReturnValue(true);
      mocks.fs.statSync.mockReturnValue({ isDirectory: () => true, isFile: () => false });
      const result = await invokeHandler('references:open', {}, '/proj', 'subdir');
      expect(result).toEqual({ success: false, error: 'Cannot open a directory' });
      expect(mocks.shell.openPath).not.toHaveBeenCalled();
    });

    it('opens a file via shell.openPath', async () => {
      mocks.fs.existsSync.mockReturnValue(true);
      mocks.fs.statSync.mockReturnValue({ isDirectory: () => false, isFile: () => true });
      const result = await invokeHandler('references:open', {}, '/proj', 'api.md');
      expect(result).toEqual({ success: true });
      expect(mocks.shell.openPath).toHaveBeenCalledTimes(1);
    });
  });
});
