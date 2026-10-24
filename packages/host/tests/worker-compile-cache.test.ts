/**
 * The worker compile cache: the environment contract that lets a freshly
 * spawned worker skip recompiling its 4.6 MB bundle, and the flush that
 * puts that cache on disk before the worker is killed.
 *
 * ## Why this file exists
 *
 * The mechanism is an environment variable, so nothing fails loudly when it
 * is missing -- the worker just compiles the bundle from source again on
 * every spawn (~68 ms of V8 compile time each time). A missing
 * `NODE_COMPILE_CACHE` is therefore invisible in a log and invisible in a
 * test that only checks "the worker started".
 *
 * The flush matters even more. Node writes the compile cache to disk only
 * when a process exits CLEANLY, and the Host KILLS its workers, so a cache
 * that is never flushed leaves an EMPTY cache directory behind: every spawn
 * pays the compile and then throws the entry away. That is slower than
 * having no cache at all, and nothing in a log says so.
 *
 * These assertions pin the INVARIANTS that make the optimization real:
 * every worker environment carries a cache directory, the directory is
 * stable across calls (so a second spawn hits the first spawn's cache),
 * an operator's explicit setting is never overridden, and the flush puts
 * the cache on disk while the process is alive.
 *
 * ## What it does NOT claim
 *
 * It does not measure the speedup. The speedup depends on V8, on the
 * machine, and on whether the bundle changed since the last spawn; a
 * timing assertion would test the machine, not the code.
 */
import { afterEach, describe, expect, it } from 'vitest';
import nodeModule from 'node:module';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createWorkerEnvironment,
  flushWorkerCompileCache,
  resolveWorkerCompileCacheDir,
} from '../src/worker-limits.js';

const ORIGINAL_CACHE_DIR = process.env.NODE_COMPILE_CACHE;
const ORIGINAL_DISABLE_FLAG = process.env.NODE_DISABLE_COMPILE_CACHE;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/**
 * Swap the runtime's flush for a stand-in, and hand back the restore.
 *
 * The runtime's `flushCompileCache` is an ordinary writable property of the
 * `node:module` exports object, so it can be replaced and restored without
 * a mocking framework -- and the real one is always put back, so the test
 * that writes to disk still exercises the real code path.
 */
function replaceFlushApi(replacement: unknown): () => void {
  const target = nodeModule as unknown as Record<string, unknown>;
  const original = Object.getOwnPropertyDescriptor(target, 'flushCompileCache');
  Object.defineProperty(target, 'flushCompileCache', {
    value: replacement,
    configurable: true,
    writable: true,
  });
  return () => {
    if (original) Object.defineProperty(target, 'flushCompileCache', original);
    else delete target.flushCompileCache;
  };
}

afterEach(() => {
  restoreEnv('NODE_COMPILE_CACHE', ORIGINAL_CACHE_DIR);
  restoreEnv('NODE_DISABLE_COMPILE_CACHE', ORIGINAL_DISABLE_FLAG);
});

describe('the worker compile cache environment', () => {
  it('gives every worker a compile cache directory', () => {
    delete process.env.NODE_COMPILE_CACHE;

    const env = createWorkerEnvironment('session-1', 2048, '/tmp/better-sqlite3');

    // The variable is what reaches a fresh process: `enableCompileCache()`
    // exports nothing to a child, and a forked child is a brand new Node
    // process. Without this the worker recompiles its bundle every spawn.
    expect(env.NODE_COMPILE_CACHE).toBe(resolveWorkerCompileCacheDir());
  });

  it('keeps the cache directory stable so a later spawn hits an earlier cache', () => {
    delete process.env.NODE_COMPILE_CACHE;

    const first = createWorkerEnvironment('session-1', 2048, '/tmp/better-sqlite3');
    const second = createWorkerEnvironment('session-2', 2048, '/tmp/better-sqlite3');

    // A different directory per spawn would mean a cold cache per spawn,
    // which is exactly the cost this removes.
    expect(second.NODE_COMPILE_CACHE).toBe(first.NODE_COMPILE_CACHE);
  });

  it('resolves the cache directory under the data root', () => {
    delete process.env.NODE_COMPILE_CACHE;

    const dir = resolveWorkerCompileCacheDir();

    // Node's own guidance is to keep the cache under os.tmpdir() so a
    // stale cache cannot fill the disk, but a temp directory is also
    // cleared by the OS -- which would cost the user this saving again
    // every morning. The data root is where the worker already writes
    // its logs.
    expect(dir).toContain(`${'cache'}\\${'node-compile'}`);
    expect(dir).not.toContain('node_modules');
  });

  it('respects an explicit cache directory instead of overriding it', () => {
    process.env.NODE_COMPILE_CACHE = '/explicit/cache/dir';

    const env = createWorkerEnvironment('session-1', 2048, '/tmp/better-sqlite3');

    // An operator who pointed the cache elsewhere -- or turned it off
    // with NODE_DISABLE_COMPILE_CACHE -- keeps their choice.
    expect(env.NODE_COMPILE_CACHE).toBe('/explicit/cache/dir');
  });

  it('leaves the rest of the worker environment intact', () => {
    delete process.env.NODE_COMPILE_CACHE;

    const env = createWorkerEnvironment('session-7', 1024, '/tmp/better-sqlite3');

    // The cache is an addition, not a replacement: the session id, the
    // agent mode and the heap ceiling are what make the worker a worker.
    expect(env.SESSION_ID).toBe('session-7');
    expect(env.DUYA_AGENT_MODE).toBe('true');
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=1024');
  });
});

describe('the worker compile cache flush', () => {
  it('asks the runtime to write the cache out while the worker is alive', () => {
    let calls = 0;
    const restore = replaceFlushApi(() => { calls += 1; });
    try {
      flushWorkerCompileCache();
    } finally {
      restore();
    }

    // The worker is killed, never exited cleanly, so the flush is the only
    // thing that can put the cache on disk.
    expect(calls).toBe(1);
  });

  it('does not touch the cache when the operator disabled it', () => {
    process.env.NODE_DISABLE_COMPILE_CACHE = '1';
    let calls = 0;
    const restore = replaceFlushApi(() => { calls += 1; });
    try {
      flushWorkerCompileCache();
    } finally {
      restore();
    }

    // `NODE_DISABLE_COMPILE_CACHE=1` is the documented off switch, and it
    // has to win over the environment variable that turns the cache on.
    expect(calls).toBe(0);
  });

  it('never fails the worker when the flush itself fails', () => {
    const restore = replaceFlushApi(() => { throw new Error('cache write failed'); });
    try {
      expect(() => flushWorkerCompileCache()).not.toThrow();
    } finally {
      restore();
    }

    // The compile cache is an optimisation. A worker that dies because its
    // cache could not be written would be a far worse outcome than a worker
    // that compiles the bundle again.
  });

  it('writes the cache to disk while the process is still alive', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'duya-compile-cache-'));
    try {
      const runtime = nodeModule as unknown as {
        enableCompileCache?: (cacheDir?: string) => { status: number };
        getCompileCacheDir?: () => string | undefined;
      };
      expect(typeof runtime.enableCompileCache, 'this runtime has no compile cache')
        .toBe('function');

      const enabled = runtime.enableCompileCache!.call(nodeModule, dir);
      // Status 3 is DISABLED: the cache cannot be turned on here, so there
      // is nothing to flush and nothing to assert.
      if (enabled.status === 3) return;

      const modulePath = join(dir, 'cached-module.cjs');
      await writeFile(
        modulePath,
        `module.exports = { value: ${Array.from({ length: 400 }, (_, i) => i).join(' + ')} };\n`,
        'utf8',
      );
      createRequire(import.meta.url)(modulePath);

      const cacheDir = runtime.getCompileCacheDir?.();
      expect(cacheDir, 'the compile cache is not enabled').toBeTruthy();

      const filesIn = async (root: string): Promise<number> => {
        const entries = await readdir(root, { recursive: true, withFileTypes: true });
        return entries.filter((entry) => entry.isFile()).length;
      };
      expect(await filesIn(cacheDir!), 'nothing is written before the flush').toBe(0);

      flushWorkerCompileCache();

      // This is the invariant the whole optimization rests on: the entry is
      // on disk NOW, not whenever the process happens to exit.
      expect(await filesIn(cacheDir!)).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
