import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * extension-installer.test.ts
 *
 * Unit tests for `electron/services/browser/extension-installer.ts`.
 *
 * Mocking strategy: the service exposes three registry helpers as
 * `export let` bindings and a `__extensionInstallerTestHooks` symbol
 * that lets the test file swap them out for mocks at runtime. This
 * avoids the vitest limitation that `vi.mock` cannot reach into a
 * module's internal lexical bindings (so `vi.mock('../extension-installer',
 * ...)` would not intercept the service's internal calls).
 *
 * The test-only hooks are prefixed with `__` to make accidental
 * production use obvious, and `tsc` is configured to skip them via
 * `noUnusedLocals`-equivalent behavior — production callers simply
 * don't import the symbol.
 *
 * @see docs/exec-plans/active/532-one-click-extension-install.md
 */

const mocks = vi.hoisted(() => {
  return {
    appIsPackaged: { value: false as boolean },
    appGetAppPath: { value: '' },
    readFileImpl: null as ((p: string) => Promise<string>) | null,
    statImpl: null as ((p: string) => Promise<{ isDirectory: () => boolean }>) | null,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    regQueryValue: vi.fn(),
    regAddValue: vi.fn(),
    regDeleteKey: vi.fn(),
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: ((p: Parameters<typeof actual.promises.readFile>[0], options?: Parameters<typeof actual.promises.readFile>[1]) => {
        if (mocks.readFileImpl) {
          // Our mock only handles the (path, encoding) form. Force
          // string encoding so the result type matches the real impl
          // when the production code asks for utf8.
          return mocks.readFileImpl(String(p));
        }
        return actual.promises.readFile(p, options);
      }) as typeof actual.promises.readFile,
      stat: ((p: Parameters<typeof actual.promises.stat>[0]) => {
        if (mocks.statImpl) return mocks.statImpl(String(p));
        return actual.promises.stat(p);
      }) as typeof actual.promises.stat,
    },
  };
});

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mocks.appIsPackaged.value;
    },
    getAppPath: () => mocks.appGetAppPath.value,
  },
}));

vi.mock('../../logging/logger', () => ({
  initLogger: () => mocks.logger,
  getLogger: () => mocks.logger,
  LogComponent: {
    BrowserDaemon: 'BrowserDaemon',
  },
}));

import {
  detectLocalExtension,
  DUYA_BRIDGE_EXTENSION_ID,
  installLocalExtension,
  __extensionInstallerTestHooks,
  resolveExtensionInstallDir,
  uninstallLocalExtension,
} from '../extension-installer';

const ORIGINAL_PLATFORM = process.platform;

function setWin32(): void {
  Object.defineProperty(process, 'platform', {
    value: 'win32',
    configurable: true,
  });
}

function setNonWindows(): void {
  Object.defineProperty(process, 'platform', {
    value: 'linux',
    configurable: true,
  });
}

beforeEach(() => {
  // Sensible defaults: nothing installed, all writes succeed, deletes
  // return false. Tests override per-case with `mockResolvedValueOnce` or
  // `mockImplementation` against the spy mocks below.
  mocks.regQueryValue.mockReset();
  mocks.regAddValue.mockReset();
  mocks.regDeleteKey.mockReset();
  mocks.regQueryValue.mockResolvedValue(null);
  mocks.regAddValue.mockResolvedValue(undefined);
  mocks.regDeleteKey.mockResolvedValue(false);

  __extensionInstallerTestHooks.setRegFakes({
    regQueryValue: mocks.regQueryValue,
    regAddValue: mocks.regAddValue,
    regDeleteKey: mocks.regDeleteKey,
  });

  mocks.logger.info.mockReset();
  mocks.logger.warn.mockReset();
  mocks.appIsPackaged.value = false;
  mocks.appGetAppPath.value = '';
  mocks.readFileImpl = null;
  mocks.statImpl = null;
  setWin32();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', {
    value: ORIGINAL_PLATFORM,
    configurable: true,
  });
  __extensionInstallerTestHooks.resetRegFakes();
});

describe('resolveExtensionInstallDir', () => {
  it('returns dev path when not packaged', () => {
    mocks.appIsPackaged.value = false;
    mocks.appGetAppPath.value = '/repo/duya';
    // path.join on Windows uses backslashes; assert on the suffix
    // rather than the exact separator so the test is portable.
    expect(resolveExtensionInstallDir()).toMatch(/[/\\]extension$/);
  });

  it('returns packaged path relative to process.execPath when packaged', () => {
    mocks.appIsPackaged.value = true;
    const originalExec = process.execPath;
    Object.defineProperty(process, 'execPath', {
      value: 'C:\\Program Files\\DUYA\\DUYA.exe',
      configurable: true,
    });
    try {
      expect(resolveExtensionInstallDir()).toBe(
        'C:\\Program Files\\DUYA\\resources\\extension',
      );
    } finally {
      Object.defineProperty(process, 'execPath', {
        value: originalExec,
        configurable: true,
      });
    }
  });
});

describe('detectLocalExtension (Windows)', () => {
  it('returns unsupported when manifest.json is missing', async () => {
    mocks.appGetAppPath.value = '/repo';
    mocks.statImpl = async () => {
      throw new Error('ENOENT');
    };
    const result = await detectLocalExtension();
    expect(result.state).toBe('unsupported');
    expect(result.expectedVersion).toBe('');
    expect(result.installedVersion).toBeNull();
  });

  it('returns not-installed when no registry key exists', async () => {
    mocks.appGetAppPath.value = '/repo';
    mocks.statImpl = async () => ({ isDirectory: () => true });
    mocks.readFileImpl = async () => JSON.stringify({ version: '1.5.1' });
    mocks.regQueryValue.mockResolvedValue(null);

    const result = await detectLocalExtension();

    expect(result.state).toBe('not-installed');
    expect(result.expectedVersion).toBe('1.5.1');
    expect(result.installedVersion).toBeNull();
    expect(result.installedIn).toEqual([]);
    expect(mocks.regQueryValue).toHaveBeenCalled();
  });

  it('returns installed-current when registered version matches bundled version', async () => {
    mocks.appGetAppPath.value = '/repo';
    mocks.statImpl = async () => ({ isDirectory: () => true });
    mocks.readFileImpl = async () => JSON.stringify({ version: '1.5.1' });

    mocks.regQueryValue.mockImplementation(
      async (_root: string, valueName: 'path' | 'version') => {
        if (valueName === 'path') {
          return 'C:\\Program Files\\DUYA\\resources\\extension';
        }
        return '1.5.1';
      },
    );

    const result = await detectLocalExtension();
    expect(result.state).toBe('installed-current');
    expect(result.expectedVersion).toBe('1.5.1');
    expect(result.installedVersion).toBe('1.5.1');
    expect(result.installedIn).toContain('chrome');
  });

  it('returns installed-outdated when registered version is older than bundled', async () => {
    mocks.appGetAppPath.value = '/repo';
    mocks.statImpl = async () => ({ isDirectory: () => true });
    mocks.readFileImpl = async () => JSON.stringify({ version: '1.5.2' });

    mocks.regQueryValue.mockImplementation(
      async (_root: string, valueName: 'path' | 'version') => {
        if (valueName === 'path') return 'C:\\old\\path';
        return '1.5.1';
      },
    );

    const result = await detectLocalExtension();
    expect(result.state).toBe('installed-outdated');
    expect(result.expectedVersion).toBe('1.5.2');
    expect(result.installedVersion).toBe('1.5.1');
  });
});

describe('detectLocalExtension (non-Windows)', () => {
  it('returns unsupported on linux/macOS', async () => {
    setNonWindows();
    const result = await detectLocalExtension();
    expect(result.state).toBe('unsupported');
  });
});

describe('installLocalExtension', () => {
  it('writes registry entries for each target browser on Windows', async () => {
    mocks.appGetAppPath.value = '/repo';
    mocks.statImpl = async () => ({ isDirectory: () => true });
    mocks.readFileImpl = async () => JSON.stringify({ version: '1.5.1' });
    mocks.regAddValue.mockResolvedValue(undefined);

    const result = await installLocalExtension();

    expect(result.ok).toBe(true);
    expect(result.expectedVersion).toBe('1.5.1');
    expect(result.registryKeysWritten.length).toBeGreaterThan(0);
    expect(result.registryKeysWritten[0]).toContain(DUYA_BRIDGE_EXTENSION_ID);

    expect(mocks.regAddValue).toHaveBeenCalledWith(
      expect.stringContaining('Chrome'),
      'path',
      expect.any(String),
    );
    expect(mocks.regAddValue).toHaveBeenCalledWith(
      expect.stringContaining('Chrome'),
      'version',
      '1.5.1',
    );
  });

  it('returns ok=false when the extension folder is missing', async () => {
    mocks.appGetAppPath.value = '/repo';
    mocks.statImpl = async () => {
      throw new Error('ENOENT');
    };

    const result = await installLocalExtension();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
    expect(mocks.regAddValue).not.toHaveBeenCalled();
  });

  it('returns ok=false when manifest.json cannot be parsed', async () => {
    mocks.appGetAppPath.value = '/repo';
    mocks.statImpl = async () => ({ isDirectory: () => true });
    mocks.readFileImpl = async () => 'not-json';

    const result = await installLocalExtension();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('manifest.json');
  });

  it('returns ok=false when every regAddValue call fails', async () => {
    mocks.appGetAppPath.value = '/repo';
    mocks.statImpl = async () => ({ isDirectory: () => true });
    mocks.readFileImpl = async () => JSON.stringify({ version: '1.5.1' });
    mocks.regAddValue.mockRejectedValue(new Error('Access is denied.'));

    const result = await installLocalExtension();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('All registry writes failed');
  });

  it('returns unsupported error on non-Windows platforms', async () => {
    setNonWindows();
    const result = await installLocalExtension();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('only supported on Windows');
  });
});

describe('uninstallLocalExtension', () => {
  it('returns the keys it actually removed', async () => {
    mocks.regDeleteKey.mockResolvedValueOnce(true);
    mocks.regDeleteKey.mockResolvedValueOnce(false);

    const result = await uninstallLocalExtension();
    expect(result.ok).toBe(true);
    expect(result.registryKeysRemoved.length).toBe(1);
    expect(result.registryKeysRemoved[0]).toContain('Google\\Chrome');
  });
});
