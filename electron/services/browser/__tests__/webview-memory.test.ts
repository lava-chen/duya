/**
 * Unit tests for the built-in browser memory manager (webview-memory.ts).
 *
 * `electron` is mocked with a session stub that records cache-clearing calls
 * and an `app.getAppMetrics()` stub keyed by pid, so we can assert:
 *   - `releaseBrowserMemory` clears caches but preserves cookies / localStorage
 *   - `checkWebviewMemory` reloads over-budget guests and leaves others alone
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const wcRegistry = new Map<number, unknown>();
  const metrics: Array<{ pid: number; memory: { workingSetSize: number } }> = [];
  const calls = {
    clearCache: 0,
    clearCodeCaches: 0,
    clearHostResolverCache: 0,
    clearAuthCache: 0,
    clearStorageData: undefined as unknown,
  };
  const sessionStub = {
    fromPartition: (_partition: string) => ({
      clearCache: async () => {
        calls.clearCache += 1;
      },
      clearCodeCaches: async () => {
        calls.clearCodeCaches += 1;
      },
      clearHostResolverCache: async () => {
        calls.clearHostResolverCache += 1;
      },
      clearAuthCache: async () => {
        calls.clearAuthCache += 1;
      },
      clearStorageData: async (opts: unknown) => {
        calls.clearStorageData = opts;
      },
    }),
  };
  return { wcRegistry, metrics, calls, sessionStub };
});

vi.mock('electron', () => ({
  webContents: { fromId: (id: number) => mocks.wcRegistry.get(id) },
  session: mocks.sessionStub,
  app: { getAppMetrics: () => mocks.metrics },
}));

// Resolved relative to THIS file: electron/services/browser/__tests__/ →
// electron/logging/logger (what ../webview-memory imports).
vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  LogComponent: { BrowserDaemon: 'BrowserDaemon' },
}));

import {
  releaseBrowserMemory,
  checkWebviewMemory,
  setWebviewIdProvider,
  getWebviewMemoryTotalMb,
} from '../webview-memory';

interface FakeWc {
  isDestroyed(): boolean;
  reload: ReturnType<typeof vi.fn>;
  getOSProcessId(): number;
}

/**
 * Register a guest whose renderer process `pid` reports `mb` MB. `mb: null`
 * registers no metric (the process cannot be found in getAppMetrics()).
 */
function putGuest(
  webContentsId: number,
  pid: number,
  mb: number | null,
  opts: { destroyed?: boolean } = {},
): FakeWc {
  const wc: FakeWc = {
    isDestroyed: () => opts.destroyed === true,
    reload: vi.fn(),
    getOSProcessId: () => pid,
  };
  mocks.wcRegistry.set(webContentsId, wc);
  if (mb !== null) mocks.metrics.push({ pid, memory: { workingSetSize: mb * 1024 } });
  return wc;
}

const ORIGINAL_BUDGET = process.env.DUYA_WEBVIEW_MEMORY_MB;

beforeEach(() => {
  mocks.wcRegistry.clear();
  mocks.metrics.length = 0;
  mocks.calls.clearCache = 0;
  mocks.calls.clearCodeCaches = 0;
  mocks.calls.clearHostResolverCache = 0;
  mocks.calls.clearAuthCache = 0;
  mocks.calls.clearStorageData = undefined;
  process.env.DUYA_WEBVIEW_MEMORY_MB = '100';
  setWebviewIdProvider(() => []);
});

afterEach(() => {
  if (ORIGINAL_BUDGET === undefined) delete process.env.DUYA_WEBVIEW_MEMORY_MB;
  else process.env.DUYA_WEBVIEW_MEMORY_MB = ORIGINAL_BUDGET;
  setWebviewIdProvider(null);
});

describe('releaseBrowserMemory', () => {
  it('clears caches but does NOT wipe cookies / localStorage / IndexedDB', async () => {
    await releaseBrowserMemory('test');

    expect(mocks.calls.clearCache).toBe(1);
    expect(mocks.calls.clearCodeCaches).toBe(1);
    expect(mocks.calls.clearHostResolverCache).toBe(1);
    expect(mocks.calls.clearAuthCache).toBe(1);

    const opts = mocks.calls.clearStorageData as { storages: string[] };
    expect(opts.storages).toEqual(
      expect.arrayContaining(['shadercache', 'cachestorage', 'serviceworkers']),
    );
    // The user's logins must survive a tab close.
    expect(opts.storages).not.toContain('cookies');
    expect(opts.storages).not.toContain('localstorage');
    expect(opts.storages).not.toContain('indexdb');
  });
});

describe('checkWebviewMemory', () => {
  it('reloads a guest over the budget and leaves an under-budget guest alone', async () => {
    const heavy = putGuest(1, 1001, 200);
    const light = putGuest(2, 1002, 50);
    setWebviewIdProvider(() => [
      { sessionId: 'heavy', webContentsId: 1 },
      { sessionId: 'light', webContentsId: 2 },
    ]);

    const samples = await checkWebviewMemory();

    expect(heavy.reload).toHaveBeenCalledTimes(1);
    expect(light.reload).not.toHaveBeenCalled();
    expect(samples).toEqual([
      { sessionId: 'heavy', webContentsId: 1, mb: 200, reloaded: true },
      { sessionId: 'light', webContentsId: 2, mb: 50, reloaded: false },
    ]);
  });

  it('returns null for a guest whose process is missing from getAppMetrics()', async () => {
    const ghost = putGuest(3, 1003, null);
    setWebviewIdProvider(() => [{ sessionId: 'ghost', webContentsId: 3 }]);

    const [sample] = await checkWebviewMemory();
    expect(sample.mb).toBeNull();
    expect(ghost.reload).not.toHaveBeenCalled();
  });

  it('ignores destroyed guests', async () => {
    const gone = putGuest(9, 1009, 9999, { destroyed: true });
    setWebviewIdProvider(() => [{ sessionId: 'gone', webContentsId: 9 }]);

    const [sample] = await checkWebviewMemory();
    expect(sample.mb).toBeNull();
    expect(gone.reload).not.toHaveBeenCalled();
  });

  it('sums live guest memory', async () => {
    putGuest(1, 2001, 100);
    putGuest(2, 2002, 250);
    setWebviewIdProvider(() => [
      { sessionId: 'a', webContentsId: 1 },
      { sessionId: 'b', webContentsId: 2 },
    ]);

    expect(await getWebviewMemoryTotalMb()).toBe(350);
  });
});
