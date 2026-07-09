/**
 * files-handlers.test.ts — Unit tests for the `files:*` IPC channels.
 *
 * Channels under test:
 *   - files:browse  → { success, tree, error }  (tree: [] on error)
 *   - files:rename  → { success, newPath, error }
 *   - files:delete  → { success, error }
 *
 * The handler module is a thin wrapper around the **synchronous** `fs`
 * API (`fs.existsSync`, `fs.statSync`, `fs.readdirSync`, `fs.renameSync`,
 * `fs.rmdirSync`, `fs.unlinkSync`). We mock the `fs` module to drive
 * the handler through both happy and error paths.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const fsState = {
    existsSync: vi.fn(() => true),
    statSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    renameSync: vi.fn(),
    rmdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    realpathSync: vi.fn((value: string) => value),
    openSync: vi.fn(() => 10),
    readSync: vi.fn(() => 0),
    closeSync: vi.fn(),
    readFileSync: vi.fn(() => Buffer.alloc(0)),
  };
  return {
    fs: fsState,
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

// files-handlers uses the synchronous `fs` module. We export named
// functions for existsSync/statSync/etc, matching the real module shape.
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

import { registerFilesHandlers } from '../files-handlers';

describe('files-handlers', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks.fs)) fn.mockReset();
    // Default: pretend the path exists and is a readable directory.
    mocks.fs.existsSync.mockReturnValue(true);
    mocks.fs.statSync.mockReturnValue({ isDirectory: () => true, isFile: () => false });
    mocks.fs.readdirSync.mockReturnValue([]);
    mocks.fs.realpathSync.mockImplementation((value: string) => value);
    mocks.logger.error.mockClear();
    mocks.captured.handle.clear();
    registerFilesHandlers();
  });

  describe('files:browse', () => {
    it('rejects an empty path with success: false and empty tree', async () => {
      const result = await invokeHandler('files:browse', {}, '');
      expect(result).toEqual({ success: false, error: 'Invalid directory path', tree: [] });
      expect(mocks.fs.existsSync).not.toHaveBeenCalled();
    });

    it('rejects a non-string path', async () => {
      const result = await invokeHandler('files:browse', {}, 123);
      expect(result).toEqual({ success: false, error: 'Invalid directory path', tree: [] });
    });

    it('returns "Directory does not exist" when existsSync returns false', async () => {
      mocks.fs.existsSync.mockReturnValue(false);
      const result = await invokeHandler('files:browse', {}, '/no/such/dir');
      expect(result).toEqual({ success: false, error: 'Directory does not exist', tree: [] });
    });

    it('returns "Path is not a directory" when statSync says it is a file', async () => {
      mocks.fs.statSync.mockReturnValue({ isDirectory: () => false, isFile: () => true });
      const result = await invokeHandler('files:browse', {}, '/some/file.txt');
      expect(result).toEqual({ success: false, error: 'Path is not a directory', tree: [] });
    });

    it('returns the empty tree for an empty directory', async () => {
      mocks.fs.readdirSync.mockReturnValue([]);
      const result = await invokeHandler('files:browse', {}, '/empty');
      expect(result).toEqual({ success: true, tree: [] });
    });

    it('lists files and subdirectories, sorting directories first', async () => {
      mocks.fs.readdirSync.mockReturnValue([
        { name: 'zeta.txt', isDirectory: () => false, isFile: () => true },
        { name: 'beta', isDirectory: () => true, isFile: () => false },
        { name: 'alpha.txt', isDirectory: () => false, isFile: () => true },
        { name: 'aardvark', isDirectory: () => true, isFile: () => false },
      ]);
      const result = await invokeHandler('files:browse', {}, '/somedir');
      // Directories first (alphabetical), then files (alphabetical)
      expect(result).toMatchObject({
        success: true,
        tree: [
          { name: 'aardvark', type: 'directory' },
          { name: 'beta', type: 'directory' },
          { name: 'alpha.txt', type: 'file', extension: 'txt' },
          { name: 'zeta.txt', type: 'file', extension: 'txt' },
        ],
      });
    });

    it('skips node_modules, hidden, and log files', async () => {
      mocks.fs.readdirSync.mockReturnValue([
        { name: 'src', isDirectory: () => true, isFile: () => false },
        { name: 'node_modules', isDirectory: () => true, isFile: () => false },
        { name: '.git', isDirectory: () => true, isFile: () => false },
        { name: '.env', isDirectory: () => false, isFile: () => true },
        { name: 'app.log', isDirectory: () => false, isFile: () => true },
        { name: 'README.md', isDirectory: () => false, isFile: () => true },
      ]);
      const result = await invokeHandler('files:browse', {}, '/somedir');
      const names = (result as { tree: { name: string }[] }).tree.map((n) => n.name);
      expect(names).toEqual(['src', 'README.md']);
    });

    it('shows .agents, .claude, and .duya hidden directories', async () => {
      mocks.fs.readdirSync.mockReturnValue([
        { name: '.agents', isDirectory: () => true, isFile: () => false },
        { name: '.claude', isDirectory: () => true, isFile: () => false },
        { name: '.duya', isDirectory: () => true, isFile: () => false },
        { name: '.git', isDirectory: () => true, isFile: () => false },
        { name: '.env', isDirectory: () => false, isFile: () => true },
        { name: 'src', isDirectory: () => true, isFile: () => false },
      ]);
      const result = await invokeHandler('files:browse', {}, '/somedir');
      const names = (result as { tree: { name: string }[] }).tree.map((n) => n.name);
      expect(names).toEqual(['.agents', '.claude', '.duya', 'src']);
    });
  });

  describe('files:rename', () => {
    it('returns "Invalid path or name" when targetPath is empty', async () => {
      const result = await invokeHandler('files:rename', {}, '', 'newName');
      expect(result).toEqual({ success: false, error: 'Invalid path or name' });
    });

    it('returns "Invalid path or name" when newName is empty', async () => {
      const result = await invokeHandler('files:rename', {}, '/some', '');
      expect(result).toEqual({ success: false, error: 'Invalid path or name' });
    });

    it('returns "Path does not exist" when existsSync returns false', async () => {
      mocks.fs.existsSync.mockReturnValue(false);
      const result = await invokeHandler('files:rename', {}, '/missing', 'newName');
      expect(result).toEqual({ success: false, error: 'Path does not exist' });
    });

    it('returns "A file or folder with that name already exists" on name collision', async () => {
      // existsSync returns true for the source, true for the dest.
      mocks.fs.existsSync.mockReturnValue(true);
      const result = await invokeHandler('files:rename', {}, '/dir/source', 'dest');
      expect(result).toEqual({ success: false, error: 'A file or folder with that name already exists' });
      expect(mocks.fs.renameSync).not.toHaveBeenCalled();
    });

    it('renames the file and returns newPath on success', async () => {
      // existsSync true for source, false for newPath
      mocks.fs.existsSync.mockImplementation((p: string) => p.endsWith('source'));
      mocks.fs.renameSync.mockReturnValue(undefined);
      const result = await invokeHandler('files:rename', {}, '/dir/source', 'renamed');
      expect(result).toMatchObject({ success: true });
      expect((result as { newPath: string }).newPath).toMatch(/renamed$/);
      expect(mocks.fs.renameSync).toHaveBeenCalled();
    });
  });

  describe('files:preview', () => {
    it('returns text content through a project-scoped preview', async () => {
      mocks.fs.statSync.mockImplementation((value: string) => ({
        isDirectory: () => !String(value).endsWith('notes.md'),
        isFile: () => String(value).endsWith('notes.md'),
        size: 5,
        mtimeMs: 123,
      }));
      mocks.fs.readSync.mockImplementation((_fd: number, buffer: Buffer) => {
        buffer.write('hello');
        return 5;
      });

      const result = await invokeHandler('files:preview', {}, '/project/notes.md', '/project');
      expect(result).toMatchObject({
        success: true,
        kind: 'text',
        content: 'hello',
        truncated: false,
        extension: 'md',
      });
      expect(mocks.fs.closeSync).toHaveBeenCalledWith(10);
    });

    it('rejects a real path outside the project root', async () => {
      mocks.fs.statSync.mockImplementation((value: string) => ({
        isDirectory: () => String(value).endsWith('project'),
        isFile: () => !String(value).endsWith('project'),
        size: 1,
        mtimeMs: 0,
      }));
      mocks.fs.realpathSync.mockImplementation((value: string) =>
        String(value).endsWith('project') ? '/project' : '/outside/secret.txt',
      );

      const result = await invokeHandler('files:preview', {}, '/project/link.txt', '/project');
      expect(result).toEqual({ success: false, error: 'Preview path is outside the project directory' });
      expect(mocks.fs.openSync).not.toHaveBeenCalled();
    });

    it('returns image data as a bounded base64 payload', async () => {
      mocks.fs.statSync.mockImplementation((value: string) => ({
        isDirectory: () => !String(value).endsWith('pixel.png'),
        isFile: () => String(value).endsWith('pixel.png'),
        size: 3,
        mtimeMs: 456,
      }));
      mocks.fs.readFileSync.mockReturnValue(Buffer.from([1, 2, 3]));

      const result = await invokeHandler('files:preview', {}, '/project/pixel.png', '/project');
      expect(result).toMatchObject({
        success: true,
        kind: 'image',
        mediaType: 'image/png',
        data: 'AQID',
      });
    });
  });

  describe('files:delete', () => {
    it('rejects empty path with "Invalid path"', async () => {
      const result = await invokeHandler('files:delete', {}, '');
      expect(result).toEqual({ success: false, error: 'Invalid path' });
    });

    it('rejects non-string path with "Invalid path"', async () => {
      const result = await invokeHandler('files:delete', {}, 42);
      expect(result).toEqual({ success: false, error: 'Invalid path' });
    });

    it('returns "Path does not exist" when existsSync returns false', async () => {
      mocks.fs.existsSync.mockReturnValue(false);
      const result = await invokeHandler('files:delete', {}, '/missing');
      expect(result).toEqual({ success: false, error: 'Path does not exist' });
    });

    it('calls rmdirSync for a directory and returns success', async () => {
      mocks.fs.statSync.mockReturnValue({ isDirectory: () => true, isFile: () => false });
      mocks.fs.rmdirSync.mockReturnValue(undefined);
      const result = await invokeHandler('files:delete', {}, '/somedir');
      expect(result).toEqual({ success: true });
      expect(mocks.fs.rmdirSync).toHaveBeenCalledTimes(1);
      const calledPath = (mocks.fs.rmdirSync.mock.calls[0] as unknown as [string])[0];
      expect(calledPath).toMatch(/somedir$/);
      expect(mocks.fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('calls unlinkSync for a file and returns success', async () => {
      mocks.fs.statSync.mockReturnValue({ isDirectory: () => false, isFile: () => true });
      mocks.fs.unlinkSync.mockReturnValue(undefined);
      const result = await invokeHandler('files:delete', {}, '/somefile.txt');
      expect(result).toEqual({ success: true });
      expect(mocks.fs.unlinkSync).toHaveBeenCalledTimes(1);
      const calledPath = (mocks.fs.unlinkSync.mock.calls[0] as unknown as [string])[0];
      expect(calledPath).toMatch(/somefile\.txt$/);
      expect(mocks.fs.rmdirSync).not.toHaveBeenCalled();
    });

    it('returns the thrown error message in the envelope', async () => {
      mocks.fs.statSync.mockReturnValue({ isDirectory: () => true, isFile: () => false });
      mocks.fs.rmdirSync.mockImplementation(() => {
        throw new Error('Directory not empty');
      });
      const result = await invokeHandler('files:delete', {}, '/somedir');
      expect(result).toEqual({ success: false, error: 'Error: Directory not empty' });
    });
  });
});
