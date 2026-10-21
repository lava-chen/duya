import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveHostWorkerPath } from './worker-path.js';

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn<(candidate: string) => boolean>(),
}));

/**
 * `node:fs` is MOCKED rather than spied on.
 *
 * `vi.spyOn(fs, 'existsSync')` cannot work on a Node builtin: the namespace
 * object of an ES module has non-configurable exports, so Vitest refuses the
 * spy with "Cannot spy on export existsSync". Mocking the module is also the
 * only way the replacement reaches the copy `worker-path.ts` itself imports —
 * a spy on the test's own binding would leave the production module reading
 * the real filesystem.
 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: fsMock.existsSync };
});

afterEach(() => {
  vi.unstubAllEnvs();
  fsMock.existsSync.mockReset();
});

describe('resolveHostWorkerPath', () => {
  it('uses the explicit Host worker path when configured', () => {
    vi.stubEnv('DUYA_HOST_WORKER_PATH', path.join('relative', 'worker.js'));
    fsMock.existsSync.mockReturnValue(true);

    expect(resolveHostWorkerPath()).toBe(path.resolve('relative', 'worker.js'));
    // The explicit path is taken on trust: the filesystem is never consulted.
    expect(fsMock.existsSync).not.toHaveBeenCalled();
  });

  it('discovers the Host bundle under the workspace packages directory', () => {
    vi.stubEnv('DUYA_HOST_WORKER_PATH', ' ');
    const expected = path.join(process.cwd(), 'packages', 'host', 'bundle', 'worker-entry.js');
    fsMock.existsSync.mockImplementation((candidate) => String(candidate) === expected);

    expect(resolveHostWorkerPath()).toBe(expected);
  });

  it('leaves execution disabled when the Host bundle is absent', () => {
    vi.stubEnv('DUYA_HOST_WORKER_PATH', '');
    fsMock.existsSync.mockReturnValue(false);

    expect(resolveHostWorkerPath()).toBeUndefined();
  });
});
