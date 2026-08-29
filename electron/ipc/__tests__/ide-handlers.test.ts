/**
 * ide-handlers.test.ts — Unit tests for external IDE detection and the
 * "open in IDE" IPC used by the file preview header.
 *
 * Covers the pure resolution logic (candidate paths, executable lookup,
 * default-IDE selection) and the `ide:open` launch path with mocked
 * `execFile` / `fs`. Detection is layered: candidate install dirs first,
 * then PATH CLI lookup.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';

const mocks = vi.hoisted(() => ({
  captured: {
    handle: new Map<string, (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>>(),
  },
  fs: {
    existsSync: vi.fn(() => false),
  },
  // Callback-style stub so promisify(execFile) resolves deterministically.
  stdout: '',
  execFile: vi.fn((_cmd: string, _args: string[], ...rest: unknown[]) => {
    const cb = (rest[rest.length - 1] as (err: Error | null, data: { stdout: string; stderr: string }) => void);
    cb(null, { stdout: mocks.stdout, stderr: '' });
  }),
  configStore: {
    getByPath: vi.fn(() => ''),
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (c: string, fn: (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>) => {
      mocks.captured.handle.set(c, fn);
    },
  },
}));

vi.mock('child_process', () => ({
  execFile: mocks.execFile,
}));

// Note: promisify wraps execFile in child_process; the mock above replaces
// the module, so promisify(execFile) resolves to the mocked fn.
vi.mock('../../config/store-instance', () => ({
  getConfigStore: () => mocks.configStore,
}));

vi.mock('fs', () => mocks.fs);

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = mocks.captured.handle.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return handler({}, ...args);
}

import {
  buildIdeCandidates,
  resolveIdeExecutable,
  resolveDefaultIde,
  detectInstalledIdes,
  openInIde,
  registerIdeHandlers,
  resolveIconTarget,
  canExtractIcon,
} from '../ide-handlers';

describe('ide-handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.captured.handle.clear();
    mocks.fs.existsSync.mockReturnValue(false);
    mocks.stdout = '';
    mocks.configStore.getByPath.mockReturnValue('');
  });

  describe('buildIdeCandidates', () => {
    it('builds Windows candidate paths under LOCALAPPDATA', () => {
      const old = process.env.LOCALAPPDATA;
      process.env.LOCALAPPDATA = 'C:\\Users\\duya\\AppData\\Local';
      try {
        const c = buildIdeCandidates('win32');
        expect(c.vscode).toContain(
          path.join('C:\\Users\\duya\\AppData\\Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
        );
        expect(c.cursor.length).toBeGreaterThan(0);
        expect(c.trae.length).toBeGreaterThan(0);
        expect(c.zed.length).toBeGreaterThan(0);
      } finally {
        if (old === undefined) delete process.env.LOCALAPPDATA;
        else process.env.LOCALAPPDATA = old;
      }
    });

    it('returns macOS app bundle paths', () => {
      const c = buildIdeCandidates('darwin');
      expect(c.vscode[0]).toContain('/Applications/Visual Studio Code.app');
      expect(c.zed[0]).toContain('/Applications/Zed.app');
    });
  });

  describe('resolveIdeExecutable', () => {
    it('returns an existing candidate install path', async () => {
      mocks.fs.existsSync.mockImplementation((p: string) => p.includes('Code.exe'));
      const exe = await resolveIdeExecutable('vscode', 'win32');
      expect(exe).toContain('Code.exe');
      expect(mocks.execFile).not.toHaveBeenCalled();
    });

    it('falls back to PATH CLI lookup when no candidate exists', async () => {
      mocks.stdout = 'C:\\bin\\trae.exe\n';
      const exe = await resolveIdeExecutable('trae', 'win32');
      expect(exe).toBe('C:\\bin\\trae.exe');
      expect(mocks.execFile).toHaveBeenCalledWith(
        'where.exe',
        ['trae'],
        { timeout: 3000 },
        expect.any(Function),
      );
    });

    it('returns null when neither path nor CLI resolves', async () => {
      const exe = await resolveIdeExecutable('zed', 'win32');
      expect(exe).toBeNull();
    });
  });

  describe('resolveDefaultIde', () => {
    const detected = [
      { id: 'vscode', name: 'Visual Studio Code', executable: 'C:/code.exe' },
      { id: 'cursor', name: 'Cursor', executable: 'C:/cursor.exe' },
    ];

    it('picks the configured default when detected', async () => {
      const d = await resolveDefaultIde(detected, 'cursor');
      expect(d?.id).toBe('cursor');
    });

    it('ignores a configured default that is not installed', async () => {
      const d = await resolveDefaultIde(detected, 'zed');
      expect(d?.id).toBe('vscode');
    });

    it('falls back to the first detected IDE', async () => {
      const d = await resolveDefaultIde(detected, '');
      expect(d?.id).toBe('vscode');
    });

    it('returns null when nothing is detected', async () => {
      const d = await resolveDefaultIde([], 'vscode');
      expect(d).toBeNull();
    });
  });

  describe('detectInstalledIdes', () => {
    it('returns only installed IDEs in canonical order', async () => {
      mocks.fs.existsSync.mockImplementation((p: string) => p.includes('Code.exe') || p.toLowerCase().includes('trae'));
      const list = await detectInstalledIdes('win32');
      const ids = list.map((i) => i.id);
      expect(ids).toContain('vscode');
      expect(ids).toContain('trae');
      expect(ids).not.toContain('cursor');
      // canonical order preserved
      expect(ids.indexOf('vscode')).toBeLessThan(ids.indexOf('trae'));
    });

    it('leaves icon undefined when shell-icon extraction is unavailable', async () => {
      // Every candidate "exists"; the electron mock exposes no `app`, so
      // extraction fails and falls back cleanly to undefined.
      mocks.fs.existsSync.mockImplementation(() => true);
      const list = await detectInstalledIdes('win32');
      expect(list[0]?.icon).toBeUndefined();
    });
  });

  describe('shell icon helpers', () => {
    it('resolveIconTarget returns the executable as-is off macOS', () => {
      expect(resolveIconTarget('C:\\bin\\Code.exe', 'win32')).toBe('C:\\bin\\Code.exe');
      expect(resolveIconTarget('/usr/bin/code', 'linux')).toBe('/usr/bin/code');
    });

    it('resolveIconTarget walks up to the .app bundle on macOS', () => {
      expect(
        resolveIconTarget('/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', 'darwin'),
      ).toBe('/Applications/Visual Studio Code.app');
      // No bundle in the path: returned unchanged.
      expect(resolveIconTarget('/usr/local/bin/zed', 'darwin')).toBe('/usr/local/bin/zed');
    });

    it('canExtractIcon only accepts real .exe targets on Windows', () => {
      expect(canExtractIcon('C:\\bin\\Code.exe', 'win32')).toBe(true);
      // CLI shims would render a generic script icon.
      expect(canExtractIcon('C:\\bin\\code.cmd', 'win32')).toBe(false);
    });

    it('canExtractIcon requires an .app bundle on macOS, anything on Linux', () => {
      expect(canExtractIcon('/Applications/Zed.app', 'darwin')).toBe(true);
      expect(canExtractIcon('/usr/bin/code', 'darwin')).toBe(false);
      expect(canExtractIcon('/usr/bin/code', 'linux')).toBe(true);
    });
  });

  describe('openInIde', () => {
    it('rejects unknown IDE ids', async () => {
      const result = await openInIde('wat' as never, 'C:/file.ts');
      expect(result).toContain('Unknown IDE');
    });

    it('rejects invalid / empty / null-byte paths', async () => {
      expect(await openInIde('vscode', '')).not.toBe('');
      expect(await openInIde('vscode', '\0bad')).not.toBe('');
    });

    it('launches the IDE executable with the target path', async () => {
      mocks.fs.existsSync.mockImplementation((p: string) => p.includes('Code.exe'));
      const result = await openInIde('vscode', 'C:/repo/src/main.ts');
      expect(result).toBe('');
      expect(mocks.execFile).toHaveBeenCalledWith(
        expect.stringContaining('Code.exe'),
        ['C:/repo/src/main.ts'],
        expect.any(Function),
      );
    });

    it('returns the error message when the launch fails', async () => {
      mocks.fs.existsSync.mockImplementation((p: string) => p.includes('Code.exe'));
      mocks.execFile.mockImplementation((_cmd: string, _args: string[], ...rest: unknown[]) => {
        const cb = (rest[rest.length - 1] as (err: Error | null, data: { stdout: string; stderr: string }) => void);
        cb(new Error('spawn ENOENT'), { stdout: '', stderr: '' });
      });
      const result = await openInIde('vscode', 'C:/repo/src/main.ts');
      expect(result).toContain('spawn ENOENT');
    });

    it('reports when the IDE is not installed', async () => {
      const result = await openInIde('zed', 'C:/repo/main.ts');
      expect(result).toContain('not installed');
    });
  });

  describe('registerIdeHandlers', () => {
    it('registers ide:list / ide:get-default / ide:open', () => {
      registerIdeHandlers();
      expect(mocks.captured.handle.has('ide:list')).toBe(true);
      expect(mocks.captured.handle.has('ide:get-default')).toBe(true);
      expect(mocks.captured.handle.has('ide:open')).toBe(true);
    });

    it('ide:get-default honors the configured default', async () => {
      registerIdeHandlers();
      mocks.configStore.getByPath.mockReturnValue('zed');
      mocks.fs.existsSync.mockImplementation((p: string) => p.includes('zed'));
      const d = (await invoke('ide:get-default')) as { id: string } | null;
      expect(d?.id).toBe('zed');
    });
  });
});