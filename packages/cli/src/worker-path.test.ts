import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveHostWorkerPath, workerEntryCandidates } from './worker-path.js';

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

const originalArgv = process.argv;

/** Pretend this process was launched from `entry`. */
function stubCliEntry(entry: string): void {
  process.argv = [originalArgv[0] ?? 'node', entry];
}

afterEach(() => {
  vi.unstubAllEnvs();
  fsMock.existsSync.mockReset();
  process.argv = originalArgv;
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
    stubCliEntry(path.join(path.resolve('nowhere', 'cli'), 'index.js'));
    const expected = path.join(process.cwd(), 'packages', 'host', 'bundle', 'worker-entry.js');
    fsMock.existsSync.mockImplementation((candidate) => String(candidate) === expected);

    expect(resolveHostWorkerPath()).toBe(expected);
  });

  it('leaves execution disabled when the Host bundle is absent', () => {
    vi.stubEnv('DUYA_HOST_WORKER_PATH', '');
    fsMock.existsSync.mockReturnValue(false);

    expect(resolveHostWorkerPath()).toBeUndefined();
  });

  it('finds the worker next to the CLI install, not only under the working directory', () => {
    vi.stubEnv('DUYA_HOST_WORKER_PATH', '');
    const installDir = path.resolve('opt', 'duya', 'packages', 'cli', 'bundle');
    stubCliEntry(path.join(installDir, 'cli.cjs'));
    const expected = path.resolve('opt', 'duya', 'packages', 'host', 'bundle', 'worker-entry.js');
    fsMock.existsSync.mockImplementation((candidate) => String(candidate) === expected);

    expect(resolveHostWorkerPath()).toBe(expected);
  });

  it('finds the worker in the packaged harness-bundle layout', () => {
    vi.stubEnv('DUYA_HOST_WORKER_PATH', '');
    const installDir = path.resolve('app', 'resources', 'cli-bundle');
    stubCliEntry(path.join(installDir, 'cli.cjs'));
    const expected = path.resolve('app', 'resources', 'harness-bundle', 'worker-entry.js');
    fsMock.existsSync.mockImplementation((candidate) => String(candidate) === expected);

    expect(resolveHostWorkerPath()).toBe(expected);
  });

  it('falls back to the working directory when the install location has no worker', () => {
    vi.stubEnv('DUYA_HOST_WORKER_PATH', '');
    stubCliEntry(path.join(path.resolve('nowhere', 'cli'), 'index.js'));
    const expected = path.join(process.cwd(), 'packages', 'host', 'bundle', 'worker-entry.js');
    fsMock.existsSync.mockImplementation((candidate) => String(candidate) === expected);

    expect(resolveHostWorkerPath()).toBe(expected);
  });
});

describe('workerEntryCandidates', () => {
  it('lists the checkout layout before the working directory', () => {
    stubCliEntry(path.join(path.resolve('opt', 'duya', 'packages', 'cli', 'dist'), 'index.js'));

    const candidates = workerEntryCandidates();

    expect(candidates[0]).toBe(path.resolve('opt', 'duya', 'packages', 'host', 'bundle', 'worker-entry.js'));
    expect(candidates).toContain(path.join(process.cwd(), 'packages', 'host', 'bundle', 'worker-entry.js'));
  });

  it('resolves every candidate to an absolute path', () => {
    stubCliEntry(path.join(path.resolve('opt', 'duya', 'packages', 'cli', 'dist'), 'index.js'));

    for (const candidate of workerEntryCandidates()) {
      expect(path.isAbsolute(candidate)).toBe(true);
    }
  });
});
